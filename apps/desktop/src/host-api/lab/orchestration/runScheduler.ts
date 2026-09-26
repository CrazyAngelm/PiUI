import type { LabEventBus } from '../labBus';
import {
  ORCHESTRATION_EVENT_V6,
  type AgentProfile, type OrchestrationHostErrorCode, type OrchestrationRunChangedEventV6, type PipelineStep,
} from '../labContracts';
import { orchestrationFailure } from '../labErrors';
import { labUuid } from '../labRandom';
import { newQueue, type LabSessionRecord } from '../labState';
import { sha256Hex } from '../sha256';
import type { LabSessions, TurnOutcome } from '../sessionRuntime';
import { oneShotTurn, taskTurn, type TurnStep } from '../turnScripts';
import {
  executorKind, failureWithDetail, LLM_READ_ONLY_UNSUPPORTED, SCRIPT_FAILURE_CODES, scriptStdinDocument,
} from '../../stepExecutors';
import { claudeSignInRequired } from '../catalogFake';
import { HARNESS_SIGN_IN_REQUIRED, launchPolicyIssue, oneShotPolicyIssue } from './definitionRules';
import {
  advanceProgramRouters, cancelRun, cancelTask, completeScript, completeTask, CoordinatorFault, dispatchTask, leaseTask,
  markUncertain, profileForStep, readyTaskIds, rejectReadyTask, runningExecutions, stepOf, taskOf, type Completion,
  type LabRun, type ScriptCompletion,
} from './runEngine';
import { nativeDependencyText, taskPrompt, taskResultText } from './taskContent';

/** Delay between a recorded completion and the next scheduling pass. */
const RESCHEDULE_MS = 300;
/** How long a fake script "runs" before it prints its result. */
const SCRIPT_RUN_MS = 400;

/**
 * Deterministic stand-in for a host-run script (v6.2): it never evaluates the
 * source. It prints a JSON summary of its stdin, unless the source contains a
 * lab marker: `lab:text` prints plain text, `lab:fail` exits 1 with a stderr
 * line, `lab:timeout` never ends and reaches its timeout.
 */
function fakeScriptOutcome(step: PipelineStep, stdin: ReturnType<typeof scriptStdinDocument>): ScriptCompletion | 'timeout' {
  const source = step.executor?.type === 'script' ? step.executor.source : '';
  if (source.includes('lab:timeout')) return 'timeout';
  if (source.includes('lab:fail')) {
    return { status: 'failed', failure: failureWithDetail(SCRIPT_FAILURE_CODES.failed, 'Error: the check failed (lab:fail)') };
  }
  const dependencies = Object.keys(stdin.dependencies);
  const characters = dependencies.reduce((total, id) => {
    const value = stdin.dependencies[id];
    return total + (value?.text ?? JSON.stringify(value?.data ?? '')).length;
  }, 0);
  if (source.includes('lab:text')) {
    return { status: 'exited', stdout: `${stdin.step.name}: ${dependencies.length} dependencies, ${characters} characters\n` };
  }
  return {
    status: 'exited',
    stdout: `${JSON.stringify({ step: stdin.step.id, inputs: Object.keys(stdin.inputs), dependencies, characters })}\n`,
  };
}

/**
 * The lab counterpart of `OrchestrationScheduler`: leases ready tasks, binds
 * each native one to a new linked workspace session whose simulated turn
 * produces the result, runs script steps as deterministic host work,
 * records terminal outcomes and emits `runChanged` after every commit.
 */
export class LabRunScheduler {
  private readonly cancelling = new Set<string>();
  /** Running fake scripts by execution id: cancelling one clears its timer. */
  private readonly scripts = new Map<string, () => void>();

  constructor(private readonly runtime: LabSessions, private readonly bus: LabEventBus) {}

  findRun(workspaceId: string, runId: string): LabRun | undefined {
    return this.runtime.state.orchestration.get(workspaceId)?.runs.find((run) => run.id === runId);
  }

  /** Observes every committed run change, like the host's commit watch (event automations, v7.2). */
  onRunChanged: ((workspaceId: string, run: LabRun) => void) | undefined;

  emit(workspaceId: string, run: LabRun): void {
    const event: OrchestrationRunChangedEventV6 = { protocol: 6, type: 'runChanged', workspaceId, runId: run.id, revision: run.revision };
    this.bus.emit(ORCHESTRATION_EVENT_V6, event);
    this.onRunChanged?.(workspaceId, run);
  }

