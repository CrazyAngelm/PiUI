import type {
  AgentProfile, FailureRecord, OrchestrationRunV6, PipelineStep, ResultField, RunDefinitionSnapshot, ScriptRuntime,
  StepExecutor, TaskOutput,
} from '../../../../contracts/orchestration-v6';

/**
 * Step executors (orchestration v6.2), mirroring
 * `piui-orchestration/src/executors.rs`. The Rust coordinator and host are
 * the authority; these pure helpers let the editor check a graph before
 * saving and let the UI Lab host behave identically. A script is trusted
 * user code the host runs in the project folder; it is not a sandbox.
 */
export const SCRIPT_RUNTIMES: readonly ScriptRuntime[] = ['node', 'python', 'powershell'];
export const MAX_SCRIPT_SOURCE_BYTES = 64 * 1024;
export const MIN_SCRIPT_TIMEOUT_SECONDS = 1;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 3600;
export const MAX_SCRIPT_STDOUT_BYTES = 256 * 1024;
export const MAX_SCRIPT_STDERR_BYTES = 64 * 1024;
export const MAX_FAILURE_DETAIL_BYTES = 2 * 1024;

/** Failure codes of script steps; declared results use the native `result-*` codes. */
export const SCRIPT_FAILURE_CODES = {
  failed: 'script-failed',
  timeout: 'script-timeout',
  runtimeUnavailable: 'script-runtime-unavailable',
  inputUnavailable: 'script-input-unavailable',
  startFailed: 'script-start-failed',
} as const;
/** An `llm` step's harness has no read-only mode. */
export const LLM_READ_ONLY_UNSUPPORTED = 'llm-read-only-unsupported';

/** Rust `DefinitionError::InvalidExecutor` reasons, verbatim. */
export const EXECUTOR_REASONS = {
  callable: 'only agent steps can be callable roles; llm and script steps are scheduled',
  router: 'llm and script steps cannot be routers',
  source: 'a script needs source code',
  sourceSize: 'script source is larger than 64 KiB',
  timeout: 'a script timeout is 1 to 3600 seconds',
  bindings: 'a script reads every dependency result on stdin; input bindings apply to agent and llm steps',
  member: 'a script runs on the host, not as a team member',
  messages: 'an llm step cannot send, receive or observe messages',
  readOnly: "an llm step's profile must be read-only",
  network: "an llm step's profile has no network access",
  tools: "an llm step's profile cannot allow tools",
  resources: "an llm step's profile cannot enable skills or MCP servers",
  spawns: 'an llm step cannot spawn agents',
  spawned: "an llm step's profile cannot be spawned",
} as const;

/** Graph and system-file issues (English source strings of the locale catalog). */
export const EXECUTOR_ISSUES = {
  scriptSource: 'A script needs source code of at most 64 KiB.',
  scriptRuntime: 'Choose Node.js, Python or PowerShell for a script.',
  scriptTimeout: 'A script timeout must be a whole number of seconds from 1 to 3600.',
  scriptBindings: 'A script reads every dependency result on stdin; remove its input mappings.',
  notCallable: 'Only agents can be callable roles; model calls and scripts are scheduled steps.',
  notRouter: 'A model call or a script cannot be a router.',
  noCollaboration: 'A model call or a script cannot send, receive, observe or delegate.',
  llmReadOnly: 'A model call runs read-only: set its file permissions to read-only.',
  llmNetwork: 'A model call has no network access.',
  llmTools: 'A model call cannot allow tools.',
  llmResources: 'A model call cannot enable skills or MCP servers.',
  needsMember: 'A system needs at least one agent or model call; scripts run on the host outside the team.',
} as const;

export type ExecutorKind = StepExecutor['type'];

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).length;

/** Non-blank source of at most 64 KiB (UTF-8 bytes). */
export function scriptSourceValid(source: string): boolean {
  return source.trim() !== '' && utf8Length(source) <= MAX_SCRIPT_SOURCE_BYTES;
}

/** A whole number of seconds from 1 to 3600. */
export function scriptTimeoutValid(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= MIN_SCRIPT_TIMEOUT_SECONDS && seconds <= MAX_SCRIPT_TIMEOUT_SECONDS;
}

