import type { PermissionMode, ResourceRule } from '../../../../contracts/orchestration-v6';
import type { BuiltinHarness } from '../../../../contracts/harness-identity-v2';
/**
 * How a single-call `llm` step (orchestration v6.2) runs on a harness.
 * - `disabled`: the adapter starts the turn with an empty native tool
 *   allowlist that the harness enforces, so no tool runs.
 * - `read-only-sandbox`: the harness cannot turn its tools off; only its
 *   read-only sandbox (and denied network) bounds them.
 * A manifest without `oneShot` cannot run such a step read-only; the host
 * refuses it before starting anything.
 */
export interface OneShotSupport {
  readonly tools: 'disabled' | 'read-only-sandbox';
  /** User-visible explanation. It is never a stronger claim than `tools`. */
  readonly note: string;
}
/** Presentation manifest owned by each adapter. Host validation remains authoritative. */
export interface HarnessConfiguration {
  readonly name: string;
  readonly reasoningExamples: readonly string[];
  readonly speed: boolean;
  readonly basePrompt: boolean;
  readonly permissionModes: readonly PermissionMode[];
  readonly defaultPermission: PermissionMode;
  readonly resourceKinds: readonly ResourceRule['kind'][];
  readonly skillIdentifier: 'path' | 'name';
  readonly nativeTools: readonly string[];
  readonly filesystemSandbox: boolean;
  readonly networkAccess: boolean;
  /** User-visible native limitations. They are never a sandbox claim. */
  readonly limitations?: readonly string[];
  readonly oneShot?: OneShotSupport;
}
/** Built-in adapters only; ACP agents share one generic manifest (`harnessConfiguration`). */
export type HarnessConfigurations = Readonly<Record<BuiltinHarness, HarnessConfiguration>>;
