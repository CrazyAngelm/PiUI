import {
  arrayOf, boolean, custom, datetime, enumOf, json, lazy, mapOf, object, option, string, tagged, u32, u64, withDefault,
  type Schema,
} from './labSchema';
import { BUILTIN_HARNESSES, isHarnessId } from '../../../../../contracts/harness-identity-v2';

/** Request schemas transcribed from the Rust DTOs (`deny_unknown_fields` everywhere). */
// Harness identity v2 (`parse_harness_identity`): a built-in name or `acp:<agent id>`.
const harness = custom((value) => isHarnessId(value)
  ? undefined
  : `unknown harness \`${[...value].slice(0, 64).join('')}\`; expected one of ${BUILTIN_HARNESSES.join(', ')} or acp:<agent id>`);
export const harnessIdentitySchema = harness;
const permissionMode = enumOf(['native', 'read-only', 'workspace-write', 'full-access']);
const promptMode = enumOf(['prompt', 'steer', 'follow-up']);
const decision = enumOf(['approve-once', 'approve-session', 'deny', 'cancel']);

export const workspaceModelSchema = object({
  id: string,
  provider: option(string),
  name: string,
  thinkingLevels: option(arrayOf(string)),
});

export const workspaceCommandSchema = tagged('type', {
  catalog: {},
  createSession: {
    workspaceId: string,
    harness,
    title: option(string),
    model: option(workspaceModelSchema),
    permissionMode,
  },
  openSession: { sessionId: string },
  snapshot: { sessionId: string },
  send: { sessionId: string, text: string, mode: promptMode },
  interrupt: { sessionId: string },
  closeSession: { sessionId: string },
  setModel: { sessionId: string, model: workspaceModelSchema, thinkingLevel: option(string) },
  renameSession: { sessionId: string, title: string },
  respond: { sessionId: string, requestId: string, decision, text: option(string) },
});

export const settingsCommandSchema = tagged('type', {
  get: { sessionId: string },
  set: { sessionId: string, model: workspaceModelSchema, thinkingLevel: option(string), serviceTier: option(string) },
});

export const lifecycleCommandSchema = tagged('type', { deleteSession: { sessionId: string } });
export const historyRequestSchema = object({ sessionId: string });
export const harnessModelsRequestSchema = object({ workspaceId: string, harness });

export const composerCommandSchema = tagged('type', {
  snapshot: { sessionId: string },
  send: { sessionId: string, requestId: string, text: string, mode: promptMode, attachments: withDefault(arrayOf(string)) },
  edit: { sessionId: string, requestId: string, text: string },
  promote: { sessionId: string, requestId: string },
  remove: { sessionId: string, requestId: string },
  resume: { sessionId: string },
  compact: { sessionId: string },
});

/** `ComposerInputsCommand` (composer inputs v1). */
export const composerInputsCommandSchema = tagged('type', {
  pick: { workspaceId: string },
  paste: { workspaceId: string, name: string, data: string },
  drop: { workspaceId: string, dropId: string },
  preview: { attachmentId: string },
  discard: { attachmentIds: arrayOf(string) },
  files: { workspaceId: string, query: string },
  catalog: { sessionId: string },
});

const toolRule = object({
  tool: string,
  decision: enumOf(['allow', 'deny']),
  enforcement: enumOf(['native', 'coordinator', 'advisory', 'unsupported']),
  mandatory: boolean,
});

export const profileSchema = object({
  whenToCall: option(string),
  inputInstructions: option(string),
  expectedResult: option(string),
  id: string,
  name: string,
  harness,
  modelProvider: option(string),
  model: string,
  permissionMode,
  networkAccess: withDefault(boolean),
  instructions: string,
  baseInstructions: option(string),
  reasoning: option(string),
  resourceRules: withDefault(arrayOf(object({ kind: enumOf(['skill', 'mcp']), id: string, enabled: boolean }))),
  serviceTier: option(string),
  toolPolicy: object({ rules: arrayOf(toolRule) }),
  allowedSpawnProfileIds: arrayOf(string),
});

const edge = object({ fromMemberId: string, toMemberId: string });

export const teamSchema = object({
  spawnedAgentsJoinTeam: withDefault(boolean),
  id: string,
  name: string,
  members: arrayOf(object({ id: string, profileId: string })),
  sendEdges: arrayOf(edge),
  observeEdges: arrayOf(edge),
  orchestratorMemberId: string,
});

const predicate: Schema = tagged('op', {
  equals: { field: string, value: json },
  exists: { field: string },
  all: { predicates: arrayOf(lazy(() => predicate)) },
  any: { predicates: arrayOf(lazy(() => predicate)) },
  not: { predicate: lazy(() => predicate) },
});

const router = object({
  mode: enumOf(['program', 'agent']),
  inputStepId: string,
  branches: arrayOf(object({ id: string, label: string, description: option(string), predicate: option(predicate) })),
  selectionField: option(string),
});