/** The executor kind of a step; a step without one is an agent. */
export function executorKind(step: Pick<PipelineStep, 'executor'>): ExecutorKind {
  return step.executor?.type ?? 'agent';
}

export function isScriptStep(step: Pick<PipelineStep, 'executor'>): boolean {
  return executorKind(step) === 'script';
}

/** `validate_step_executor`: self-contained rules of one stored step. */
export function stepExecutorIssue(step: PipelineStep): string | undefined {
  const executor = step.executor;
  if (executor === undefined || executor.type === 'agent') return undefined;
  if (step.executionMode === 'callable') return EXECUTOR_REASONS.callable;
  if (step.router !== undefined) return EXECUTOR_REASONS.router;
  if (executor.type === 'script') {
    if (executor.source.trim() === '') return EXECUTOR_REASONS.source;
    if (utf8Length(executor.source) > MAX_SCRIPT_SOURCE_BYTES) return EXECUTOR_REASONS.sourceSize;
    if (!scriptTimeoutValid(executor.timeoutSeconds)) return EXECUTOR_REASONS.timeout;
    if ((step.inputBindings ?? []).length > 0) return EXECUTOR_REASONS.bindings;
  }
  return undefined;
}

/** `validate_executor_authority`: rules that need the whole snapshot. */
export function executorAuthorityIssue(snapshot: RunDefinitionSnapshot, step: PipelineStep): string | undefined {
  const kind = executorKind(step);
  if (kind === 'agent') return undefined;
  const { team } = snapshot;
  if (kind === 'script') {
    return team.members.some((member) => member.id === step.assignedMemberId) ? EXECUTOR_REASONS.member : undefined;
  }
  const member = step.assignedMemberId;
  if ([...team.sendEdges, ...team.observeEdges].some((edge) => edge.fromMemberId === member || edge.toMemberId === member)) {
    return EXECUTOR_REASONS.messages;
  }
  const profileId = team.members.find((candidate) => candidate.id === member)?.profileId;
  const profile = snapshot.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) return 'assigned member';
  return llmProfileIssue(profile, snapshot.profiles);
}

/** The least-authority rules of an `llm` step's profile. */
export function llmProfileIssue(profile: AgentProfile, profiles: readonly AgentProfile[] = []): string | undefined {
  if (profile.permissionMode !== 'read-only') return EXECUTOR_REASONS.readOnly;
  if (profile.networkAccess === true) return EXECUTOR_REASONS.network;
  if (profile.toolPolicy.rules.some((rule) => rule.decision === 'allow')) return EXECUTOR_REASONS.tools;
  if ((profile.resourceRules ?? []).some((rule) => rule.enabled)) return EXECUTOR_REASONS.resources;
  if (profile.allowedSpawnProfileIds.length > 0) return EXECUTOR_REASONS.spawns;
  if (profiles.some((candidate) => candidate.allowedSpawnProfileIds.includes(profile.id))) return EXECUTOR_REASONS.spawned;
  return undefined;
}

/** `failure_detail`: the last whole lines within 2 KiB, control characters removed. */
export function failureDetail(text: string): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
  const bytes = encoder.encode(cleaned);
  if (bytes.length <= MAX_FAILURE_DETAIL_BYTES) return cleaned;
  let start = bytes.length - MAX_FAILURE_DETAIL_BYTES;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start += 1;
  const tail = new TextDecoder().decode(bytes.subarray(start));
  const newline = tail.indexOf('\n');
  return (newline >= 0 && newline + 1 < tail.length ? tail.slice(newline + 1) : tail).trim();
}

/** `FailureRecord::with_detail`: blank detail is omitted. */
export function failureWithDetail(code: string, detail: string): FailureRecord {
  const bounded = failureDetail(detail);
  return bounded === '' ? { code } : { code, detail: bounded };
}

/** `bounded_text`: at most `limit` UTF-8 bytes on a character boundary. */
export function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ResultFieldIssueCode = 'result-missing-field' | 'result-field-type';

