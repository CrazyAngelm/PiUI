/**
 * PiUI harness registry protocol v1 (ADR-034): Settings → Harnesses.
 *
 * One command, `harness_registry_v1`, lists every harness (built-in adapters
 * and ACP agents) with its readiness, detected location, version and verified
 * range, and manages ACP agents: add a user descriptor, trust its exact command
 * line, confirm secret-like environment names, remove it, check again. Listing
 * never runs an agent; checks and changes are refused in safe mode. Credentials,
 * environment values and auth files never cross this boundary: descriptors carry
 * variable names only and sign-in happens in each harness's own flow.
 *
 * Versions are advisory (ADR-043, additive within protocol 1): a harness whose
 * version is newer than the tested range, has no declared range, or cannot be
 * read is `ready` and reports `versionStatus`; only a version older than the
 * minimum is `unsupported-version`. Version confirmation is retired:
 * `unverified-version` and `confirmVersion` stay in the types for older
 * consumers but are never produced and never record anything.
 */
import type { HarnessId } from './harness-identity-v2';

export const HARNESS_REGISTRY_PROTOCOL = 1 as const;
/** Emitted after discovery or a registry change; payload `HarnessRegistryChangedV1`. */
export const HARNESS_REGISTRY_EVENT_V1 = 'piui://harness-registry-v1' as const;

/** `contracts/acp-agent-descriptor-v1.schema.json`. */
export interface AcpAgentDescriptorV1 {
  schemaVersion: 1;
  id: string;
  displayName: string;
  command: { program: string; args?: string[] };
  /**
   * `verified` is the tested range `minimum <= version < ceiling`: the minimum is enforced (an older
   * agent never starts), the ceiling is advisory (a newer agent starts and reports `versionStatus: 'newer'`).
   */
  version: { args: string[]; pattern?: string; verified?: { minimum: string; ceiling: string } };
  environment?: string[];
  authHint?: string;
  docsUrl?: string;
  /** Restrictions only: each present field is `false`. */
  capabilities?: { loadSession?: false; models?: false; modes?: false; mcpHttp?: false };
}

export type HarnessState =
  | 'ready'
  | 'checking'
  | 'not-installed'
  /** Older than the descriptor's declared minimum. */
  | 'unsupported-version'
  /** @deprecated ADR-043: never produced; a version needs no confirmation. */
  | 'unverified-version'
  | 'sign-in-required'
  | 'untrusted'
  | 'unavailable';

/**
 * Advisory result of the version probe. Only `older` prevents a start; `newer` is above the tested
 * ceiling (UI: "Newer than tested"); the other values make no claim.
 */
export type AcpVersionStatus = 'verified' | 'no-verified-range' | 'newer' | 'older' | 'unrecognized' | 'probe-failed';

export interface CommandLineV1 { program: string; args: string[] }

export interface HarnessStatusV1 {
  harness: HarnessId;
  name: string;
  /** `acp-plugin` (additive, ADR-032): an enabled plugin's ACP agent. */
  source: 'built-in' | 'acp-built-in' | 'acp-user' | 'acp-plugin';
  state: HarnessState;
  /** Detected executable or entry script (display only). */
  location?: string;
  version?: string;
  /** Tested versions, for display (`0.147.0 – 0.157.x`). */
  verifiedVersions?: string;
  /**
   * Advisory (ADR-043, additive): `newer` is above the tested range and the harness still starts
   * (UI: "Newer than tested"). Absent when the harness cannot start or declares no tested range.
   */
  versionStatus?: 'verified' | 'newer';
  /** Fixed English locale key; never native output. */
  reason?: string;
  /** Guidance without secrets: the descriptor's hint or a fixed built-in text. */
  signInHint?: string;
  /** Sign-in method names an ACP agent reported when it refused to start. */
  authMethods?: string[];
  docsUrl?: string;
}

export interface AcpAgentEntryV1 {
  descriptor: AcpAgentDescriptorV1;
  /** `plugin` (additive, ADR-032): trusted like a user agent, removed with its plugin. */
  source: 'built-in' | 'user' | 'plugin';
  /** The plugin that contributes the agent (`source: 'plugin'` only). */
  plugin?: { id: string; name: string };
  /** Trust and confirmations bind to this descriptor fingerprint. */
  fingerprint: string;
  state: HarnessState;
  reason?: string;
  /** The exact command line PiUI starts (never a shell), when it resolves. */
  commandLine?: CommandLineV1;
  trusted: boolean;
  version?: string;
  versionStatus?: AcpVersionStatus;
  /** @deprecated ADR-043: never produced. A stored legacy confirmation is ignored by the host. */
  confirmedVersion?: string;
  /** Secret-like environment names; each passes only after a confirmation. */
  secretEnvironment: string[];
  allowedSecrets: string[];
  authMethods: string[];
  checkedAt?: string;
}

export interface HarnessRegistryV1 {
  protocol: 1;
  /** Registry document revision; every change names it (`expectedRevision`). */
  revision: number;
  safeMode: boolean;
  /** Discovery has run for every ACP agent in this host process. */
  checked: boolean;
  harnesses: HarnessStatusV1[];
  agents: AcpAgentEntryV1[];
}

export type HarnessRegistryCommandV1 =
  | { type: 'list' }
  | { type: 'check'; harness?: HarnessId }
  | { type: 'add'; expectedRevision: number; descriptor: AcpAgentDescriptorV1 }
  | { type: 'trust'; expectedRevision: number; id: string; fingerprint: string; commandLine: CommandLineV1 }
  /** @deprecated ADR-043: retired; the host always answers `NOTHING_TO_CONFIRM` and records nothing. */
  | { type: 'confirmVersion'; expectedRevision: number; id: string; version: string }
  | { type: 'allowSecrets'; expectedRevision: number; id: string; fingerprint: string; names: string[] }
  | { type: 'remove'; expectedRevision: number; id: string };

export type HarnessRegistryErrorCode =
  | 'SAFE_MODE' | 'CONFLICT' | 'INVALID_DESCRIPTOR' | 'DUPLICATE' | 'NOT_FOUND' | 'BUILT_IN'
  | 'TRUST_CHANGED' | 'NOT_INSTALLED' | 'NOTHING_TO_CONFIRM' | 'LIMIT' | 'IO_ERROR'
  /** Additive (ADR-032): a plugin's agent is removed with its plugin. */
  | 'PLUGIN_OWNED';

export interface HarnessRegistryErrorV1 { code: HarnessRegistryErrorCode; message: string; recoverable: boolean }

export interface HarnessRegistryChangedV1 { protocol: 1; revision: number }
