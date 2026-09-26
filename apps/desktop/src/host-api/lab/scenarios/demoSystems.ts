import { HOUR, LAB_BASE_TIME, labIso, MINUTE, SECOND } from '../labClock';
import type {
  AgentProfile, LaunchCommandReference, PipelineDefinition, RunDefinitionSnapshot, TeamDefinition,
} from '../labContracts';
import { createRandom, labUuid } from '../labRandom';
import { emptyOrchestration, type LabOrchestrationWorkspace, type LabSchedule, type LabSessionRecord } from '../labState';
import { sha256Hex } from '../sha256';
import { TranscriptBuilder } from '../transcriptBuilder';
import { LIVE_COMMANDS, LIVE_THINKING } from '../transcriptSamples';
import { taskContinuation } from '../turnScripts';
import {
  advanceProgramRouters, completeTask, dispatchTask, leaseTask, newRun, profileForStep, readyTaskIds, stepOf,
  type LabRun,
} from '../orchestration/runEngine';
import { taskPrompt, taskResultText } from '../orchestration/taskContent';
import { resolveRunInputs } from '../../runInputs';
import { DEMO_FOLDERS, DEMO_PROJECTS } from './demoChats';
import { seededUsage, sessionRecord, type SeedActivity } from './seedTypes';

/** "Code review" (Planner → Developer → Reviewer with a review loop) and "Video pipeline" (program router + approval). */
const id = (name: string): string => labUuid(`demo:${name}`);

const NODE = {
  planner: id('node:planner'),
  developer: id('node:developer'),
  reviewer: id('node:reviewer'),
  script: id('node:script-writer'),
  router: id('node:format-router'),
  shorts: id('node:shorts-editor'),
  storyboard: id('node:storyboard-artist'),
  render: id('node:render-planner'),
};
const BRANCH = { short: id('branch:short-form'), long: id('branch:long-form') };

/** Recorded "What should be reviewed?" values of the seeded Code review runs. */
const TRANSPORT_REVIEW = 'Route every host event listener through src/host-api/transport.ts and cover the cancellation path with a test.';
const NIGHTLY_REVIEW = 'Review the changes merged since the last nightly run and check that every failure path has a test.';

type ProfilePatch = Omit<AgentProfile, 'id' | 'name' | 'toolPolicy' | 'allowedSpawnProfileIds'> & Partial<AgentProfile>;

function profile(name: string, patch: ProfilePatch): AgentProfile {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  return { id: id(`profile:${slug}`), name, toolPolicy: { rules: [] }, allowedSpawnProfileIds: [], ...patch };
}

interface System {
  profiles: AgentProfile[];
  team: TeamDefinition;
  pipeline: PipelineDefinition;
  command: LaunchCommandReference;
}