const step = object({
  inputBindings: withDefault(arrayOf(object({ sourceStepId: string, field: string, name: string }))),
  condition: option(object({ sourceStepId: string, field: string, equals: json })),
  routeGates: withDefault(arrayOf(object({ routerStepId: string, branchId: string }))),
  router: option(router),
  review: option(object({ field: string, retryFromStepId: string, maxIterations: option(u32) })),
  requireApproval: withDefault(boolean),
  resultFields: withDefault(arrayOf(object({
    name: string,
    kind: enumOf(['text', 'number', 'boolean', 'text-list', 'artifact']),
  }))),
  executionMode: option(enumOf(['scheduled', 'callable'])),
  // v6.2 step executors; `deny_unknown_fields` on every variant.
  executor: option(tagged('type', {
    agent: {},
    llm: {},
    script: { runtime: enumOf(['node', 'python', 'powershell']), source: string, timeoutSeconds: u32 },
  })),
  // v6.4 pinned data; the host checks its bounds and where it may be used.
  pinnedOutput: option(object({
    text: option(string),
    truncated: withDefault(boolean),
    data: option(json),
    pinnedAt: string,
    sourceRunId: option(string),
  })),
  inputInstructions: option(string),
  id: string,
  name: string,
  assignedMemberId: string,
  instructions: string,
  dependencyStepIds: arrayOf(string),
});

const pipelineInput = object({
  name: string,
  label: string,
  kind: enumOf(['text', 'long-text', 'number', 'boolean', 'choice']),
  required: withDefault(boolean),
  description: option(string),
  options: withDefault(arrayOf(string)),
  defaultValue: option(json),
});

/** Run input values are `BTreeMap<String, serde_json::Value>`; the coordinator checks their kinds. */
const runInputValues = withDefault(mapOf(json));

export const pipelineSchema = object({ id: string, name: string, steps: arrayOf(step), inputs: withDefault(arrayOf(pipelineInput)) });
export const launchCommandSchema = object({ id: string, name: string, teamId: string, pipelineId: string });

/** Host v7.2 event rules (`EventTrigger`, kebab-case kinds). */
const eventTrigger = tagged('kind', {
  'run-finished': { launchCommandId: string, outcomes: arrayOf(enumOf(['succeeded', 'failed', 'cancelled'])) },
  'files-changed': { include: arrayOf(string), exclude: withDefault(arrayOf(string)), debounceSeconds: u32 },
});

export const scheduleSchema = object({
  id: string,
  name: string,
  launchCommandId: string,
  trigger: tagged('type', {
    once: { at: datetime, timeZone: string },
    interval: { every: u64, unit: enumOf(['minutes', 'hours']), anchorAt: datetime, timeZone: string },
    calendar: { time: string, days: arrayOf(u64), startsAt: datetime, timeZone: string },
    event: { event: eventTrigger },
  }),
  missedRunPolicy: enumOf(['skip', 'coalesce']),
  overlapPolicy: enumOf(['allow', 'skip']),
  inputs: runInputValues,
});

const historyReference = object({
  fields: withDefault(arrayOf(object({ field: string, name: string }))),
  sessionId: string,
  blockId: option(string),
  contentHash: option(string),
});

export const saveRequest = (value: Schema): Schema => object({
  workspaceId: string,
  expectedRevision: option(u64),
  value,
});

export const workspaceRequestSchema = object({ workspaceId: string });
export const getDefinitionSchema = object({ workspaceId: string, id: string });
export const deleteDefinitionSchema = object({ workspaceId: string, id: string, expectedRevision: u64 });
export const runRequestSchema = object({ workspaceId: string, runId: string });
export const runMutationSchema = object({ workspaceId: string, runId: string, expectedRunRevision: u64 });
export const startRunSchema = object({
  workspaceId: string,
  runId: string,
  teamId: string,
  pipelineId: string,
  launchCommandId: option(string),
  inputs: runInputValues,
  // Host v7.2 `StartRunCommand`: only a chat may be stated.
  trigger: option(tagged('kind', { chat: { sessionId: option(string) } })),
  usePinnedData: withDefault(boolean),
});
export const cancelTaskSchema = object({ workspaceId: string, runId: string, expectedRunRevision: u64, stepId: string });
export const flowControlSchema = object({
  workspaceId: string,
  runId: string,
  expectedRunRevision: u64,
  action: tagged('type', {
    pause: {},
    resume: {},
    decide: { stepId: string, taskRevision: u64, approved: boolean },
    repeat: { stepId: string, taskRevision: u64 },
  }),
});
export const retryUncertainSchema = object({
  workspaceId: string,
  runId: string,
  expectedRunRevision: u64,
  stepId: string,
  expectedTaskRevision: u64,
});
export const reconcileUncertainSchema = object({
  workspaceId: string,
  runId: string,
  expectedRunRevision: u64,
  stepId: string,
  expectedTaskRevision: u64,
  resolution: tagged('status', {
    succeeded: { resultReference: option(historyReference) },
    failed: { failureCode: string },
    cancelled: {},
  }),
});
export const saveGraphSchema = object({
  workspaceId: string,
  profiles: arrayOf(saveRequest(profileSchema)),
  team: saveRequest(teamSchema),
  pipeline: saveRequest(pipelineSchema),
  command: saveRequest(launchCommandSchema),
});
export const saveScheduleSchema = saveRequest(scheduleSchema);
export const scheduleMutationSchema = object({ workspaceId: string, id: string, expectedRevision: u64 });
export const setScheduleEnabledSchema = object({ workspaceId: string, id: string, expectedRevision: u64, enabled: boolean });
export const automationsStateSchema = object({});
export const setAutomationsPausedSchema = object({ paused: boolean });
export const backgroundSettingsSchema = object({});
export const backgroundUpdateSchema = object({ keepInTray: option(boolean), launchAtLogin: option(boolean) });
export const trayLabelsSchema = object({
  open: string, pause: string, resume: string, quit: string, tooltip: string, pausedTooltip: string,
});
