import type { Harness, PermissionMode, ResourceRule } from '../../../../contracts/orchestration-v6';
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
}
export type HarnessConfigurations = Readonly<Record<Harness, HarnessConfiguration>>;