function codeReview(): System {
  const planner = profile('Planner', {
    harness: 'pi', modelProvider: 'anthropic-lab', model: 'claude-lab-sonnet', permissionMode: 'read-only', reasoning: 'medium',
    instructions: 'Break the request into small, verifiable steps. Do not edit files.',
    whenToCall: 'At the start of a change, to turn a request into a short plan.',
    expectedResult: 'A numbered plan with explicit out-of-scope notes.',
  });
  const developer = profile('Developer', {
    harness: 'codex', modelProvider: 'openai-lab', model: 'gpt-lab-5-codex', permissionMode: 'workspace-write', reasoning: 'high',
    serviceTier: 'standard',
    instructions: 'Implement the plan with the smallest change. Run the focused tests before finishing.',
    inputInstructions: 'The plan from the Planner and, on a retry, the Reviewer findings.',
    resourceRules: [
      { kind: 'skill', id: '/lab/codex/skills/test-runner/SKILL.md', enabled: true },
      { kind: 'mcp', id: 'lab-issues', enabled: true },
    ],
  });
  const reviewer = profile('Reviewer', {
    harness: 'prime-agent', modelProvider: 'prime-lab', model: 'prime-lab-large', permissionMode: 'native', reasoning: 'high',
    serviceTier: 'standard',
    instructions: 'Review the change against the plan. Approve only when tests cover the failure path.',
    expectedResult: 'approved (boolean) and a one-paragraph summary.',
    resourceRules: [{ kind: 'skill', id: 'code-review', enabled: true }],
    toolPolicy: { rules: [{ tool: 'ipython', decision: 'deny', enforcement: 'native', mandatory: true }] },
  });
  const team: TeamDefinition = {
    id: id('team:code-review'),
    name: 'Code review',
    members: [
      { id: NODE.planner, profileId: planner.id },
      { id: NODE.developer, profileId: developer.id },
      { id: NODE.reviewer, profileId: reviewer.id },
    ],
    // Reviewer feedback flows back to the Developer (the visible back edge).
    sendEdges: [{ fromMemberId: NODE.reviewer, toMemberId: NODE.developer }],
    observeEdges: [{ fromMemberId: NODE.planner, toMemberId: NODE.reviewer }],
    orchestratorMemberId: NODE.planner,
  };
  const pipeline: PipelineDefinition = {
    id: id('pipeline:code-review'),
    name: 'Code review',
    steps: [
      { id: NODE.planner, name: 'Planner', assignedMemberId: NODE.planner, dependencyStepIds: [],
        instructions: 'Turn this change request into a short, testable plan: {{input.task}}' },
      { id: NODE.developer, name: 'Developer', assignedMemberId: NODE.developer, dependencyStepIds: [NODE.planner],
        instructions: 'Implement the plan and run the focused tests.' },
      { id: NODE.reviewer, name: 'Reviewer', assignedMemberId: NODE.reviewer, dependencyStepIds: [NODE.developer],
        instructions: 'Review the implementation. Reject it if the failure path is untested.',
        resultFields: [{ name: 'approved', kind: 'boolean' }, { name: 'summary', kind: 'text' }],
        review: { field: 'approved', retryFromStepId: NODE.developer, maxIterations: 3 } },
    ],
    inputs: [{
      name: 'task', label: 'What should be reviewed?', kind: 'long-text', required: true,
      description: 'The change to plan, implement and review, with any files or acceptance criteria.',
    }],
  };
  const command: LaunchCommandReference = { id: id('system:code-review'), name: 'Code review', teamId: team.id, pipelineId: pipeline.id };
  return { profiles: [planner, developer, reviewer], team, pipeline, command };
}

