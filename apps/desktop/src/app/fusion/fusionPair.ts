import type { HarnessKind, PermissionMode, WorkspaceModel } from '../../../../../contracts/workspace-v15';
import {
  DEFAULT_FUSION_OPTIONS,
  fusionError,
  type FusionOptionsV1,
  type FusionPairV1,
  type FusionRefusalV1,
  type FusionRoleNameV1,
  type FusionRoleV1,
} from '../../host-api/fusionClient';

/**
 * Pure helpers of the Fusion pair picker (ADR-043). The host (`checkPair`)
 * decides whether a pair can start; this module only builds the pair and
 * words the host's answer. Every returned string is an English locale key.
 */

/** Harnesses that can lead a Fusion chat (they register the host tool `sidekick`). */
export const FUSION_LEADS = ['claude-code', 'codex'] as const satisfies readonly HarnessKind[];
/** Harnesses that can be the persistent sidekick. */
export const FUSION_SIDEKICKS = ['claude-code', 'codex', 'pi'] as const satisfies readonly HarnessKind[];

export const FUSION_PERMISSION_MODES = ['native', 'read-only', 'workspace-write', 'full-access'] as const satisfies readonly PermissionMode[];

export interface FusionPermissionChoice {
  value: PermissionMode;
  /** English locale keys (shared with the new-chat composer). */
  label: string;
  description: string;
}

export const FUSION_PERMISSION_CHOICES: readonly FusionPermissionChoice[] = [
  { value: 'native', label: 'Harness settings', description: 'Use the permissions configured in the harness' },
  { value: 'read-only', label: 'Read only', description: 'The agent can read but not change files' },
  { value: 'workspace-write', label: 'Edit project', description: 'Changes limited to the project folder' },
  { value: 'full-access', label: 'Full access', description: 'No native restrictions — use with care' },
];

export const isFusionLead = (harness: HarnessKind | string): harness is (typeof FUSION_LEADS)[number] =>
  (FUSION_LEADS as readonly string[]).includes(harness);

export const isFusionSidekick = (harness: HarnessKind | string): harness is (typeof FUSION_SIDEKICKS)[number] =>
  (FUSION_SIDEKICKS as readonly string[]).includes(harness);

/**
 * Harnesses without a native sandbox (Pi) can only run with full access, and a
 * sidekick may never exceed its lead, so a Pi sidekick starts with both roles
 * at full access. Everything else starts with an explicit "Edit project" so a
 * cross-harness pair is accepted without a native-defaults refusal.
 */
export function defaultPermissionModes(sidekick: HarnessKind): { lead: PermissionMode; sidekick: PermissionMode } {
  return sidekick === 'pi' ? { lead: 'full-access', sidekick: 'full-access' } : { lead: 'workspace-write', sidekick: 'workspace-write' };
}

/**
 * The pair a fresh picker starts with: a lead and, when possible, a sidekick
 * of the other vendor (cross-vendor pairs are the point of Fusion). Returns
 * undefined while no harness can lead.
 */
export function defaultPair(available: readonly HarnessKind[]): FusionPairV1 | undefined {
  const lead = FUSION_LEADS.find((kind) => available.includes(kind));
  if (lead === undefined) return undefined;
  const sidekick =
    FUSION_SIDEKICKS.find((kind) => kind !== lead && available.includes(kind)) ??
    FUSION_SIDEKICKS.find((kind) => available.includes(kind)) ??
    lead;
  const modes = defaultPermissionModes(sidekick);
  return {
    lead: { harness: lead, permissionMode: modes.lead },
    sidekick: { harness: sidekick, permissionMode: modes.sidekick },
    options: { ...DEFAULT_FUSION_OPTIONS },
  };
}

/** A role on another harness: its model and reasoning belong to the old harness and are dropped. */
export function withHarness(role: FusionRoleV1, harness: HarnessKind): FusionRoleV1 {
  if (role.harness === harness) return role;
  return { harness, permissionMode: role.permissionMode };
}

/** A role with another model; the reasoning level stays only when the model offers it. */
export function withModel(role: FusionRoleV1, model: WorkspaceModel | undefined): FusionRoleV1 {
  const level = role.thinkingLevel !== undefined && model?.thinkingLevels?.includes(role.thinkingLevel) ? role.thinkingLevel : undefined;
  return {
    harness: role.harness,
    permissionMode: role.permissionMode,
    ...(model ? { model } : {}),
    ...(level !== undefined ? { thinkingLevel: level } : {}),
  };
}

export function withThinkingLevel(role: FusionRoleV1, level: string): FusionRoleV1 {
  const next: FusionRoleV1 = { harness: role.harness, permissionMode: role.permissionMode, ...(role.model ? { model: role.model } : {}) };
  return level ? { ...next, thinkingLevel: level } : next;
}

export function withPermission(role: FusionRoleV1, permissionMode: PermissionMode): FusionRoleV1 {
  return role.permissionMode === permissionMode ? role : { ...role, permissionMode };
}

export function withOptions(pair: FusionPairV1, options: Partial<FusionOptionsV1>): FusionPairV1 {
  return { ...pair, options: { ...pair.options, ...options } };
}

/** The pair with one more selection; an old harness's model never travels to a new harness. */
export function withRole(pair: FusionPairV1, role: FusionRoleNameV1, value: FusionRoleV1): FusionPairV1 {
  return role === 'lead' ? { ...pair, lead: value } : { ...pair, sidekick: value };
}

