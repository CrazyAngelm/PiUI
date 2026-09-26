import {
  HARNESS_REGISTRY_EVENT_V1,
  type AcpAgentDescriptorV1,
  type AcpAgentEntryV1,
  type AcpVersionStatus,
  type CommandLineV1,
  type HarnessRegistryCommandV1,
  type HarnessRegistryErrorCode,
  type HarnessRegistryV1,
  type HarnessState,
  type HarnessStatusV1,
} from '../../../../../contracts/harness-registry-v1';
import {
  acpAgentId,
  acpHarnessId,
  isAcpHarness,
  isBuiltinHarness,
  type BuiltinHarness,
} from '../../../../../contracts/harness-identity-v2';
import type { SessionModeRequestV1, SessionModeResultV1 } from '../../../../../contracts/workspace-session-mode-v1';
import { ACP_DEFAULT_MODEL } from '../../harness-adapters/acp';
import { ACP_AGENT_ID, checkAcpDescriptor, secretEnvironment } from '../acpDescriptor';
import { ACP_LAB_MODES, CLAUDE_SIGN_IN_MESSAGE } from './catalogFake';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import type { HarnessKind, HarnessSummary, WorkspaceModel } from './labContracts';
import { workspaceFailure, type HostErrorPayload } from './labErrors';
import { authorizeLive, requireLive, validToken } from './labGuards';
import type { LabHandlers } from './labHandlers';
import { arrayOf, custom, decodeArgument, json, object, option, string, tagged, u64, type Schema } from './labSchema';
import { harnessIdentitySchema } from './labSchemas';
import type { LabState } from './labState';
import type { LabSessions } from './sessionRuntime';
import { sha256Hex } from './sha256';

/**
 * UI Lab ACP agent registry (ADR-034): the fake of `harness_registry_v1`,
 * `workspace_session_mode_v1` and the start checks the host applies to
 * `acp:<id>` harnesses. A fake machine decides which programs are "on PATH"
 * and what `--version` prints; nothing runs. Rules mirror
 * `apps/desktop/src-tauri/src/acp_agents.rs`: a user descriptor is untrusted
 * until its exact command line is trusted, an unverified version and each
 * secret-like environment name need their own confirmation, every decision
 * binds to the descriptor fingerprint, and changes name the registry revision.
 *
 * Scenarios: `demo`/`long` ship a ready Gemini CLI (version confirmed), a
 * user descriptor whose program is missing (Qwen Code) and an untrusted one
 * (Lab Agent, which asks to sign in on its first start). `safe` has the same
 * agents but runs no discovery, so nothing is checked. `empty` is a fresh
 * machine: Gemini CLI is not installed.
 */

const NODE = 'C:/Program Files/nodejs/node.exe';
const CHECK_LATENCY_MS = 450;
const TRUST_LATENCY_MS = 250;
const MAX_USER_AGENTS = 32;
const DEFAULT_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const CHECKING = 'Checking this agent…';
const SIGN_IN_REASON = "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.";

/** Programs on the fake PATH: the resolved entry and what `--version` prints. */
interface LabProgram {
  readonly entry: string;
  readonly versionOutput: string;
}

const LAB_PATH: Readonly<Record<string, LabProgram>> = {
  gemini: { entry: 'C:/Users/example/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js', versionOutput: '0.39.1\n' },
  'lab-agent': { entry: 'C:/Users/example/.local/bin/lab-agent.exe', versionOutput: 'lab-agent 1.4.0 (lab build)\n' },
};

/** Agents that refuse their first start until the user signs in (then accept the next one). */
const SIGN_IN_ON_FIRST_START: Readonly<Record<string, readonly string[]>> = {
  'lab-agent': ['Lab Agent login', 'API key'],
};

const BUILTIN_LOCATIONS: Readonly<Record<BuiltinHarness, string>> = {
  pi: 'C:/Users/example/AppData/Roaming/npm/node_modules/@lab/pi-coding-agent/dist/cli.js',
  'prime-agent': 'C:/Users/example/.local/bin/prime.exe',
  codex: 'C:/Users/example/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js',
  hermes: 'C:/Users/example/.local/bin/hermes.exe',
  'claude-code': 'C:/Users/example/.local/bin/claude.exe',
};

