import {
  arrayOf, boolean, datetime, enumOf, json, lazy, object, option, string, tagged, u64, withDefault,
  type Schema,
} from './labSchema';

/** Request schemas transcribed from the Rust DTOs (`deny_unknown_fields` everywhere). */
const harness = enumOf(['pi', 'prime-agent', 'codex', 'hermes']);
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
  send: { sessionId: string, requestId: string, text: string, mode: promptMode },
  edit: { sessionId: string, requestId: string, text: string },
  promote: { sessionId: string, requestId: string },
  remove: { sessionId: string, requestId: string },
  resume: { sessionId: string },
  compact: { sessionId: string },
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
  review: option(object({ field: string, retryFromStepId: string })),
  requireApproval: withDefault(boolean),
  resultFields: withDefault(arrayOf(object({
    name: string,
    kind: enumOf(['text', 'number', 'boolean', 'text-list', 'artifact']),
  }))),
  executionMode: option(enumOf(['scheduled', 'callable'])),
  inputInstructions: option(string),
  id: string,
  name: string,
  assignedMemberId: string,
  instructions: string,
  dependencyStepIds: arrayOf(string),
});

export const pipelineSchema = object({ id: string, name: string, steps: arrayOf(step) });
export const launchCommandSchema = object({ id: string, name: string, teamId: string, pipelineId: string });

export const scheduleSchema = object({
  id: string,
  name: string,
  launchCommandId: string,
  trigger: tagged('type', {
    once: { at: datetime, timeZone: string },
    interval: { every: u64, unit: enumOf(['minutes', 'hours']), anchorAt: datetime, timeZone: string },
  }),
  missedRunPolicy: enumOf(['skip', 'coalesce']),
  overlapPolicy: enumOf(['allow', 'skip']),
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
