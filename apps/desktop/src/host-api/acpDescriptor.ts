import type { AcpAgentDescriptorV1 } from '../../../../contracts/harness-registry-v1';

/**
 * ACP agent descriptor v1 rules (`contracts/acp-agent-descriptor-v1.schema.json`)
 * mirrored from the host validator (`crates/piui-runtime/src/acp.rs`), so the
 * "Add ACP agent" dialog can explain a problem before the host call and the UI
 * Lab host rejects what the desktop host rejects. The host stays authoritative
 * and validates every descriptor again. Messages are the host's fixed locale
 * keys; `acpDescriptor.test.ts` checks the shared fixtures against both.
 *
 * Known difference: the host compiles `version.pattern` with the Rust `regex`
 * crate, this mirror with `RegExp`; exotic syntax may differ, the host decides.
 */
export const ACP_DESCRIPTOR_SCHEMA_VERSION = 1;

/** The descriptor id; the harness identity is `acp:<id>`. */
export const ACP_AGENT_ID = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_DISPLAY_NAME_CHARS = 64;
const MAX_PROGRAM_CHARS = 260;
const MAX_ARGS = 32;
const MAX_VERSION_ARGS = 8;
const MAX_ARG_CHARS = 512;
const MAX_PATTERN_CHARS = 200;
const MAX_ENVIRONMENT_NAMES = 32;
const MAX_ENVIRONMENT_NAME_CHARS = 128;
const MAX_AUTH_HINT_CHARS = 400;
const MAX_DOCS_URL_CHARS = 300;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const ABSOLUTE_PROGRAM = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const BARE_PROGRAM = /^[A-Za-z0-9._+-]+$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DENIED_ENVIRONMENT = ['NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'];
const SECRET_MARKERS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'AUTH', 'COOKIE', 'SESSION', 'PRIVATE'];

/** Host `AcpDescriptorError` codes with their fixed messages. */
export const ACP_DESCRIPTOR_PROBLEMS = {
  malformed: 'The descriptor is not valid JSON or contains unknown fields.',
  'too-large': 'The descriptor is larger than 32 KiB.',
  'unsupported-schema': 'Only ACP descriptor schema version 1 is supported.',
  'display-name': 'The display name must be 1-64 characters without control characters.',
  program: 'The program must be a file name found on PATH or an absolute path.',
  arguments: 'Use at most 32 arguments of 1-512 characters without control characters.',
  'version-arguments': 'Use 1-8 version arguments of 1-512 characters without control characters.',
  'version-pattern': 'The version pattern must be a valid regular expression of at most 200 characters.',
  'verified-range': 'The verified range needs MAJOR.MINOR.PATCH versions with the minimum below the ceiling.',
  'environment-name': 'Environment variables must be at most 32 unique names of letters, digits and underscores.',
  'environment-denied': 'This environment variable cannot be passed to an agent.',
  'auth-hint': 'The sign-in hint must be at most 400 characters without control characters.',
  'docs-url': 'The documentation link must be an https URL of at most 300 characters.',
  'capability-override': 'A descriptor can only switch agent features off.',
} as const;

export type AcpDescriptorProblem = keyof typeof ACP_DESCRIPTOR_PROBLEMS;

export type AcpDescriptorCheck =
  | { readonly ok: true; readonly descriptor: AcpAgentDescriptorV1 }
  | { readonly ok: false; readonly problem: AcpDescriptorProblem; readonly message: string };

type Json = Record<string, unknown>;
type Capabilities = { loadSession?: boolean; models?: boolean; modes?: boolean; mcpHttp?: boolean };
/** A shape-checked descriptor before the semantic rules (capabilities may still claim `true`). */
type Shaped = Omit<AcpAgentDescriptorV1, 'capabilities'> & { capabilities?: Capabilities };

