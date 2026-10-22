/**
 * PiUI Fusion protocol v1 (`fusion_command_v1`, ADR-043, docs/FUSION.md).
 * Independently versioned; workspace v15, the bridge event set of earlier
 * contracts and the system file format are unchanged by it.
 *
 * - A Fusion chat is an ordinary chat of the LEAD's harness plus the host
 *   tool `sidekick`. The host owns a broker that creates and reopens one
 *   persistent SIDEKICK session under a frozen membership policy: no board,
 *   no plugin MCP servers, no native subagents, broker-owned turns.
 * - A round is one admitted sidekick turn (a brief, a correction or an
 *   answer). Every round-scoped operation names its `roundId`.
 * - A report is the sidekick's untrusted final answer plus host facts; the
 *   two are separate fields and the body can never close the envelope.
 * - State is PiUI application data under `fusion-v1/`; nothing is written
 *   into the project folder. Native histories stay the source of truth.
 *
 * Reads work in safe mode; every change is refused there (`SAFE_MODE`).
 */
import type { HarnessKind, PermissionMode, WorkspaceModel } from './workspace-v15';

export const FUSION_PROTOCOL = 1 as const;
export const FUSION_CHANGED_EVENT_V1 = 'piui://fusion-changed-v1' as const;

/** Body bytes a tool result carries before `truncated` (full text: `report`). */
export const REPORT_BODY_BYTES = 8 * 1024;
/** Default wait portion of `brief`, `message` and `wait` in seconds. */
export const DEFAULT_WAIT_SECONDS = 240;
/** Upper bound of one wait portion (the adapters raise the transport limit above it). */
export const MAX_WAIT_SECONDS = 540;
export const MAX_BRIEF_TITLE_CHARS = 200;
export const MAX_BRIEF_FIELD_BYTES = 32 * 1024;
export const MAX_BRIEF_LIST_ITEMS = 40;
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** Briefs kept in full; older ones fold into the summary (identity records stay). */
export const MAX_LIVE_BRIEFS = 200;
/** Rejected rounds of one brief after which the result carries an escalation hint. */
export const CORRECTION_HINT_ROUNDS = 2;

// ---------------------------------------------------------------------------
// Pair
// ---------------------------------------------------------------------------

export type FusionRoleNameV1 = 'lead' | 'sidekick';

/** One role's native configuration. Cross-harness pairs need explicit modes. */
export interface FusionRoleV1 {
  harness: HarnessKind;
  model?: WorkspaceModel;
  thinkingLevel?: string;
  permissionMode: PermissionMode;
}

export type BriefPolicyV1 = 'prescriptive' | 'outline';

export interface FusionOptionsV1 {
  /** Detail the lead should put into briefs; reported in tool results, never in the lead prefix. */
  briefPolicy: BriefPolicyV1;
  /** The sidekick may argue in `OPEN` (fixed in its instructions when its session starts). */
  pushback: boolean;
  /** An uncollected report starts a lead turn when the lead is idle. */
  autoDeliver: boolean;
  /** Native subagents of the lead (off by default: delegation goes to the sidekick). */
  leadNativeSubagents: boolean;
}

export const DEFAULT_FUSION_OPTIONS: FusionOptionsV1 = {
  briefPolicy: 'prescriptive',
  pushback: false,
  autoDeliver: true,
  leadNativeSubagents: false,
};

export interface FusionPairV1 {
  lead: FusionRoleV1;
  sidekick: FusionRoleV1;
  options: FusionOptionsV1;
}

/** Why a pair cannot start (`pairCheck` with `ok:false`, also the answer of a refused `createChat`). */
export type FusionRefusalV1 =
  | 'lead-harness-unsupported'
  | 'sidekick-harness-unsupported'
  | 'explicit-modes-required'
  | 'sidekick-exceeds-lead'
  | 'sidekick-needs-full-access'
  | 'codex-sandbox-unverified'
  | 'read-only-lead';

// ---------------------------------------------------------------------------
// The `sidekick` host tool (strict key sets; the bridge validates them)
// ---------------------------------------------------------------------------

export interface BriefFieldsV1 {
  title: string;
  goal: string;
  /** Observable completion criteria; at least one. */
  doneWhen: string[];
  context?: string;
  scope?: string[];
  leaveAlone?: string[];
  constraints?: string[];
  verify?: string[];
  stopIf?: string[];
}

