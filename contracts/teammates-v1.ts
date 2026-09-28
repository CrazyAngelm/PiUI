/**
 * PiUI teammates protocol v1 (`teammates_command_v1`, ADR-041, docs/BOARD.md).
 *
 * A teammate is a named, project-scoped address (`@handle`) that always
 * resolves to exactly one saved launch command of its project. It is stored
 * in the project's orchestration document (`WorkspaceOrchestration.teammates`,
 * additive) and saved/deleted in the same transaction as the definitions it
 * manages. Portable system files are unchanged (no v5): a teammate is
 * project-local addressing and automation metadata.
 *
 * - `simple`: the host generates one profile, a one-member team, a one-step
 *   pipeline with a `card` long-text input and a launch command, all marked
 *   `managedByTeammateId`. They are ordinary definitions (visible in the
 *   Pipelines list as "managed by @handle"); runs keep frozen-snapshot
 *   semantics.
 * - `pipeline`: wraps an existing launch command; nothing is generated.
 *
 * `list` works in safe mode; every change is refused there (`SAFE_MODE`).
 */
import type {
  Harness,
  OrchestrationId,
  PermissionMode,
} from './orchestration-v6';
import type { BoardPermissionsV1 } from './board-v1';

export const TEAMMATES_PROTOCOL = 1 as const;
export const TEAMMATES_CHANGED_EVENT_V1 = 'piui://teammates-changed-v1' as const;

export type TeammateIdV1 = string;

/** `^[a-z0-9][a-z0-9-]{1,31}$`, unique per project. */
export const TEAMMATE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const MAX_TEAMMATES_PER_WORKSPACE = 64;
export const MAX_TEAMMATE_ROLE_CHARS = 500;

export type TeammateKindV1 =
  | { type: 'simple'; profileId: OrchestrationId }
  | { type: 'pipeline' };

/**
 * Which pipeline input receives the card text. `auto`: `card`, else `message`,
 * else the single text/long-text input.
 */
export type TeammateCardInputV1 = { type: 'auto' } | { type: 'named'; inputName: string };

/** `ask` puts "Start @x on #42?" in the Inbox; `never` only assigns. */
export type TeammateStartRuleV1 = 'ask' | 'always' | 'never';

export interface TeammateWakeV1 {
  onAssign: TeammateStartRuleV1;
  /** A person's `@handle` in a card comment starts it (following `onAssign`). */
  onMention: boolean;
}

export interface TeammateV1 {
  id: TeammateIdV1;
  handle: string;
  name: string;
  /** CSS color token name or `#rrggbb`. */
  color: string;
  /** One emoji or up to 2 initials. */
  avatar: string;
  /** What it is good at / when to hand it work. Shown to agents in `roster`. */
  role: string;
  kind: TeammateKindV1;
  launchCommandId: OrchestrationId;
  cardInput: TeammateCardInputV1;
  board: BoardPermissionsV1;
  /** 1-8. */
  maxConcurrentRuns: number;
  wake: TeammateWakeV1;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeammateStatusV1 {
  teammateId: TeammateIdV1;
  availability: 'idle' | 'queued' | 'working';
  liveRunIds: string[];
  queued: number;
  /** Present when it cannot be assigned, e.g. its card input cannot be resolved. */
  notAssignableReason?: string;
}

/** Agent settings of a simple teammate; the host fills everything else. */
export interface SimpleTeammateAgentV1 {
  harness: Harness;
  modelProvider?: string;
  model: string;
  permissionMode: PermissionMode;
  reasoning?: string;
  serviceTier?: 'standard' | 'fast';
  networkAccess?: boolean;
  instructions: string;
}

export interface TeammateDraftV1 {
  /** Present to replace an existing teammate. */
  id?: TeammateIdV1;
  expectedRevision?: number;
  handle: string;
  name: string;
  color: string;
  avatar: string;
  role: string;
  body:
    | { type: 'simple'; agent: SimpleTeammateAgentV1 }
    | { type: 'pipeline'; launchCommandId: OrchestrationId };
  cardInput: TeammateCardInputV1;
  board: BoardPermissionsV1;
  maxConcurrentRuns: number;
  wake: TeammateWakeV1;
  enabled: boolean;
}

export type TeammatesCommandV1 =
  | { type: 'list'; workspaceId: string }
  | { type: 'save'; workspaceId: string; teammate: TeammateDraftV1 }
  /** Deletes the teammate and the definitions it manages; clears a chat default that pointed at them. */
  | { type: 'delete'; workspaceId: string; teammateId: TeammateIdV1; expectedRevision: number }
  | { type: 'setEnabled'; workspaceId: string; teammateId: TeammateIdV1; enabled: boolean };

export type TeammatesResultV1 =
  | { protocol: 1; type: 'teammates'; teammates: TeammateV1[]; status: TeammateStatusV1[] }
  | { protocol: 1; type: 'teammate'; teammate: TeammateV1; status: TeammateStatusV1 }
  | { protocol: 1; type: 'deleted'; teammateId: TeammateIdV1 };

export interface TeammatesChangedEventV1 {
  protocol: 1;
  workspaceId: string;
}

export type TeammatesErrorCodeV1 =
  | 'SAFE_MODE'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'HANDLE_TAKEN'
  | 'REVISION_CONFLICT'
  | 'UNSUPPORTED'
  | 'LIMIT'
  | 'IO_ERROR';

export interface TeammatesErrorV1 {
  code: TeammatesErrorCodeV1;
  message: string;
  recoverable: boolean;
}