/** `builtin_verified_versions` */
const BUILTIN_VERIFIED: Readonly<Partial<Record<BuiltinHarness, string>>> = {
  codex: '0.147.0 – 0.157.x',
  'claude-code': '2.1.0 – 2.x',
  'prime-agent': '0.9.2, 0.9.3',
  hermes: '0.21.0',
};

/** `builtin_sign_in_hint`: PiUI never signs in. */
const BUILTIN_SIGN_IN: Readonly<Partial<Record<BuiltinHarness, string>>> = {
  'claude-code': 'Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.',
  codex: "Sign in with Codex's own flow: run `codex login` in a terminal.",
};

/** The descriptor the host ships (`contracts/fixtures/acp-descriptors/valid-builtin-gemini-cli.json`). */
export const LAB_GEMINI_DESCRIPTOR: AcpAgentDescriptorV1 = {
  schemaVersion: 1,
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  command: { program: 'gemini', args: ['--experimental-acp'] },
  version: { args: ['--version'] },
  environment: [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_VERTEXAI', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ],
  authHint: "Sign in with Gemini CLI's own flow: run `gemini` in a terminal and choose a sign-in method. To use an API key instead, allow PiUI to pass GEMINI_API_KEY below.",
  docsUrl: 'https://github.com/google-gemini/gemini-cli',
};

const QWEN_DESCRIPTOR: AcpAgentDescriptorV1 = {
  schemaVersion: 1,
  id: 'qwen-code',
  displayName: 'Qwen Code',
  command: { program: 'qwen', args: ['--experimental-acp'] },
  version: { args: ['--version'], pattern: 'qwen(?:-code)? v?(\\d+\\.\\d+\\.\\d+)', verified: { minimum: '0.1.0', ceiling: '0.2.0' } },
  environment: ['DASHSCOPE_API_KEY', 'HTTPS_PROXY'],
  authHint: 'Run `qwen` in a terminal and sign in, then check again.',
  docsUrl: 'https://github.com/QwenLM/qwen-code',
  capabilities: { loadSession: false, mcpHttp: false },
};

const LAB_AGENT_DESCRIPTOR: AcpAgentDescriptorV1 = {
  schemaVersion: 1,
  id: 'lab-agent',
  displayName: 'Lab Agent',
  command: { program: 'lab-agent', args: ['--acp'] },
  version: { args: ['--version'], pattern: 'lab-agent (\\d+\\.\\d+\\.\\d+)', verified: { minimum: '1.0.0', ceiling: '2.0.0' } },
  environment: ['LAB_AGENT_TOKEN', 'HTTPS_PROXY'],
  authHint: 'Run `lab-agent login` in a terminal, then try again.',
};

/** Same bytes as the host's `serde_json::to_vec` of the normalized descriptor. */
export function labFingerprint(descriptor: AcpAgentDescriptorV1): string {
  const checked = checkAcpDescriptor(descriptor);
  return sha256Hex(JSON.stringify(checked.ok ? checked.descriptor : descriptor));
}

type Resolution =
  | { readonly ok: true; readonly line: CommandLineV1; readonly location: string; readonly versionOutput: string }
  | { readonly ok: false; readonly reason: string };

interface VersionReport {
  readonly version?: string;
  readonly status: AcpVersionStatus;
}

interface Discovery {
  readonly checkedAt: string;
  readonly resolution: Resolution;
  /** Absent until the agent may run (shipped or trusted). */
  readonly report?: VersionReport;
}

interface Decision {
  fingerprint: string;
  trustedCommand?: CommandLineV1;
  confirmedVersion?: string;
  allowedSecrets: string[];
}

class RegistryFailure {
  constructor(readonly code: HarnessRegistryErrorCode, readonly message: string) {}
}

const REGISTRY_MESSAGES: Readonly<Record<Exclude<HarnessRegistryErrorCode, 'INVALID_DESCRIPTOR'>, string>> = {
  SAFE_MODE: 'Harness checks and changes are disabled in safe mode.',
  CONFLICT: 'The harness list changed. Review it and try again.',
  DUPLICATE: 'An agent with this ID already exists.',
  NOT_FOUND: 'This agent is no longer registered.',
  BUILT_IN: 'Agents that ship with PiUI cannot be removed or re-trusted.',
  TRUST_CHANGED: 'The agent or its command line changed since you reviewed it. Review it again.',
  NOT_INSTALLED: 'The program was not found, so there is nothing to trust yet.',
  NOTHING_TO_CONFIRM: 'There is nothing to confirm for this agent right now. Check it again.',
  LIMIT: 'Remove an agent before adding another (32 at most).',
  IO_ERROR: 'PiUI could not save the harness list.',
};

function registryFailure(code: Exclude<HarnessRegistryErrorCode, 'INVALID_DESCRIPTOR'>): HostErrorPayload {
  return { code, message: REGISTRY_MESSAGES[code], recoverable: true };
}

/** Host `WorkspaceError::acp_refused` / `acp_sign_in_required` payloads. */
const START_REFUSALS = {
  ACP_TRUST_REQUIRED: 'Review and trust this agent in Settings → Harnesses before starting it.',
  ACP_VERSION_UNCONFIRMED: "Confirm this agent's version in Settings → Harnesses before starting it.",
  UNAVAILABLE: 'The selected harness is unavailable. Check it in Settings → Harnesses.',
  ACP_SIGN_IN_REQUIRED: 'Sign in to this agent with its own app, then try again. Settings → Harnesses shows how.',
} as const;

function startRefusal(code: keyof typeof START_REFUSALS): HostErrorPayload {
  return { code, message: START_REFUSALS[code], recoverable: true };
}

function parseCore(text: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareCore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** `version_report` */
function versionReport(descriptor: AcpAgentDescriptorV1, output: string): VersionReport {
  let pattern = DEFAULT_VERSION_PATTERN;
  try {
    if (descriptor.version.pattern !== undefined) pattern = new RegExp(descriptor.version.pattern);
  } catch {
    return { status: 'unrecognized' };
  }
  const match = pattern.exec(output);
  const version = (match?.[1] ?? match?.[0])?.trim();
  if (version === undefined || version === '' || version.length > 64) return { status: 'unrecognized' };
  const core = parseCore(version);
  if (core === undefined) return { version, status: 'unrecognized' };
  const range = descriptor.version.verified;
  if (range === undefined) return { version, status: 'no-verified-range' };
  const minimum = parseCore(range.minimum) ?? [0, 0, 0];
  const ceiling = parseCore(range.ceiling) ?? [0, 0, 0];
  if (compareCore(core, minimum) < 0) return { version, status: 'older' };
  if (compareCore(core, ceiling) >= 0) return { version, status: 'newer' };
  return { version, status: 'verified' };
}

const sameLine = (left: CommandLineV1 | undefined, right: CommandLineV1): boolean =>
  left !== undefined && left.program === right.program && left.args.length === right.args.length
  && left.args.every((arg, index) => arg === right.args[index]);

type Refusal = 'unsupported-version' | 'version-unknown' | 'version-unconfirmed';

export class LabAcpRegistry {
  revision: number;
  private readonly users: AcpAgentDescriptorV1[];
  private readonly decisions = new Map<string, Decision>();
  private readonly discovery = new Map<string, Discovery>();
  private readonly signIn = new Map<string, string[]>();
  /** Agents whose first start already asked to sign in. */
  private readonly askedToSignIn = new Set<string>();
  private readonly path: Readonly<Record<string, LabProgram>>;

  constructor(private readonly state: LabState, private readonly bus: LabEventBus, private readonly clock: LabClock) {
    const fresh = state.scenario === 'empty';
    this.path = fresh ? {} : LAB_PATH;
    this.users = fresh ? [] : [QWEN_DESCRIPTOR, LAB_AGENT_DESCRIPTOR];
    if (!fresh) this.decide(LAB_GEMINI_DESCRIPTOR).confirmedVersion = '0.39.1';
    this.revision = fresh ? 0 : 3;
    // Start-up discovery has finished ("earlier"); safe mode runs none.
    if (!state.safeMode) for (const [descriptor, source] of this.descriptors()) this.discover(descriptor, source, false);
    this.syncCatalog();
  }

  // ---- views ------------------------------------------------------------------

  private descriptors(): [AcpAgentDescriptorV1, 'built-in' | 'user'][] {
    return [[LAB_GEMINI_DESCRIPTOR, 'built-in'], ...this.users.map((descriptor): [AcpAgentDescriptorV1, 'user'] => [descriptor, 'user'])];
  }

  private find(id: string): [AcpAgentDescriptorV1, 'built-in' | 'user'] | undefined {
    return this.descriptors().find(([descriptor]) => descriptor.id === id);
  }

  private decision(descriptor: AcpAgentDescriptorV1): Decision | undefined {
    const decision = this.decisions.get(descriptor.id);
    return decision?.fingerprint === labFingerprint(descriptor) ? decision : undefined;
  }

  /** `decision_entry`: the entry of `descriptor`, reset when its fingerprint changed. */
  private decide(descriptor: AcpAgentDescriptorV1): Decision {
    const current = this.decision(descriptor);
    if (current !== undefined) return current;
    const created: Decision = { fingerprint: labFingerprint(descriptor), allowedSecrets: [] };
    this.decisions.set(descriptor.id, created);
    return created;
  }

  private resolve(descriptor: AcpAgentDescriptorV1): Resolution {
    const { program } = descriptor.command;
    const args = descriptor.command.args ?? [];
    const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(program);
    const entry = absolute ? program : this.path[program]?.entry;
    if (entry === undefined) return { ok: false, reason: "The agent's program was not found on PATH." };
    if (/\.(?:cmd|bat|ps1)$/i.test(entry)) {
      return { ok: false, reason: 'This launcher needs a shell, which PiUI never uses. Point the descriptor at the executable or the Node script.' };
    }
    const versionOutput = absolute ? '1.0.0\n' : this.path[program]?.versionOutput ?? '';
    const line = /\.(?:js|mjs|cjs)$/i.test(entry) ? { program: NODE, args: [entry, ...args] } : { program: entry, args: [...args] };
    return { ok: true, line, location: entry, versionOutput };
  }

  private mayExecute(descriptor: AcpAgentDescriptorV1, source: 'built-in' | 'user', resolution: Resolution): boolean {
    return source === 'built-in' || (resolution.ok && sameLine(this.decision(descriptor)?.trustedCommand, resolution.line));
  }

  private discover(descriptor: AcpAgentDescriptorV1, source: 'built-in' | 'user', force: boolean): void {
    const resolution = this.resolve(descriptor);
    const report = resolution.ok && this.mayExecute(descriptor, source, resolution)
      ? versionReport(descriptor, resolution.versionOutput)
      : undefined;
    if (force) this.signIn.delete(descriptor.id);
    this.discovery.set(descriptor.id, { checkedAt: this.clock.iso(), resolution, ...(report ? { report } : {}) });
  }

  /** `version_gate` */
  private versionRefusal(descriptor: AcpAgentDescriptorV1, report: VersionReport): Refusal | undefined {
    switch (report.status) {
      case 'verified': return undefined;
      case 'older': return 'unsupported-version';
      case 'probe-failed':
      case 'unrecognized': return 'version-unknown';
      case 'newer':
      case 'no-verified-range': {
        const confirmed = this.decision(descriptor)?.confirmedVersion;
        return confirmed !== undefined && confirmed === report.version ? undefined : 'version-unconfirmed';
      }
      default: {
        const exhaustive: never = report.status;
        return exhaustive;
      }
    }
  }

  /** `view`: readiness from discovery, trust, the version gate and a remembered sign-in refusal. */
  private readiness(descriptor: AcpAgentDescriptorV1, found: Discovery | undefined, trusted: boolean): [HarnessState, string | undefined] {
    if (found === undefined) return ['checking', CHECKING];
    if (!found.resolution.ok) return ['not-installed', found.resolution.reason];
    if (!trusted) return ['untrusted', "Review and trust this agent's command line in Settings → Harnesses."];
    if (found.report === undefined) return ['checking', CHECKING];
    switch (this.versionRefusal(descriptor, found.report)) {
      case 'unsupported-version': return ['unsupported-version', 'The installed version is older than the versions tested with PiUI.'];
      case 'version-unconfirmed': return ['unverified-version', 'PiUI has not verified this version. Confirm it in Settings → Harnesses to use it.'];
      case 'version-unknown': return ['unavailable', 'The agent did not report a version PiUI can recognize.'];
      default: return this.signIn.has(descriptor.id) ? ['sign-in-required', SIGN_IN_REASON] : ['ready', undefined];
    }
  }

  private entry(descriptor: AcpAgentDescriptorV1, source: 'built-in' | 'user'): AcpAgentEntryV1 {
    const decision = this.decision(descriptor);
    const found = this.discovery.get(descriptor.id);
    const line = found?.resolution.ok ? found.resolution.line : undefined;
    const trusted = source === 'built-in' || (line !== undefined && sameLine(decision?.trustedCommand, line));
    const report = found?.report;
    const [state, reason] = this.readiness(descriptor, found, trusted);
    return {
      descriptor: structuredClone(descriptor),
      source,
      fingerprint: labFingerprint(descriptor),
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(line === undefined ? {} : { commandLine: structuredClone(line) }),
      trusted,
      ...(report?.version === undefined ? {} : { version: report.version }),
      ...(report === undefined ? {} : { versionStatus: report.status }),
      ...(decision?.confirmedVersion === undefined ? {} : { confirmedVersion: decision.confirmedVersion }),
      secretEnvironment: secretEnvironment(descriptor),
      allowedSecrets: [...(decision?.allowedSecrets ?? [])],
      authMethods: [...(this.signIn.get(descriptor.id) ?? [])],
      ...(found === undefined ? {} : { checkedAt: found.checkedAt }),
    };
  }

  agents(): AcpAgentEntryV1[] {
    return this.descriptors().map(([descriptor, source]) => this.entry(descriptor, source));
  }

  /** `acp_status` */
  private status(agent: AcpAgentEntryV1): HarnessStatusV1 {
    const { descriptor, commandLine } = agent;
    const first = commandLine?.args[0];
    const verified = descriptor.version.verified;
    return {
      harness: acpHarnessId(descriptor.id),
      name: descriptor.displayName,
      source: agent.source === 'built-in' ? 'acp-built-in' : 'acp-user',
      state: agent.state,
      ...(commandLine === undefined ? {} : { location: first !== undefined && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(first) ? first : commandLine.program }),
      ...(agent.version === undefined ? {} : { version: agent.version }),
      ...(verified === undefined ? {} : { verifiedVersions: `${verified.minimum} – <${verified.ceiling}` }),
      ...(agent.reason === undefined ? {} : { reason: agent.reason }),
      ...(descriptor.authHint === undefined ? {} : { signInHint: descriptor.authHint }),
      authMethods: [...agent.authMethods],
      ...(descriptor.docsUrl === undefined ? {} : { docsUrl: descriptor.docsUrl }),
    };
  }

  private builtinStatus(summary: HarnessSummary): HarnessStatusV1 | undefined {
    const kind = summary.kind;
    if (!isBuiltinHarness(kind)) return undefined;
    const state: HarnessState = summary.status === 'available'
      ? kind === 'claude-code' && summary.reason === CLAUDE_SIGN_IN_MESSAGE ? 'sign-in-required' : 'ready'
      : summary.status === 'unverified' ? 'unsupported-version' : 'not-installed';
    const hint = BUILTIN_SIGN_IN[kind];
    const verified = BUILTIN_VERIFIED[kind];
    return {
      harness: kind,
      name: summary.name,
      source: 'built-in',
      state,
      ...(summary.installed ? { location: BUILTIN_LOCATIONS[kind] } : {}),
      ...(summary.version === undefined ? {} : { version: summary.version }),
      ...(verified === undefined ? {} : { verifiedVersions: verified }),
      ...(summary.reason === undefined ? {} : { reason: summary.reason }),
      ...(hint === undefined ? {} : { signInHint: hint }),
    };
  }

  view(): HarnessRegistryV1 {
    const agents = this.agents();
    const builtins = this.state.harnesses.flatMap((summary) => this.builtinStatus(summary) ?? []);
    return {
      protocol: 1,
      revision: this.revision,
      safeMode: this.state.safeMode,
      checked: this.descriptors().every(([descriptor]) => this.discovery.has(descriptor.id)),
      harnesses: [...builtins, ...agents.map((agent) => this.status(agent))],
      agents,
    };
  }

  /** `summaries`: the workspace catalog rows of ACP agents. */
  private syncCatalog(): void {
    const rows = this.agents().map((agent): HarnessSummary => {
      const status = agent.state === 'ready' || agent.state === 'sign-in-required'
        ? 'available'
        : agent.state === 'unverified-version' || agent.state === 'untrusted' || agent.state === 'unsupported-version'
          ? 'unverified'
          : 'unavailable';
      return {
        kind: acpHarnessId(agent.descriptor.id),
        name: agent.descriptor.displayName,
        installed: agent.commandLine !== undefined,
        ...(agent.version === undefined ? {} : { version: agent.version }),
        status,
        ...(agent.state === 'ready' || agent.reason === undefined ? {} : { reason: agent.reason }),
      };
    });
    this.state.harnesses = [...this.state.harnesses.filter((summary) => !isAcpHarness(summary.kind)), ...rows];
  }

  private changed(): void {
    this.syncCatalog();
    this.bus.emit(HARNESS_REGISTRY_EVENT_V1, { protocol: 1, revision: this.revision });
  }

  // ---- commands ---------------------------------------------------------------

  private transact(expectedRevision: number, change: () => void): void {
    if (expectedRevision !== this.revision) throw new RegistryFailure('CONFLICT', REGISTRY_MESSAGES.CONFLICT);
    change();
    this.revision += 1;
  }

  async run(command: HarnessRegistryCommandV1): Promise<HarnessRegistryV1> {
    if (command.type !== 'list' && this.state.safeMode) throw registryFailure('SAFE_MODE');
    try {
      await this.apply(command);
    } catch (error) {
      if (error instanceof RegistryFailure) {
        throw { code: error.code, message: error.message, recoverable: true } satisfies HostErrorPayload;
      }
      throw error;
    }
    return this.view();
  }

  private async apply(command: HarnessRegistryCommandV1): Promise<void> {
    switch (command.type) {
      case 'list':
        return;
      case 'check': {
        // Built-in discovery is recomputed by every list.
        if (command.harness !== undefined && !isAcpHarness(command.harness)) return;
        const only = command.harness === undefined ? undefined : acpAgentId(command.harness);
        await this.clock.delay(CHECK_LATENCY_MS);
        for (const [descriptor, source] of this.descriptors()) {
          if (only === undefined || descriptor.id === only) this.discover(descriptor, source, true);
        }
        this.changed();
        return;
      }
      case 'add': {
        const checked = checkAcpDescriptor(command.descriptor);
        if (!checked.ok) throw new RegistryFailure('INVALID_DESCRIPTOR', checked.message);
        const descriptor = checked.descriptor;
        this.transact(command.expectedRevision, () => {
          if (this.find(descriptor.id) !== undefined) throw new RegistryFailure('DUPLICATE', REGISTRY_MESSAGES.DUPLICATE);
          if (this.users.length >= MAX_USER_AGENTS) throw new RegistryFailure('LIMIT', REGISTRY_MESSAGES.LIMIT);
          this.decisions.delete(descriptor.id);
          this.users.push(descriptor);
        });
        // Resolution only: nothing runs before trust.
        this.discover(descriptor, 'user', false);
        this.changed();
        return;
      }
      case 'trust': {
        const found = this.find(command.id);
        if (found === undefined) throw new RegistryFailure('NOT_FOUND', REGISTRY_MESSAGES.NOT_FOUND);
        const [descriptor, source] = found;
        if (source === 'built-in') throw new RegistryFailure('BUILT_IN', REGISTRY_MESSAGES.BUILT_IN);
        if (labFingerprint(descriptor) !== command.fingerprint) throw new RegistryFailure('TRUST_CHANGED', REGISTRY_MESSAGES.TRUST_CHANGED);
        const resolution = this.resolve(descriptor);
        if (!resolution.ok) throw new RegistryFailure('NOT_INSTALLED', REGISTRY_MESSAGES.NOT_INSTALLED);
        if (!sameLine(resolution.line, command.commandLine)) throw new RegistryFailure('TRUST_CHANGED', REGISTRY_MESSAGES.TRUST_CHANGED);
        this.transact(command.expectedRevision, () => {
          this.decide(descriptor).trustedCommand = structuredClone(resolution.line);
        });
        // The trusted program runs once for its version.
        await this.clock.delay(TRUST_LATENCY_MS);
        this.discover(descriptor, source, false);
        this.changed();
        return;
      }
      case 'confirmVersion': {
        const found = this.find(command.id);
        if (found === undefined) throw new RegistryFailure('NOT_FOUND', REGISTRY_MESSAGES.NOT_FOUND);
        const [descriptor] = found;
        const report = this.discovery.get(descriptor.id)?.report;
        const confirmable = report !== undefined && (report.status === 'newer' || report.status === 'no-verified-range')
          && report.version === command.version;
        if (!confirmable) throw new RegistryFailure('NOTHING_TO_CONFIRM', REGISTRY_MESSAGES.NOTHING_TO_CONFIRM);
        this.transact(command.expectedRevision, () => {
          this.decide(descriptor).confirmedVersion = command.version;
        });
        this.changed();
        return;
      }
      case 'allowSecrets': {
        const found = this.find(command.id);
        if (found === undefined) throw new RegistryFailure('NOT_FOUND', REGISTRY_MESSAGES.NOT_FOUND);
        const [descriptor] = found;
        if (labFingerprint(descriptor) !== command.fingerprint) throw new RegistryFailure('TRUST_CHANGED', REGISTRY_MESSAGES.TRUST_CHANGED);
        const secrets = secretEnvironment(descriptor);
        if (command.names.some((name) => !secrets.includes(name))) {
          throw new RegistryFailure('NOTHING_TO_CONFIRM', REGISTRY_MESSAGES.NOTHING_TO_CONFIRM);
        }
        const allowed = [...new Set(command.names)].sort();
        this.transact(command.expectedRevision, () => {
          this.decide(descriptor).allowedSecrets = allowed;
        });
        this.changed();
        return;
      }
      case 'remove': {
        if (command.id === LAB_GEMINI_DESCRIPTOR.id) throw new RegistryFailure('BUILT_IN', REGISTRY_MESSAGES.BUILT_IN);
        this.transact(command.expectedRevision, () => {
          const index = this.users.findIndex((descriptor) => descriptor.id === command.id);
          if (index < 0) throw new RegistryFailure('NOT_FOUND', REGISTRY_MESSAGES.NOT_FOUND);
          this.users.splice(index, 1);
          this.decisions.delete(command.id);
        });
        this.discovery.delete(command.id);
        this.signIn.delete(command.id);
        this.askedToSignIn.delete(command.id);
        this.changed();
        return;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  // ---- starts -------------------------------------------------------------------

  /** `AcpAgents::launch` + the bridge's sign-in refusal, for `acp:<id>` starts. */
  assertStartable(id: string): void {
    const found = this.find(id);
    if (found === undefined) throw startRefusal('UNAVAILABLE');
    const [descriptor, source] = found;
    // A start resolves and probes on demand when discovery has not run yet.
    if (!this.discovery.has(descriptor.id)) this.discover(descriptor, source, false);
    const agent = this.entry(descriptor, source);
    switch (agent.state) {
      case 'untrusted': throw startRefusal('ACP_TRUST_REQUIRED');
      case 'unverified-version': throw startRefusal('ACP_VERSION_UNCONFIRMED');
      case 'ready':
      case 'sign-in-required':
        break;
      default: throw startRefusal('UNAVAILABLE');
    }
    const methods = SIGN_IN_ON_FIRST_START[descriptor.id];
    if (methods !== undefined && !this.askedToSignIn.has(descriptor.id)) {
      // The agent answered `auth_required`; the next start asks it again.
      this.askedToSignIn.add(descriptor.id);
      this.signIn.set(descriptor.id, [...methods]);
      this.changed();
      throw startRefusal('ACP_SIGN_IN_REQUIRED');
    }
    if (this.signIn.delete(descriptor.id)) this.changed();
  }
}

const registries = new WeakMap<LabState, LabAcpRegistry>();

/** Starts of `acp:<id>` harnesses pass the registry's trust, version and sign-in checks first. */
export function assertAcpStartable(state: LabState, harness: HarnessKind): void {
  if (!isAcpHarness(harness)) return;
  const registry = registries.get(state);
  if (registry === undefined) throw startRefusal('UNAVAILABLE');
  registry.assertStartable(acpAgentId(harness));
}

/** "Agent default" keeps the agent's own configured model. */
export function isAgentDefault(harness: HarnessKind, model: WorkspaceModel): boolean {
  return isAcpHarness(harness) && model.id === ACP_DEFAULT_MODEL && model.provider === undefined;
}

// ---- IPC ------------------------------------------------------------------------

const agentId: Schema = custom((value) => ACP_AGENT_ID.test(value)
  ? undefined
  : 'an ACP agent id is a lowercase slug of 1-32 letters, digits and inner hyphens');
const commandLine = object({ program: string, args: arrayOf(string) });

const registryCommandSchema = tagged('type', {
  list: {},
  check: { harness: option(harnessIdentitySchema) },
  add: { expectedRevision: u64, descriptor: json },
  trust: { expectedRevision: u64, id: agentId, fingerprint: string, commandLine },
  confirmVersion: { expectedRevision: u64, id: agentId, version: string },
  allowSecrets: { expectedRevision: u64, id: agentId, fingerprint: string, names: arrayOf(string) },
  remove: { expectedRevision: u64, id: agentId },
});

const sessionModeRequestSchema = object({ sessionId: string, modeId: string });

/** `workspace_session_mode_v1` */
function setSessionMode(runtime: LabSessions, request: SessionModeRequestV1): SessionModeResultV1 {
  const { state } = runtime;
  if (state.safeMode) throw workspaceFailure('SAFE_MODE');
  if (!validToken(request.modeId)) throw workspaceFailure('INVALID_ARGUMENT');
  const record = authorizeLive(state, request.sessionId);
  const live = requireLive(record);
  if (!isAcpHarness(record.harness) || !ACP_LAB_MODES.some((mode) => mode.id === request.modeId)) throw workspaceFailure('NOT_SUPPORTED');
  if (live.status === 'failed') throw workspaceFailure('RUNTIME_FAILED');
  record.mode = request.modeId;
  return {
    protocol: 1,
    sessionId: request.sessionId,
    modes: { current: request.modeId, available: ACP_LAB_MODES.map((mode) => ({ ...mode })) },
  };
}

export function acpHandlers(runtime: LabSessions, bus: LabEventBus): LabHandlers {
  const registry = new LabAcpRegistry(runtime.state, bus, runtime.clock);
  registries.set(runtime.state, registry);
  return {
    harness_registry_v1: (args) => registry.run(decodeArgument<HarnessRegistryCommandV1>(args, 'command', registryCommandSchema)),
    workspace_session_mode_v1: (args) =>
      setSessionMode(runtime, decodeArgument<SessionModeRequestV1>(args, 'request', sessionModeRequestSchema)),
  };
}