  /** `schedule_run`: launches every ready step now; returns the admission error, if any. */
  schedule(workspaceId: string, run: LabRun): OrchestrationHostErrorCode | undefined {
    if (!this.admits(workspaceId)) return 'runtime-unavailable';
    for (;;) {
      if (advanceProgramRouters(run)) this.emit(workspaceId, run);
      const [stepId] = readyTaskIds(run);
      if (stepId === undefined) return undefined;
      const step = stepOf(run, stepId);
      if (step === undefined) return 'conflict';
      const attempt = run.attempts.filter((item) => item.stepId === stepId).length;
      const executionId = labUuid(`${run.id}:${stepId}:${attempt}`);
      if (executorKind(step) === 'script') {
        const issue = this.admitScript(workspaceId, run, step, executionId);
        if (issue !== undefined) return issue;
        continue;
      }
      const profile = profileForStep(run, step);
      if (profile === undefined) return 'conflict';
      const summary = this.runtime.state.harnesses.find((harness) => harness.kind === profile.harness);
      const issue = executorKind(step) === 'llm' ? oneShotPolicyIssue(profile, summary) : launchPolicyIssue(profile, summary);
      if (issue !== undefined) {
        rejectReadyTask(run, stepId, issue);
        this.emit(workspaceId, run);
        // The failure record keeps the step code; the command keeps its contract.
        return issue === LLM_READ_ONLY_UNSUPPORTED ? 'unsupported-policy' : issue;
      }
      // `launch_lease`: Claude Code refuses a login that is not the user's
      // subscription at its start handshake, before any task text is written:
      // a certain, typed failure. The same step starts once the user signed in.
      if (profile.harness === 'claude-code' && claudeSignInRequired(this.runtime.state.harnesses)) {
        rejectReadyTask(run, stepId, HARNESS_SIGN_IN_REQUIRED);
        this.emit(workspaceId, run);
        return 'runtime-unavailable';
      }
      leaseTask(run, stepId, executionId);
      this.emit(workspaceId, run);
      this.launch(workspaceId, run, step, profile, executionId);
    }
  }

  /** Attaches a seeded running task to its (already created) linked session. */
  resumeSeeded(workspaceId: string, run: LabRun, stepId: string, steps: readonly TurnStep[], start: boolean): void {
    const sessionId = taskOf(run, stepId)?.execution?.id;
    const record = sessionId === undefined ? undefined : this.runtime.record(sessionId);
    if (record === undefined || sessionId === undefined) return;
    this.runtime.startTurn(record, steps, { start, onEnd: (outcome) => this.finished(workspaceId, run.id, stepId, sessionId, outcome) });
  }

  cancel(workspaceId: string, run: LabRun, expectedRevision: number, stepId?: string): void {
    if (!this.admits(workspaceId)) throw orchestrationFailure('runtime-unavailable');
    let executions: string[];
    try {
      executions = runningExecutions(run, expectedRevision, stepId);
    } catch {
      throw orchestrationFailure('conflict');
    }
    const key = `${workspaceId}\u0000${run.id}`;
    this.cancelling.add(key);
    try {
      for (const id of executions) {
        // A script's tree ends with its timer; a native turn is interrupted.
        const stopScript = this.scripts.get(id);
        if (stopScript !== undefined) {
          stopScript();
          continue;
        }
        const record = this.runtime.record(id);
        if (record?.live !== undefined) this.runtime.interrupt(record);
      }
      if (stepId === undefined) cancelRun(run);
      else cancelTask(run, stepId);
    } catch (error) {
      if (error instanceof CoordinatorFault) throw orchestrationFailure('conflict');
      throw error;
    } finally {
      this.cancelling.delete(key);
    }
    this.emit(workspaceId, run);
  }

  /** `authorize_live_workspace`: runtime work needs a trusted, present project outside safe mode. */
  admits(workspaceId: string): boolean {
    const { state } = this.runtime;
    const project = state.projects.find((candidate) => candidate.id === workspaceId);
    return !state.safeMode && project !== undefined && project.trustState === 'trusted' && !project.missing;
  }

  /**
   * `admit_script` + `prepare_script`: a missing interpreter is a certain
   * failure before any lease; otherwise the step is leased, marked running
   * and its fake process started. Returns the admission error, if any.
   */
  private admitScript(workspaceId: string, run: LabRun, step: PipelineStep, executionId: string): OrchestrationHostErrorCode | undefined {
    if (step.executor?.type !== 'script') return 'conflict';
    if ((this.runtime.state.missingScriptRuntimes ?? []).includes(step.executor.runtime)) {
      rejectReadyTask(run, step.id, SCRIPT_FAILURE_CODES.runtimeUnavailable);
      this.emit(workspaceId, run);
      return 'runtime-unavailable';
    }
    leaseTask(run, step.id, executionId);
    this.emit(workspaceId, run);
    const stdin = scriptStdinDocument(run, step, (id) => nativeDependencyText(this.runtime.state.sessions, run, id));
    dispatchTask(run, step.id, executionId);
    this.emit(workspaceId, run);
    const outcome = fakeScriptOutcome(step, stdin);
    const delay = outcome === 'timeout' ? step.executor.timeoutSeconds * 1_000 : SCRIPT_RUN_MS;
    let stopped = false;
    this.scripts.set(executionId, () => {
      stopped = true;
      this.scripts.delete(executionId);
    });
    this.runtime.clock.after(delay, () => {
      if (stopped) return;
      this.scripts.delete(executionId);
      const completion: ScriptCompletion = outcome === 'timeout'
        ? { status: 'failed', failure: failureWithDetail(SCRIPT_FAILURE_CODES.timeout, 'still waiting (lab:timeout)') }
        : outcome;
      this.scriptFinished(workspaceId, run.id, step.id, executionId, completion);
    });
    return undefined;
  }