function videoPipeline(): System {
  const script = profile('Script writer', {
    harness: 'hermes', modelProvider: 'nous-lab', model: 'hermes-lab-70b', permissionMode: 'native',
    instructions: 'Write a 45-second script. Decide whether it is a short-form or long-form cut.',
  });
  const shorts = profile('Shorts editor', {
    harness: 'codex', modelProvider: 'openai-lab', model: 'gpt-lab-5-mini', permissionMode: 'workspace-write', reasoning: 'low',
    instructions: 'Produce a 9:16 edit decision list from the script.',
  });
  const storyboard = profile('Storyboard artist', {
    harness: 'prime-agent', modelProvider: 'prime-lab', model: 'prime-lab-small', permissionMode: 'native', reasoning: 'low',
    instructions: 'Storyboard the script shot by shot.',
    resourceRules: [{ kind: 'skill', id: 'storyboard', enabled: true }],
  });
  const render = profile('Render planner', {
    harness: 'pi', modelProvider: 'anthropic-lab', model: 'claude-lab-haiku', permissionMode: 'read-only', reasoning: 'low',
    instructions: 'Plan the render queue for the approved storyboard.',
  });
  const team: TeamDefinition = {
    id: id('team:video-pipeline'),
    name: 'Video pipeline',
    members: [
      { id: NODE.script, profileId: script.id },
      { id: NODE.shorts, profileId: shorts.id },
      { id: NODE.storyboard, profileId: storyboard.id },
      { id: NODE.render, profileId: render.id },
    ],
    sendEdges: [{ fromMemberId: NODE.storyboard, toMemberId: NODE.render }],
    observeEdges: [],
    orchestratorMemberId: NODE.script,
  };
  const pipeline: PipelineDefinition = {
    id: id('pipeline:video-pipeline'),
    name: 'Video pipeline',
    steps: [
      { id: NODE.script, name: 'Script writer', assignedMemberId: NODE.script, dependencyStepIds: [],
        instructions: 'Write the trailer script.',
        resultFields: [{ name: 'format', kind: 'text' }, { name: 'title', kind: 'text' }, { name: 'logline', kind: 'text' }] },
      { id: NODE.router, name: 'Format router', assignedMemberId: NODE.router, dependencyStepIds: [NODE.script],
        instructions: 'Choose which routes should continue.',
        router: {
          mode: 'program',
          inputStepId: NODE.script,
          branches: [
            { id: BRANCH.short, label: 'Short-form', predicate: { op: 'equals', field: 'format', value: 'short' } },
            { id: BRANCH.long, label: 'Long-form', predicate: { op: 'equals', field: 'format', value: 'long' } },
          ],
        } },
      { id: NODE.shorts, name: 'Shorts editor', assignedMemberId: NODE.shorts, dependencyStepIds: [NODE.router],
        routeGates: [{ routerStepId: NODE.router, branchId: BRANCH.short }], instructions: 'Cut the short-form version.' },
      { id: NODE.storyboard, name: 'Storyboard artist', assignedMemberId: NODE.storyboard, dependencyStepIds: [NODE.router],
        routeGates: [{ routerStepId: NODE.router, branchId: BRANCH.long }], requireApproval: true,
        instructions: 'Storyboard the long-form trailer for human approval.' },
      { id: NODE.render, name: 'Render planner', assignedMemberId: NODE.render, dependencyStepIds: [NODE.storyboard],
        instructions: 'Plan the renders for the approved storyboard.' },
    ],
  };
  const command: LaunchCommandReference = {
    id: id('system:video-pipeline'), name: 'Video pipeline', teamId: team.id, pipelineId: pipeline.id,
  };
  return { profiles: [script, shorts, storyboard, render], team, pipeline, command };
}

/** Library-only profiles that no saved system uses yet. */
function libraryProfiles(): AgentProfile[] {
  return [
    profile('Docs writer', {
      harness: 'hermes', modelProvider: 'nous-lab', model: 'hermes-lab-8b', permissionMode: 'native',
      instructions: 'Write user-facing documentation in plain English.',
      whenToCall: 'When a change needs README or guide updates.',
    }),
    profile('Release notes', {
      harness: 'codex', modelProvider: 'openai-lab', model: 'gpt-lab-5-mini', permissionMode: 'read-only', networkAccess: true,
      reasoning: 'minimal', instructions: 'Summarize merged changes as release notes.',
    }),
  ];
}

type Launch = readonly [stepId: string, outcome: 'succeeded' | 'failed' | 'running'];

interface SeededRun {
  run: LabRun;
  sessions: LabSessionRecord[];
  activity: SeedActivity[];
}

/**
 * Plays launches through the real run engine so revisions, attempts and
 * statuses are consistent by construction; each execution gets a transcript.
 */