function failure(problem: AcpDescriptorProblem): AcpDescriptorCheck {
  return { ok: false, problem, message: ACP_DESCRIPTOR_PROBLEMS[problem] };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Json, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** `Option<String>`: missing or null is none. */
function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function optionalBoolean(value: unknown): value is boolean | null | undefined {
  return value === undefined || value === null || typeof value === 'boolean';
}

/** Rust `plain_text`: 1..=maximum characters, none of them a control character. */
function plainText(value: string, maximum: number): boolean {
  const length = [...value].length;
  return length > 0 && length <= maximum && !CONTROL.test(value);
}

function plainArgs(values: readonly string[], maximum: number): boolean {
  return values.length <= maximum && values.every((value) => plainText(value, MAX_ARG_CHARS));
}

function parseCore(text: string): [number, number, number] | undefined {
  const parts = text.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return undefined;
  const [major, minor, patch] = parts.map(Number);
  return major === undefined || minor === undefined || patch === undefined ? undefined : [major, minor, patch];
}

function coreBelow(left: [number, number, number], right: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) < (right[index] ?? 0);
  }
  return false;
}

function validProgram(program: string): boolean {
  if (!plainText(program, MAX_PROGRAM_CHARS) || /["'`]/.test(program)) return false;
  if (ABSOLUTE_PROGRAM.test(program)) return true;
  return program !== '.' && program !== '..' && BARE_PROGRAM.test(program);
}

function validPattern(pattern: string): boolean {
  if (!plainText(pattern, MAX_PATTERN_CHARS)) return false;
  try {
    // Without the `u` flag: lenient escapes, closer to the Rust `regex` syntax.
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function deniedEnvironment(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('PIUI_') || DENIED_ENVIRONMENT.includes(upper);
}

/** Whether a variable name looks like a credential (`GEMINI_API_KEY`); it passes only after a confirmation. */
export function secretLikeEnvironment(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * serde's view of the document (`deny_unknown_fields`, `Option` fields accept
 * null) re-serialized in the host's field order with empty values skipped,
 * so equal descriptors serialize to equal bytes.
 */
function shape(value: Json): Shaped | undefined {
  const top = ['schemaVersion', 'id', 'displayName', 'command', 'version', 'environment', 'authHint', 'docsUrl', 'capabilities'];
  if (!onlyKeys(value, top)) return undefined;
  const { id, displayName, command, version, environment, authHint, docsUrl, capabilities } = value;
  if (typeof id !== 'string' || !ACP_AGENT_ID.test(id) || typeof displayName !== 'string') return undefined;
  if (!isObject(command) || !onlyKeys(command, ['program', 'args']) || typeof command.program !== 'string') return undefined;
  if (command.args !== undefined && !isStringArray(command.args)) return undefined;
  if (!isObject(version) || !onlyKeys(version, ['args', 'pattern', 'verified']) || !isStringArray(version.args)) return undefined;
  if (!optionalString(version.pattern)) return undefined;
  const verified = version.verified;
  if (verified !== undefined && verified !== null) {
    if (!isObject(verified) || !onlyKeys(verified, ['minimum', 'ceiling'])) return undefined;
    if (typeof verified.minimum !== 'string' || typeof verified.ceiling !== 'string') return undefined;
  }
  if (environment !== undefined && !isStringArray(environment)) return undefined;
  if (!optionalString(authHint) || !optionalString(docsUrl)) return undefined;
  if (capabilities !== undefined) {
    if (!isObject(capabilities) || !onlyKeys(capabilities, ['loadSession', 'models', 'modes', 'mcpHttp'])) return undefined;
    if (!Object.values(capabilities).every(optionalBoolean)) return undefined;
  }
  const args = command.args ?? [];
  const names = environment ?? [];
  const flags: Capabilities = {};
  for (const key of ['loadSession', 'models', 'modes', 'mcpHttp'] as const) {
    const flag = isObject(capabilities) ? capabilities[key] : undefined;
    if (typeof flag === 'boolean') flags[key] = flag;
  }
  return {
    schemaVersion: 1,
    id,
    displayName,
    command: { program: command.program, ...(args.length > 0 ? { args } : {}) },
    version: {
      args: version.args,
      ...(typeof version.pattern === 'string' ? { pattern: version.pattern } : {}),
      ...(isObject(verified) ? { verified: { minimum: String(verified.minimum), ceiling: String(verified.ceiling) } } : {}),
    },
    ...(names.length > 0 ? { environment: names } : {}),
    ...(typeof authHint === 'string' ? { authHint } : {}),
    ...(typeof docsUrl === 'string' ? { docsUrl } : {}),
    ...(Object.keys(flags).length > 0 ? { capabilities: flags } : {}),
  };
}

/** Host `validate()`, in the host's order so the first problem matches. */
function semanticProblem(descriptor: Shaped): AcpDescriptorProblem | undefined {
  if (!plainText(descriptor.displayName, MAX_DISPLAY_NAME_CHARS) || descriptor.displayName.trim() !== descriptor.displayName) {
    return 'display-name';
  }
  if (!validProgram(descriptor.command.program)) return 'program';
  if (!plainArgs(descriptor.command.args ?? [], MAX_ARGS)) return 'arguments';
  if (descriptor.version.args.length === 0 || !plainArgs(descriptor.version.args, MAX_VERSION_ARGS)) return 'version-arguments';
  if (descriptor.version.pattern !== undefined && !validPattern(descriptor.version.pattern)) return 'version-pattern';
  const verified = descriptor.version.verified;
  if (verified !== undefined) {
    const minimum = parseCore(verified.minimum);
    const ceiling = parseCore(verified.ceiling);
    if (minimum === undefined || ceiling === undefined || !coreBelow(minimum, ceiling)) return 'verified-range';
  }
  const environment = descriptor.environment ?? [];
  if (environment.length > MAX_ENVIRONMENT_NAMES) return 'environment-name';
  if (!environment.every((name) => name.length <= MAX_ENVIRONMENT_NAME_CHARS && ENVIRONMENT_NAME.test(name))) return 'environment-name';
  for (const [index, name] of environment.entries()) {
    if (environment.slice(0, index).some((other) => other.toUpperCase() === name.toUpperCase())) return 'environment-name';
    if (deniedEnvironment(name)) return 'environment-denied';
  }
  if (descriptor.authHint !== undefined && !plainText(descriptor.authHint, MAX_AUTH_HINT_CHARS)) return 'auth-hint';
  const url = descriptor.docsUrl;
  if (url !== undefined && (!plainText(url, MAX_DOCS_URL_CHARS) || !url.startsWith('https://') || url.length <= 'https://'.length || /\s/u.test(url))) {
    return 'docs-url';
  }
  if (Object.values(descriptor.capabilities ?? {}).includes(true)) return 'capability-override';
  return undefined;
}

/** Validates a descriptor value (for example the object a form produced). */
export function checkAcpDescriptor(value: unknown): AcpDescriptorCheck {
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').length > MAX_DESCRIPTOR_BYTES) return failure('too-large');
  if (!isObject(value) || value.schemaVersion === undefined) return failure('malformed');
  if (value.schemaVersion !== ACP_DESCRIPTOR_SCHEMA_VERSION) return failure('unsupported-schema');
  const shaped = shape(value);
  if (shaped === undefined) return failure('malformed');
  const problem = semanticProblem(shaped);
  // After validation every capability flag present is `false`.
  return problem === undefined ? { ok: true, descriptor: shaped as AcpAgentDescriptorV1 } : failure(problem);
}

/** Validates pasted descriptor JSON. */
export function parseAcpDescriptor(text: string): AcpDescriptorCheck {
  if (new TextEncoder().encode(text).length > MAX_DESCRIPTOR_BYTES) return failure('too-large');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return failure('malformed');
  }
  return checkAcpDescriptor(value);
}

/** The descriptor's secret-like environment names, in descriptor order. */
export function secretEnvironment(descriptor: AcpAgentDescriptorV1): string[] {
  return (descriptor.environment ?? []).filter(secretLikeEnvironment);
}