  private scriptFinished(workspaceId: string, runId: string, stepId: string, executionId: string, completion: ScriptCompletion): void {
    if (this.cancelling.has(`${workspaceId}\u0000${runId}`)) return;
    const run = this.findRun(workspaceId, runId);
    const task = run === undefined ? undefined : taskOf(run, stepId);
    if (run === undefined || task?.status !== 'running' || task.execution?.id !== executionId) return;
    completeScript(run, stepId, executionId, completion);
    this.emit(workspaceId, run);
    this.reschedule(workspaceId, runId);
  }

  private reschedule(workspaceId: string, runId: string): void {
    this.runtime.clock.after(RESCHEDULE_MS, () => {
      const current = this.findRun(workspaceId, runId);
      if (current?.status === 'running' && !current.paused) this.schedule(workspaceId, current);
    });
  }

  private launch(workspaceId: string, run: LabRun, step: PipelineStep, profile: AgentProfile, sessionId: string): void {
    const { runtime } = this;
    const record: LabSessionRecord = {
      id: sessionId,
      workspaceId,
      harness: profile.harness,
      title: `${profile.name} - ${step.id}`,
      updatedAt: runtime.clock.iso(),
      model: { id: profile.model, ...(profile.modelProvider ? { provider: profile.modelProvider } : {}), name: profile.model },
      ...(profile.reasoning ? { thinkingLevel: profile.reasoning } : {}),
      ...(profile.serviceTier === 'standard' || profile.serviceTier === 'fast' ? { serviceTier: profile.serviceTier } : {}),
      permissionMode: profile.permissionMode,
      profileId: profile.id,
      runId: run.id,
      memberId: step.assignedMemberId,
      revision: 0,
      blocks: [],
      usage: [],
      composer: newQueue(),
      turnSerial: 0,
    };
    runtime.state.sessions.set(sessionId, record);
    runtime.open(record);
    runtime.publishSession(record);
    dispatchTask(run, step.id, sessionId);
    this.emit(workspaceId, run);
    const prompt = taskPrompt(runtime.state.sessions, run, step);
    // A single model call answers without tool work (the adapter's empty allowlist).
    const turn = executorKind(step) === 'llm' ? oneShotTurn : taskTurn;
    const steps = turn(runtime.nextContext(record), prompt, taskResultText(run, step));
    runtime.startTurn(record, steps, { onEnd: (outcome) => this.finished(workspaceId, run.id, step.id, sessionId, outcome) });
  }

  /** `watch_execution`: turns the native terminal outcome into a checked completion. */
  private finished(workspaceId: string, runId: string, stepId: string, sessionId: string, outcome: TurnOutcome): void {
    if (this.cancelling.has(`${workspaceId}\u0000${runId}`)) return;
    const run = this.findRun(workspaceId, runId);
    const task = run === undefined ? undefined : taskOf(run, stepId);
    if (run === undefined || task?.status !== 'running' || task.execution?.id !== sessionId) return;
    const answer = [...(this.runtime.record(sessionId)?.blocks ?? [])].reverse()
      .find((block) => block.kind === 'assistant' && block.text !== undefined);
    if (outcome === 'lost' || (outcome === 'succeeded' && answer?.text === undefined)) {
      // No terminal evidence: never replay, never infer success.
      if (markUncertain(run, stepId, sessionId)) this.emit(workspaceId, run);
      return;
    }
    const completion: Completion = outcome === 'succeeded' && answer?.text !== undefined
      ? { status: 'succeeded', text: answer.text, reference: { sessionId, blockId: answer.id, contentHash: sha256Hex(answer.text) } }
      : { status: 'failed', code: outcome === 'interrupted' ? 'native-turn-interrupted' : 'native-turn-failed' };
    completeTask(run, stepId, sessionId, completion);
    this.emit(workspaceId, run);
    this.reschedule(workspaceId, runId);
  }
}