function seedRun(
  workspaceId: string,
  runId: string,
  definition: RunDefinitionSnapshot,
  start: number,
  launches: readonly Launch[],
  inputs: Readonly<Record<string, string>> = {},
): SeededRun {
  const recorded = resolveRunInputs(definition.pipeline.inputs, inputs);
  if (!recorded.ok) throw new Error(`Seed run ${runId} has invalid inputs.`);
  const run = newRun(runId, structuredClone(definition), recorded.values);
  const folder = workspaceId === DEMO_PROJECTS.video ? DEMO_FOLDERS.video : DEMO_FOLDERS.piui;
  const records = new Map<string, LabSessionRecord>();
  const activity: SeedActivity[] = [];
  let cursor = start;
  for (const [stepId, outcome] of launches) {
    advanceProgramRouters(run);
    const step = stepOf(run, stepId);
    const agent = step === undefined ? undefined : profileForStep(run, step);
    if (step === undefined || agent === undefined || !readyTaskIds(run).includes(stepId)) {
      throw new Error(`Seed step ${stepId} is not ready.`);
    }
    const attempt = run.attempts.filter((item) => item.stepId === stepId).length;
    const sessionId = labUuid(`${runId}:${stepId}:${attempt}`);
    leaseTask(run, stepId, sessionId);
    dispatchTask(run, stepId, sessionId);
    const random = createRandom(sessionId);
    const { command, output } = random.pick(LIVE_COMMANDS);
    const result = taskResultText(run, step);
    const transcript = new TranscriptBuilder(agent.harness, `run-${sessionId.slice(0, 8)}`, cursor, folder)
      .user(taskPrompt(records, run, step), 2)
      .thinking(random.pick(LIVE_THINKING))
      .command(command, output);
    if (outcome === 'succeeded') transcript.assistant(result);
    if (outcome === 'failed') {
      transcript
        .assistant('Applying the plan to `src/host-api/transport.ts`…', 'failed')
        .error('The Codex model provider is unavailable.');
    }
    const blocks = transcript.build();
    const usage = seededUsage(`task-${sessionId.slice(0, 8)}`, random.int(12_000, 48_000), random.int(900, 4_200));
    const record = sessionRecord({
      id: sessionId, workspaceId, harness: agent.harness, title: `${agent.name} - ${stepId}`,
      blocks, updatedAt: transcript.lastInstant(),
      model: { id: agent.model, ...(agent.modelProvider ? { provider: agent.modelProvider } : {}), name: agent.model },
      ...(agent.reasoning ? { thinkingLevel: agent.reasoning } : {}),
      ...(agent.serviceTier === 'standard' || agent.serviceTier === 'fast' ? { serviceTier: agent.serviceTier } : {}),
      permissionMode: agent.permissionMode,
      ...(outcome === 'running' ? { live: 'running' as const } : { usage: [usage] }),
      run: { runId, memberId: step.assignedMemberId, profileId: agent.id },
    });
    records.set(sessionId, record);
    const answer = blocks.at(-1);
    if (outcome === 'succeeded' && answer?.text !== undefined) {
      completeTask(run, stepId, sessionId, {
        status: 'succeeded',
        text: answer.text,
        reference: { sessionId, blockId: answer.id, contentHash: sha256Hex(answer.text) },
      });
    } else if (outcome === 'failed') {
      completeTask(run, stepId, sessionId, { status: 'failed', code: 'native-turn-failed' });
    } else {
      record.turnSerial = 1;
      const context = { harness: agent.harness, sessionId, turn: 1, permissionMode: agent.permissionMode, cwd: folder };
      activity.push({ kind: 'running-task', workspaceId, runId, stepId, steps: taskContinuation(context, result) });
    }
    cursor = Date.parse(transcript.lastInstant()) + 45 * SECOND;
  }
  return { run, sessions: [...records.values()], activity };
}

function snapshotOf(system: System, profiles: readonly AgentProfile[]): RunDefinitionSnapshot {
  return { profiles: [...profiles], team: system.team, pipeline: system.pipeline, launchCommand: system.command };
}

const NIGHTLY_ANCHOR = '2026-09-20T02:00:00Z';
const NIGHTLY_OCCURRENCE = '2026-09-26T02:00:00Z';

