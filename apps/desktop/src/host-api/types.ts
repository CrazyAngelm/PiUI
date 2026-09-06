export type AgentKind = 'pi' | 'prime-agent';
export type ProjectTrustState = 'unknown' | 'trusted' | 'restricted';
export type ParseState = 'healthy' | 'partial' | 'unsupported' | 'corrupt';
export type RuntimeState = 'dormant' | 'starting' | 'ready' | 'running' | 'recovering' | 'stopping' | 'failed';

export interface ExtensionSummary {
  /** Host-derived opaque id; native paths never cross IPC. */
  id: string;
  agentKind: AgentKind;
  name: string;
  source: 'Global' | 'Package';
  enabled: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  displayPath: string;
  agentKind: AgentKind;
  trustState: ProjectTrustState;
  pinned: boolean;
  missing: boolean;
  lastOpenedAt?: string;
}

/** Display-safe model descriptor projected from Pi `get_available_models`.*/
export interface ModelLite {
  provider: string;
  id: string;
  label?: string;
}

/** Display-safe session state projected at the host boundary. Pi keeps its
 * legacy runtime-native id. Prime v10 replaces it with the opaque catalog id,
 * or omits it when no safe catalog correlation exists. */
export interface SessionStateLite {
  sessionId?: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  steeringMode: string;
  followUpMode: string;
  model?: ModelLite;
  thinkingLevel: string;
}

/** Initial payload returned by `startRuntime`. */
export interface ApiRuntimeStart {
  runtime: RuntimeSnapshot;
  runtimeId: string;
  agentKind: AgentKind;
  launchLabel: string;
  sessionState: SessionStateLite;
  /**
   * Host-indexed opaque session id. For a continued runtime it identifies the
   * continued session; for a new Prime project runtime it is the exact
   * handshake-correlated catalog row. Prime `sessionState.sessionId`, when
   * present, is this same opaque value; a native handshake id never crosses.
   */
  sessionId?: string;
}

export interface RuntimeCommand {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  scope?: 'user' | 'project' | 'temporary';
  origin?: 'package' | 'top-level';
}

export interface PiUiCommandContribution {
  extensionId: string;
  extensionName: string;
  id: string;
  title: string;
  description?: string;
  commandName: string;
}

export interface PiUiComposerActionContribution {
  extensionId: string;
  extensionName: string;
  id: string;
  title: string;
  description?: string;
  commandId: string;
  commandName: string;
  order: number;
}

export interface PiUiContributionCatalog {
  commands: PiUiCommandContribution[];
  composerActions: PiUiComposerActionContribution[];
}

export interface ExtensionUiOption {
  id: string;
  label: string;
}

export type ExtensionDialogRequest =
  | { kind: 'select'; id: string; title: string; options: ExtensionUiOption[]; timeoutMs?: number }
  | { kind: 'confirm'; id: string; title: string; message: string; timeoutMs?: number }
  | { kind: 'input'; id: string; title: string; placeholder?: string; timeoutMs?: number }
  | { kind: 'editor'; id: string; title: string; prefill?: string; timeoutMs?: number };

export type ExtensionUiAction =
  | { action: 'dialog'; request: ExtensionDialogRequest }
  | { action: 'notify'; id: string; message: string; level: 'info' | 'warning' | 'error' }
  | { action: 'status'; key: string; text?: string }
  | { action: 'widget'; key: string; lines?: string[]; placement: 'aboveEditor' | 'belowEditor' }
  | { action: 'title'; title: string }
  | { action: 'editorText'; text: string }
  | { action: 'unsupported'; id: string; method: string; safeSummary: string };

export type ExtensionUiResponse =
  | { kind: 'selected'; optionId: string }
  | { kind: 'confirmed'; value: boolean }
  | { kind: 'submitted'; value: string }
  | { kind: 'cancelled' };