export type SidekickToolOperationV1 =
  | ({ op: 'brief'; wait?: boolean; waitSeconds?: number } & BriefFieldsV1)
  | { op: 'wait'; roundId?: string; waitSeconds?: number }
  | { op: 'status' }
  | { op: 'message'; briefId: string; text: string; wait?: boolean; waitSeconds?: number }
  | { op: 'steer'; roundId: string; text: string }
  | { op: 'stop'; roundId: string; takeOver?: boolean }
  | { op: 'diff'; paths?: string[]; page?: number; fingerprint?: string }
  | { op: 'report'; roundId: string; page?: number }
  | { op: 'close'; briefId: string; outcome: BriefOutcomeV1; note?: string }
  | { op: 'reset'; reason?: string };

export type SidekickOpV1 = SidekickToolOperationV1['op'];

/**
 * Who asked: added by the bridge, never by the model. `epoch` is the bridge
 * process generation, `seq` its call counter, `callRef` the native call id
 * when the harness gives one (Claude Code `_meta["claudecode/toolUseId"]`,
 * Codex `callId`), `opHash` the SHA-256 of the canonical operation JSON.
 */
export interface SidekickCallIdentityV1 {
  epoch: string;
  seq: number;
  callRef?: string;
  opHash: string;
}

export type SidekickErrorCodeV1 =
  | 'invalid-brief'
  | 'brief-active'
  | 'round-active'
  | 'unknown-brief'
  | 'unknown-round'
  | 'round-finished'
  | 'steer-unsupported'
  | 'sidekick-unavailable'
  | 'sidekick-sign-in-required'
  | 'authority-denied'
  | 'pair-stopping'
  | 'diff-unavailable'
  | 'diff-stale'
  | 'identity-conflict'
  | 'uncertain';

export type ReportStatusV1 = 'done' | 'partial' | 'blocked' | 'needs-decision' | 'unknown';

export type RoundOutcomeV1 = 'completed' | 'interrupted' | 'failed' | 'no-answer' | 'uncertain';

export type RoundStateV1 =
  | 'queued'
  | 'running'
  | 'waitingApproval'
  | 'stopping'
  | 'finished'
  | 'uncertain';

/** Where a fact comes from. `unknown` is never shown as a measured value. */
export type FactSourceV1 = 'native' | 'git' | 'host' | 'unknown';