/** `field_issue`: the code one declared field of a result object fails with. */
function fieldIssue(field: ResultField, value: Record<string, unknown>): ResultFieldIssueCode | undefined {
  if (!Object.hasOwn(value, field.name)) return 'result-missing-field';
  const item = value[field.name];
  const valid = field.kind === 'text' || field.kind === 'artifact'
    ? typeof item === 'string' && item.trim() !== ''
    : field.kind === 'number'
      ? typeof item === 'number'
      : field.kind === 'boolean'
        ? typeof item === 'boolean'
        : Array.isArray(item) && item.every((entry) => typeof entry === 'string' && entry.trim() !== '');
  return valid ? undefined : 'result-field-type';
}

/** `validate_result_value`: the native result codes for an already parsed result. */
export function resultValueIssue(fields: readonly ResultField[], value: unknown): string | undefined {
  if (fields.length === 0) return undefined;
  if (!isObject(value)) return 'result-not-object';
  for (const field of fields) {
    const issue = fieldIssue(field, value);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

/**
 * `result_field_issues`: every declared field a result object fails, in
 * declared order; the first one is what `resultValueIssue` reports.
 */
export function resultFieldIssues(
  fields: readonly ResultField[],
  value: Record<string, unknown>,
): { field: string; code: ResultFieldIssueCode }[] {
  return fields.flatMap((field) => {
    const code = fieldIssue(field, value);
    return code === undefined ? [] : [{ field: field.name, code }];
  });
}

export type ScriptResult =
  | { readonly status: 'succeeded'; readonly data?: Record<string, unknown>; readonly output?: TaskOutput }
  | { readonly status: 'failed'; readonly failure: FailureRecord };

/**
 * `complete_script_task` for an exit status of 0: complete stdout that is one
 * JSON object becomes result data checked against declared fields; any other
 * stdout is the recorded text output. A cut stdout is never read as JSON.
 */
export function scriptResult(fields: readonly ResultField[], stdout: string, truncated = false): ScriptResult {
  const bounded = boundedText(stdout, MAX_SCRIPT_STDOUT_BYTES);
  const cut = truncated || bounded.truncated;
  let parsed: unknown;
  let json = false;
  if (!cut) {
    try {
      parsed = JSON.parse(bounded.text.trim());
      json = true;
    } catch {
      json = false;
    }
  }
  if (json && isObject(parsed)) {
    const issue = resultValueIssue(fields, parsed);
    return issue === undefined ? { status: 'succeeded', data: parsed } : { status: 'failed', failure: { code: issue } };
  }
  if (fields.length > 0) return { status: 'failed', failure: { code: json ? 'result-not-object' : 'result-invalid-json' } };
  return { status: 'succeeded', output: cut ? { text: bounded.text, truncated: true } : { text: bounded.text } };
}

/** The dependency value a script reads on stdin for one direct dependency. */
export interface ScriptDependencyValue {
  readonly text: string | null;
  readonly data: Record<string, unknown> | null;
}

/**
 * `ScriptLease::stdin_document`: `{inputs, dependencies: {<stepId>: {text, data}}, step: {id, name}}`.
 * `nativeText` resolves a native dependency's verified final text.
 */
export function scriptStdinDocument(
  run: Pick<OrchestrationRunV6, 'inputs' | 'tasks'>,
  step: PipelineStep,
  nativeText: (stepId: string) => string | null,
): { inputs: Readonly<Record<string, unknown>>; dependencies: Record<string, ScriptDependencyValue>; step: { id: string; name: string } } {
  const dependencies: Record<string, ScriptDependencyValue> = {};
  for (const id of step.dependencyStepIds) {
    const task = run.tasks.find((candidate) => candidate.stepId === id);
    const text = task?.resultReference !== undefined ? nativeText(id) : task?.output?.text ?? null;
    dependencies[id] = { text, data: task?.resultData ?? null };
  }
  return { inputs: run.inputs ?? {}, dependencies, step: { id: step.id, name: step.name } };
}

/** A recorded host-executed dependency for a native prompt (`DependencyOutput::context_text`). */
export function dependencyOutputText(
  output: TaskOutput | undefined,
  data: Record<string, unknown> | undefined,
  fields: readonly { readonly field: string; readonly name: string }[] = [],
): string {
  const whole = data !== undefined ? JSON.stringify(data) : output?.text ?? '';
  if (fields.length === 0) return whole;
  const value = data ?? (() => {
    try {
      return JSON.parse(whole) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field.name, value[field.field]])));
}