export type PrimeActivity =
  | { type: 'rlmChild'; id: string; label: string; status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'unknown'; model?: string; activity?: 'waiting' | 'writing' | 'executing'; toolName?: string; durationMs?: number; toolUseCount?: number; tokenCount?: number; repliedSinceTask?: boolean }
  | { type: 'goal'; id: string; status: 'idle' | 'active' | 'paused' | 'budget_limited' | 'complete' | 'error'; objective?: string; tokensUsed: number; tokenBudget?: number; timeUsedSeconds: number; continuationsUsed: number }
  | { type: 'sessionActions'; id: string; activeCount: number; queuedCount: number }
  | { type: 'recap'; id: string; summary?: string }
  | { type: 'authentication'; id: string; provider: string; status: 'stale' }
  | { type: 'refinement'; id: string; status: 'complete' | 'failed' }
  | { type: 'bash'; id: string; status: 'running' | 'complete' | 'failed' | 'cancelled'; exitCode?: number; truncated?: boolean }
  | { type: 'heartbeat'; id: string; status: 'active' | 'paused' | 'completed' | 'cancelled' | 'not-configured' | 'unknown'; schedule?: string; deliveryMode?: 'steer' | 'follow_up' }
  | { type: 'schedule'; id: string; status: 'active' | 'paused' | 'completed' | 'cancelled' | 'unknown'; source: 'cron' | 'heartbeat' | 'rlm_heartbeat'; schedule?: string }
  | { type: 'unknown'; id: string; wireType: string };

/** Streamed runtime events delivered on `piui://runtime-event`.
 * Mirrors `piui_runtime::SurfaceEvent` (tag = `kind`, camelCase fields). */
export type SurfaceEvent =
  | { kind: 'state'; state: RuntimeState; revision: number; safeSummary?: string }
  | { kind: 'stateSnapshot'; state: SessionStateLite; revision: number }
  | { kind: 'modelsAvailable'; models: ModelLite[] }
  | { kind: 'userMessage'; blockId: string; text: string }
  | { kind: 'assistantTextStarted'; blockId: string }
  | { kind: 'assistantTextDelta'; blockId: string; delta: string }
  | { kind: 'assistantMessageCompleted'; blockId?: string; isError: boolean; safeSummary?: string }
  | { kind: 'thinkingStarted'; blockId: string }
  | { kind: 'thinkingDelta'; blockId: string; delta: string }
  | { kind: 'toolStarted'; blockId: string; toolName: string }
  | { kind: 'toolUpdated'; blockId: string; toolName: string; safeSummary?: string }
  | { kind: 'toolCompleted'; blockId: string; toolName: string; isError: boolean; safeSummary?: string }
  | { kind: 'entryAppended'; blockId: string; entryId: string; parentId?: string; entryKind: string; text?: string }
  | { kind: 'turnStarted' }
  | { kind: 'turnCompleted'; safeSummary?: string }
  | { kind: 'queueUpdate'; steering: number; followUp: number }
  | { kind: 'compaction'; active: boolean; safeSummary?: string }
  | { kind: 'thinkingLevelChanged'; level: string }
  | { kind: 'sessionInfoChanged'; name?: string }
  | { kind: 'primeActivity'; activity: PrimeActivity }
  | { kind: 'extensionUi'; action: ExtensionUiAction }
  | { kind: 'runtimeError'; safeSummary: string };

/** Versioned payload emitted on the `piui://runtime-event` event channel.
 * Personal events deliberately have no backing workspace project id. */
export type RuntimeEventEnvelope =
  | ({
    protocol: 10;
    runtimeId: string;
    agentKind: AgentKind;
    scope: 'project';
    projectId: string;
    sessionId?: string;
  } & SurfaceEvent)
  | ({
    protocol: 10;
    runtimeId: string;
    agentKind: 'pi';
    scope: 'personal';
    sessionId?: string;
  } & SurfaceEvent);

export interface SessionSummary {
  id: string;
  projectId?: string;
  title: string;
  titleSource: 'pi-name' | 'first-user-message' | 'date-id' | 'ui-alias';
  createdAt?: string;
  updatedAt?: string;
  preview?: string;
  entryCount: number;
  branchCount?: number;
  parseState: ParseState;
  runtimeState?: RuntimeState;
}

/** Versioned cache-first sidebar projection. A `current` catalog is a
 * rebuildable metadata view, never a mutation permit for Pi JSONL. */
export type SessionCatalogFreshness = 'cached' | 'refreshing' | 'current' | 'degraded';
export type SessionCatalogScope = 'project' | 'personal';

export interface SessionCatalogSnapshot {
  protocol: 7;
  scope: SessionCatalogScope;
  /** Omitted for host-owned projectless Chats. */
  projectId?: string;
  /** Monotonic host event watermark; opaque and non-persistent. */
  sequence: number;
  freshness: SessionCatalogFreshness;
  sessions: SessionSummary[];
}