export function demoSystems(): { orchestration: LabOrchestrationWorkspace[]; sessions: LabSessionRecord[]; activity: SeedActivity[] } {
  const review = codeReview();
  const video = videoPipeline();
  const library = libraryProfiles();
  const piui = emptyOrchestration(DEMO_PROJECTS.piui);
  piui.profiles = [...review.profiles, ...library].map((value) => ({ revision: 0, value }));
  piui.teams = [{ revision: 0, value: review.team }];
  piui.pipelines = [{ revision: 0, value: review.pipeline }];
  piui.launchCommands = [{ revision: 0, value: review.command }];
  const studio = emptyOrchestration(DEMO_PROJECTS.video);
  studio.profiles = video.profiles.map((value) => ({ revision: 0, value }));
  studio.teams = [{ revision: 0, value: video.team }];
  studio.pipelines = [{ revision: 0, value: video.pipeline }];
  studio.launchCommands = [{ revision: 0, value: video.command }];

  const reviewSnapshot = snapshotOf(review, piui.profiles.map((stored) => stored.value));
  const nightlyRunId = `schedule-${sha256Hex(`${id('schedule:nightly')}\u00000\u0000${Date.parse(NIGHTLY_OCCURRENCE)}`)}`;
  const nightly = seedRun(DEMO_PROJECTS.piui, nightlyRunId, reviewSnapshot, Date.parse(NIGHTLY_OCCURRENCE) + 5 * SECOND, [
    [NODE.planner, 'succeeded'], [NODE.developer, 'succeeded'], [NODE.reviewer, 'succeeded'],
    [NODE.developer, 'succeeded'], [NODE.reviewer, 'succeeded'],
  ], { task: NIGHTLY_REVIEW });
  const failed = seedRun(DEMO_PROJECTS.piui, id('run:failed'), reviewSnapshot, LAB_BASE_TIME - 18 * HOUR - 20 * MINUTE, [
    [NODE.planner, 'succeeded'], [NODE.developer, 'failed'],
  ], { task: TRANSPORT_REVIEW });
  const running = seedRun(DEMO_PROJECTS.piui, id('run:running'), reviewSnapshot, LAB_BASE_TIME - 6 * MINUTE, [
    [NODE.planner, 'succeeded'], [NODE.developer, 'running'],
  ], { task: TRANSPORT_REVIEW });
  const awaiting = seedRun(DEMO_PROJECTS.video, id('run:video'), snapshotOf(video, video.profiles), LAB_BASE_TIME - 70 * MINUTE, [
    [NODE.script, 'succeeded'], [NODE.storyboard, 'succeeded'],
  ]);
  piui.runs = [nightly.run, failed.run, running.run];
  studio.runs = [awaiting.run];

  const nightlySchedule: LabSchedule = {
    revision: 2,
    triggerRevision: 0,
    value: {
      id: id('schedule:nightly'), name: 'Nightly code review', launchCommandId: review.command.id,
      trigger: { type: 'interval', every: 24, unit: 'hours', anchorAt: NIGHTLY_ANCHOR, timeZone: 'Asia/Bangkok' },
      missedRunPolicy: 'skip', overlapPolicy: 'skip',
      inputs: { task: NIGHTLY_REVIEW },
    },
    enabled: true,
    enabledLaunchCommandRevision: 0,
    nextDueAt: labIso(Date.parse(NIGHTLY_OCCURRENCE) + 24 * HOUR),
    occurrences: [{
      id: nightlyRunId,
      nominalAt: NIGHTLY_OCCURRENCE,
      recordedAt: labIso(Date.parse(NIGHTLY_OCCURRENCE) + SECOND),
      outcome: 'started',
      runId: nightlyRunId,
    }],
  };
  const weeklySchedule: LabSchedule = {
    revision: 0,
    triggerRevision: 0,
    value: {
      id: id('schedule:weekly-trailer'), name: 'Weekly trailer refresh', launchCommandId: video.command.id,
      trigger: { type: 'once', at: '2026-10-01T08:00:00Z', timeZone: 'Europe/Lisbon' },
      missedRunPolicy: 'coalesce', overlapPolicy: 'allow',
    },
    enabled: false,
    enabledLaunchCommandRevision: null,
    nextDueAt: '2026-10-01T08:00:00Z',
    occurrences: [],
  };
  piui.schedules = [nightlySchedule];
  studio.schedules = [weeklySchedule];

  return {
    orchestration: [piui, studio],
    sessions: [...nightly.sessions, ...failed.sessions, ...running.sessions, ...awaiting.sessions],
    activity: [...running.activity],
  };
}