export interface FactFileV1 {
  path: string;
  /** `null`: binary or not countable. */
  added: number | null;
  removed: number | null;
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

export interface SidekickFactsV1 {
  outcome: RoundOutcomeV1;
  durationMs: number;
  /** Working-tree changes against `HEAD` (may include earlier uncommitted edits). */
  files: { source: FactSourceV1; items: FactFileV1[]; truncated: boolean };
  /** Native command receipts; `unknown` until an adapter reports typed receipts. */
  commands: { source: FactSourceV1; items: { command: string; exitCode: number | null; ok: boolean | null }[] };
  approvals: { source: FactSourceV1; requested: number };
  tokens: { source: FactSourceV1; input?: number; output?: number; cacheRead?: number };
}

/** The parsed report sections; the full body stays available through `report`. */
export interface SidekickReportV1 {
  briefId: string;
  roundId: string;
  status: ReportStatusV1;
  /** First lines of each section (always delivered, never truncated away). */
  open: string;
  deviations: string;
  /** The escaped, possibly truncated body (untrusted sidekick text). */
  body: string;
  truncated: boolean;
  facts: SidekickFactsV1;
}

export interface SidekickProgressV1 {
  briefId: string;
  roundId: string;
  state: RoundStateV1;
  elapsedMs: number;
  /** Latest sidekick activity line (tool title), bounded; never the body. */
  activity?: string;
}

/** `ok:false` results are still results the lead reads. */
export type SidekickToolResultV1 =
  | {
      ok: true;
      op: SidekickOpV1;
      briefId?: string;
      roundId?: string;
      /** Present when a round finished within the wait portion (or `wait` collected it). */
      report?: SidekickReportV1;
      /** The report was already handed over before (repeat `wait`). */
      alreadyDelivered?: boolean;
      progress?: SidekickProgressV1;
      /** The text the lead model reads (envelope); the fields above are for the host and UI. */
      text: string;
      warnings?: string[];
    }
  | { ok: false; op: SidekickOpV1 | 'unknown'; code: SidekickErrorCodeV1; message: string; text?: string };

// ---------------------------------------------------------------------------
// Journal (host data; the WebView reads it through `state`)
// ---------------------------------------------------------------------------

export type BriefOutcomeV1 = 'accepted' | 'rejected' | 'superseded';

export type BriefStateV1 = 'active' | 'reported' | 'closed' | 'stopped';

export interface FusionRoundV1 {
  roundId: string;
  kind: 'brief' | 'message';
  state: RoundStateV1;
  outcome?: RoundOutcomeV1;
  status?: ReportStatusV1;
  startedAt: string;
  finishedAt?: string;
  /** Verified native reference of the sidekick's final answer for this round. */
  answerBlockId?: string;
  answerHash?: string;
  /** A short preview of the input (never the whole brief). */
  preview: string;
  delivery?: FusionDeliveryV1;
  takeOver?: boolean;
}

export interface FusionBriefV1 {
  briefId: string;
  title: string;
  goal: string;
  doneWhen: string[];
  state: BriefStateV1;
  outcome?: BriefOutcomeV1;
  note?: string;
  sidekickSessionId: string;
  rounds: FusionRoundV1[];
  createdAt: string;
}

/** One durable delivery record per report (composer outbox model). */
export interface FusionDeliveryV1 {
  via: 'tool' | 'followUp';
  state: 'queued' | 'sending' | 'sent' | 'uncertain' | 'withdrawn';
  updatedAt: string;
}

export type SidekickStateV1 = 'none' | 'idle' | 'working' | 'waitingApproval' | 'stopping' | 'unavailable';

export interface FusionSidekickSessionV1 {
  sessionId: string;
  harness: HarnessKind;
  retired: boolean;
  retiredReason?: string;
  createdAt: string;
}

export interface FusionStatsV1 {
  briefs: number;
  accepted: number;
  rejected: number;
  takenOver: number;
  rounds: number;
}

export interface FusionStateV1 {
  protocol: typeof FUSION_PROTOCOL;
  leadSessionId: string;
  workspaceId: string;
  pair: FusionPairV1;
  sidekick: SidekickStateV1;
  sessions: FusionSidekickSessionV1[];
  briefs: FusionBriefV1[];
  stats: FusionStatsV1;
  revision: number;
}

// ---------------------------------------------------------------------------
// Commands (`fusion_command_v1`) and events
// ---------------------------------------------------------------------------

export type FusionCommandV1 =
  | { type: 'createChat'; workspaceId: string; pair: FusionPairV1; title?: string }
  | { type: 'checkPair'; workspaceId: string; pair: FusionPairV1 }
  | { type: 'state'; leadSessionId: string }
  | { type: 'find'; sessionId: string }
  | { type: 'stopPair'; leadSessionId: string }
  | { type: 'stopSidekick'; leadSessionId: string }
  | { type: 'resetSidekick'; leadSessionId: string }
  | { type: 'reconcileRound'; leadSessionId: string; roundId: string }
  | { type: 'abandonRound'; leadSessionId: string; roundId: string };

/**
 * Host errors are `WorkspaceError` values (`SAFE_MODE`, `INVALID_ARGUMENT`,
 * `NOT_FOUND`, `CONFLICT`, `NOT_SUPPORTED`, `IO_ERROR`, sign-in codes).
 * A refused `createChat` answers `pairCheck` with `ok:false` and starts nothing.
 */
export type FusionResultV1 =
  | { type: 'created'; leadSessionId: string; state: FusionStateV1 }
  | { type: 'pairCheck'; ok: true }
  | { type: 'pairCheck'; ok: false; refusal: FusionRefusalV1; role: FusionRoleNameV1 }
  | { type: 'state'; state: FusionStateV1 }
  /** `find`: the session is a lead, a sidekick of a lead, or neither. */
  | { type: 'membership'; role: FusionRoleNameV1 | null; leadSessionId?: string }
  | { type: 'accepted' };

export interface FusionChangedEventV1 {
  protocol: typeof FUSION_PROTOCOL;
  leadSessionId: string;
  revision: number;
}