export type SessionCatalogEvent =
  | { protocol: 7; kind: 'refreshStarted'; scope: SessionCatalogScope; projectId?: string; sequence: number }
  | { protocol: 7; kind: 'snapshot'; snapshot: SessionCatalogSnapshot }
  | { protocol: 7; kind: 'refreshFailed'; scope: SessionCatalogScope; projectId?: string; sequence: number; safeSummary: string };

/** Generic root watcher hint. It intentionally exposes neither a path nor a
 * native event/error; the host revalidates JSONL during reconciliation. */
export interface SessionRootHint {
  protocol: 7;
  sequence: number;
  kind: 'changed' | 'overflow' | 'unavailable';
}

export interface TimelinePage {
  /** Version 2 groups known Pi message/tool entries into a semantic transcript. */
  projectionVersion: 2;
  sessionId: string;
  blocks: TimelineBlock[];
  tree: SessionTree;
  fileRevision: string;
  rangeStart: number;
  totalBlocks: number;
  olderCursor?: string;
  staleCursor: boolean;
}

export interface TimelineBlock {
  id: string;
  parentId?: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'custom' | 'error' | 'compaction' | 'unknown';
  createdAt?: string;
  text?: string;
  label?: string;
  safeSummary?: string;
  /** Host-derived operation label; raw tool arguments never cross IPC. */
  title?: string;
  toolName?: string;
  collapsible?: boolean;
  truncated?: boolean;
  /** True only when this block is the generic compatibility renderer. */
  fallback?: boolean;
  status: 'complete' | 'streaming' | 'failed' | 'interrupted';
}

/** A bounded flat depth-first tree projection; never recursively rendered. */
export interface SessionTreeNode {
  entryId: string;
  parentId?: string;
  label: string;
  kind: string;
  depth: number;
  isCurrentPath: boolean;
  issue?: 'orphan' | 'cycle' | 'duplicate' | 'depth-limit' | 'truncated';
}

export interface SessionTree {
  nodes: SessionTreeNode[];
  diagnosticCount: number;
  navigationSupported: false;
}

export interface RuntimeCapabilities {
  rpc: boolean;
  'session.tree.read': boolean;
  'session.tree.navigate': false;
  'auth.headless': false;
  'ui.standardDialogs': boolean;
  'prime.activity': boolean;
  'runtime.liveAttach': false;
  'runtime.residentSessions': false;
  'runtime.eventReplay': false;
  'runtime.multiClient': false;
  'thinking.catalog': boolean;
  [capability: string]: boolean | string | number | null;
}

/** Static eligibility only; Pi is not executed by this operation. */
export interface SystemPiProbeSummary {
  eligibility: 'candidate_unverified' | 'managed_runtime_required';
  managedRuntimeRequired: true;
  externalAuthGuidance: true;
}

export type FakeScenario = 'stream' | 'abort' | 'crash' | 'malformed';

export interface FakeScenarioResult {
  runtime: RuntimeSnapshot;
  blocks: TimelineBlock[];
  /** Local UI-only blocks; never persisted to Pi JSONL. */
  ephemeral: true;
}

export interface RuntimeSnapshot {
  runtimeId: string;
  agentKind: AgentKind;
  state: RuntimeState;
  revision: number;
  capabilities: RuntimeCapabilities;
  safeSummary?: string;
}

/** PiUI-owned appearance preferences. They are presentation-only and never
 * modify Pi configuration, sessions, or auth state. */
export interface Preferences {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  reducedMotion: 'system' | 'reduce';
  fontSize: 'small' | 'medium' | 'large';
  chatWidth: 'wide' | 'centered' | 'focused';
}

export interface AppSnapshot {
  appVersion: string;
  safeMode: boolean;
  preferences: Preferences;
  projects: ProjectSummary[];
  selectedProjectId?: string;
  selectedSessionId?: string;
}

export interface HostError {
  code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOT_TRUSTED' | 'NOT_SUPPORTED' | 'PROJECT_UNAVAILABLE' | 'CONFLICT' | 'PROJECT_KIND_CONFLICT' | 'SESSION_ALREADY_ACTIVE' | 'RUNTIME_FAILED' | 'IO_ERROR' | 'INTERNAL_ERROR';
  message: string;
  recoverable: boolean;
}
