/**
 * PiUI harness registry protocol v1 (ADR-034): Settings → Harnesses.
 *
 * One command, `harness_registry_v1`, lists every harness (built-in adapters
 * and ACP agents) with its readiness, detected location, version and verified
 * range, and manages ACP agents: add a user descriptor, trust its exact command
 * line, confirm an unverified version or secret-like environment names, remove
 * it, check again. Listing never runs an agent; checks and changes are refused
 * in safe mode. Credentials, environment values and auth files never cross this
 * boundary: descriptors carry variable names only and sign-in happens in each
 * harness's own flow.
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
  | 'unsupported-version'
  | 'unverified-version'
  | 'sign-in-required'
  | 'untrusted'
  | 'unavailable';

export type AcpVersionStatus = 'verified' | 'no-verified-range' | 'newer' | 'older' | 'unrecognized' | 'probe-failed';

export interface CommandLineV1 { program: string; args: string[] }

export interface HarnessStatusV1 {
  harness: HarnessId;
  name: string;
  source: 'built-in' | 'acp-built-in' | 'acp-user';
  state: HarnessState;
  /** Detected executable or entry script (display only). */
  location?: string;
  version?: string;
  /** Tested versions, for display (`0.147.0 – 0.157.x`). */
  verifiedVersions?: string;
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
  source: 'built-in' | 'user';
  /** Trust and confirmations bind to this descriptor fingerprint. */
  fingerprint: string;
  state: HarnessState;
  reason?: string;
  /** The exact command line PiUI starts (never a shell), when it resolves. */
  commandLine?: CommandLineV1;
  trusted: boolean;
  version?: string;
  versionStatus?: AcpVersionStatus;
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
  | { type: 'confirmVersion'; expectedRevision: number; id: string; version: string }
  | { type: 'allowSecrets'; expectedRevision: number; id: string; fingerprint: string; names: string[] }
  | { type: 'remove'; expectedRevision: number; id: string };

export type HarnessRegistryErrorCode =
  | 'SAFE_MODE' | 'CONFLICT' | 'INVALID_DESCRIPTOR' | 'DUPLICATE' | 'NOT_FOUND' | 'BUILT_IN'
  | 'TRUST_CHANGED' | 'NOT_INSTALLED' | 'NOTHING_TO_CONFIRM' | 'LIMIT' | 'IO_ERROR';

export interface HarnessRegistryErrorV1 { code: HarnessRegistryErrorCode; message: string; recoverable: boolean }

export interface HarnessRegistryChangedV1 { protocol: 1; revision: number }
