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
import { taskTurn, type TurnStep } from '../turnScripts';
import { launchPolicyIssue } from './definitionRules';
import {
  advanceProgramRouters, cancelRun, cancelTask, completeTask, CoordinatorFault, dispatchTask, leaseTask, markUncertain,
  profileForStep, readyTaskIds, rejectReadyTask, runningExecutions, stepOf, taskOf, type Completion, type LabRun,
} from './runEngine';
import { taskPrompt, taskResultText } from './taskContent';

/** Delay between a recorded completion and the next scheduling pass. */
const RESCHEDULE_MS = 300;

/**
 * The lab counterpart of `OrchestrationScheduler`: leases ready tasks, binds
 * each to a new linked workspace session whose simulated turn produces the
 * result, records terminal outcomes and emits `runChanged` after every commit.
 */
export class LabRunScheduler {
  private readonly cancelling = new Set<string>();

  constructor(private readonly runtime: LabSessions, private readonly bus: LabEventBus) {}

  findRun(workspaceId: string, runId: string): LabRun | undefined {
    return this.runtime.state.orchestration.get(workspaceId)?.runs.find((run) => run.id === runId);
  }

  emit(workspaceId: string, run: LabRun): void {
    const event: OrchestrationRunChangedEventV6 = { protocol: 6, type: 'runChanged', workspaceId, runId: run.id, revision: run.revision };
    this.bus.emit(ORCHESTRATION_EVENT_V6, event);
  }

  /** `schedule_run`: launches every ready step now; returns the admission error, if any. */
  schedule(workspaceId: string, run: LabRun): OrchestrationHostErrorCode | undefined {
    if (!this.admits(workspaceId)) return 'runtime-unavailable';
    for (;;) {
      if (advanceProgramRouters(run)) this.emit(workspaceId, run);
      const [stepId] = readyTaskIds(run);
      if (stepId === undefined) return undefined;
      const step = stepOf(run, stepId);
      const profile = step === undefined ? undefined : profileForStep(run, step);
      if (step === undefined || profile === undefined) return 'conflict';
      const summary = this.runtime.state.harnesses.find((harness) => harness.kind === profile.harness);
      const issue = launchPolicyIssue(profile, summary);
      if (issue !== undefined) {
        rejectReadyTask(run, stepId, issue);
        this.emit(workspaceId, run);
        return issue;
      }
      const attempt = run.attempts.filter((item) => item.stepId === stepId).length;
      const sessionId = labUuid(`${run.id}:${stepId}:${attempt}`);
      leaseTask(run, stepId, sessionId);
      this.emit(workspaceId, run);
      this.launch(workspaceId, run, step, profile, sessionId);
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
    const steps = taskTurn(runtime.nextContext(record), prompt, taskResultText(run, step));
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
    this.runtime.clock.after(RESCHEDULE_MS, () => {
      const current = this.findRun(workspaceId, runId);
      if (current?.status === 'running' && !current.paused) this.schedule(workspaceId, current);
    });
  }
}