/** A stable key of the pair, to drop repeated checks and answers of an older pair. */
export function pairKey(pair: FusionPairV1): string {
  const role = (value: FusionRoleV1): unknown[] => [
    value.harness,
    value.permissionMode,
    value.model?.provider ?? null,
    value.model?.id ?? null,
    value.thinkingLevel ?? null,
  ];
  const { briefPolicy, pushback, autoDeliver, leadNativeSubagents } = pair.options;
  return JSON.stringify([role(pair.lead), role(pair.sidekick), briefPolicy, pushback, autoDeliver, leadNativeSubagents]);
}

/** The pair a project remembers between starts; models are not kept (catalogs change). */
export function rememberablePair(pair: FusionPairV1): string {
  const role = (value: FusionRoleV1): FusionRoleV1 => ({ harness: value.harness, permissionMode: value.permissionMode });
  return JSON.stringify({ lead: role(pair.lead), sidekick: role(pair.sidekick), options: pair.options });
}

const isMode = (value: unknown): value is PermissionMode => (FUSION_PERMISSION_MODES as readonly unknown[]).includes(value);

/**
 * The remembered pair if it is still valid and its harnesses are available;
 * anything else returns undefined and the caller starts from the default.
 */
export function restorePair(raw: string | null, available: readonly HarnessKind[]): FusionPairV1 | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { lead, sidekick, options } = value as Record<string, unknown>;
  const role = (candidate: unknown, allowed: (harness: string) => boolean): FusionRoleV1 | undefined => {
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const { harness, permissionMode } = candidate as Record<string, unknown>;
    if (typeof harness !== 'string' || !allowed(harness) || !available.includes(harness as HarnessKind) || !isMode(permissionMode)) return undefined;
    return { harness: harness as HarnessKind, permissionMode };
  };
  const leadRole = role(lead, isFusionLead);
  const sidekickRole = role(sidekick, isFusionSidekick);
  if (!leadRole || !sidekickRole || typeof options !== 'object' || options === null) return undefined;
  const { briefPolicy, pushback, autoDeliver, leadNativeSubagents } = options as Record<string, unknown>;
  return {
    lead: leadRole,
    sidekick: sidekickRole,
    options: {
      briefPolicy: briefPolicy === 'outline' ? 'outline' : 'prescriptive',
      pushback: pushback === true,
      autoDeliver: autoDeliver !== false,
      leadNativeSubagents: leadNativeSubagents === true,
    },
  };
}

export interface RefusalCopy {
  /** What is wrong, as an English locale key. */
  title: string;
  /** What the person can change, as an English locale key. */
  hint: string;
}

/** The English locale key of a role name ("Lead" / "Sidekick"). */
export function roleLabel(role: FusionRoleNameV1): string {
  switch (role) {
    case 'lead':
      return 'Lead';
    case 'sidekick':
      return 'Sidekick';
    default:
      return assertNever(role);
  }
}

/** Words for each host refusal of a pair. The role says which column to look at. */
export function refusalCopy(refusal: FusionRefusalV1): RefusalCopy {
  switch (refusal) {
    case 'lead-harness-unsupported':
      return {
        title: 'This harness cannot lead a Fusion chat.',
        hint: 'Choose Claude Code or Codex as the lead.',
      };
    case 'sidekick-harness-unsupported':
      return {
        title: 'This harness cannot be the sidekick.',
        hint: 'Choose Claude Code, Codex or Pi as the sidekick.',
      };
    case 'explicit-modes-required':
      return {
        title: 'Both roles need a concrete permission mode.',
        hint: 'A pair cannot rely on "Harness settings": pick Read only, Edit project or Full access for the lead and the sidekick.',
      };
    case 'sidekick-exceeds-lead':
      return {
        title: 'The sidekick would be allowed more than the lead.',
        hint: 'Lower the sidekick permissions or raise the lead permissions.',
      };
    case 'sidekick-needs-full-access':
      return {
        title: 'This sidekick can only run with full access.',
        hint: 'Claude Code cannot answer its own command approvals in Edit project mode, and Pi has no edit-only mode. Use Full access (or Native with a Claude Code lead), or choose another sidekick.',
      };
    case 'codex-sandbox-unverified':
      return {
        title: 'The Codex sandbox could not be verified on this computer.',
        hint: 'Choose another harness for this role, or use Full access if you accept that.',
      };
    case 'read-only-lead':
      return {
        title: 'A read-only lead cannot review or take over the sidekick work.',
        hint: 'Give the lead at least the Edit project permission.',
      };
    default:
      return assertNever(refusal);
  }
}

/** The English locale key for a failed Fusion command (host error text never reaches the UI). */
export function fusionErrorText(error: unknown): string {
  const code = fusionError(error).code;
  switch (code) {
    case 'SAFE_MODE':
      return 'Safe mode is on, so Fusion cannot change anything. Restart PiUI without safe mode.';
    case 'INVALID_ARGUMENT':
      return 'The host did not accept this request.';
    case 'NOT_FOUND':
      return 'This Fusion chat or round no longer exists.';
    case 'CONFLICT':
      return 'The state changed meanwhile. Try again.';
    case 'NOT_SUPPORTED':
      return 'This action is not available here.';
    case 'IO_ERROR':
      return 'The host could not save the Fusion state.';
    case 'SIGN_IN_REQUIRED':
      return 'Sign in to the harness first, then try again.';
    case 'unknown':
      return 'The Fusion action could not be completed.';
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Fusion value: ${String(value)}`);
}
