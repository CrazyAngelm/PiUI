/**
 * PiUI internal host protocol v1.
 *
 * This protocol is between the trusted Rust/Tauri host and the core Svelte UI.
 * It is not the raw Pi RPC schema and must not leak process handles, arbitrary
 * filesystem paths, secrets, or shell commands.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Id = string;
export type ProjectId = Id;
export type SessionId = Id;
export type RuntimeId = Id;
export type CommandId = Id;
export type Revision = number;

export interface ProtocolEnvelope<TType extends string, TPayload> {
  protocol: 1;
  type: TType;
  payload: TPayload;
}

export type HostCommand =
  | ProtocolEnvelope<'project.list', Record<string, never>>
  | ProtocolEnvelope<'project.add', { path: string }>
  | ProtocolEnvelope<'project.remove', { projectId: ProjectId }>
  | ProtocolEnvelope<'project.locate', { projectId: ProjectId; path: string }>
  | ProtocolEnvelope<'project.setTrust', { projectId: ProjectId; trust: ProjectTrustState }>
  | ProtocolEnvelope<'session.list', { projectId: ProjectId; cursor?: string; limit?: number }>
  | ProtocolEnvelope<'session.open', { projectId: ProjectId; sessionId: SessionId }>
  | ProtocolEnvelope<'session.create', { projectId: ProjectId; runtimeProfileId?: string }>
  | ProtocolEnvelope<'session.page', EntryPageRequest>
  | ProtocolEnvelope<'session.rename', { sessionId: SessionId; name: string }>
  | ProtocolEnvelope<'session.export', { sessionId: SessionId; format: ExportFormat; targetPath: string }>
  | ProtocolEnvelope<'session.trash', { sessionId: SessionId }>
  | ProtocolEnvelope<'runtime.send', SendTurnRequest>
  | ProtocolEnvelope<'runtime.abort', { runtimeId: RuntimeId }>
  | ProtocolEnvelope<'runtime.forceStop', { runtimeId: RuntimeId }>
  | ProtocolEnvelope<'runtime.reopen', { projectId: ProjectId; sessionId: SessionId }>
  | ProtocolEnvelope<'runtime.setModel', { runtimeId: RuntimeId; model: ModelRef }>
  | ProtocolEnvelope<'runtime.setThinking', { runtimeId: RuntimeId; level: string }>
  | ProtocolEnvelope<'runtime.setQueueMode', { runtimeId: RuntimeId; mode: QueueMode }>
  | ProtocolEnvelope<'runtime.snapshot', { runtimeId: RuntimeId }>
  | ProtocolEnvelope<'ui.respond', { runtimeId: RuntimeId; requestId: string; response: UiResponse }>
  | ProtocolEnvelope<'extension.setGrant', ExtensionGrantChange>
  | ProtocolEnvelope<'extension.invoke', ExtensionCommandInvocation>
  | ProtocolEnvelope<'diagnostics.export', DiagnosticsExportRequest>;

/**
 * Protocol v1 is frozen. Additive commands are represented in v2 so an
 * exhaustive v1 consumer never receives an unknown command discriminant.
 */
export interface ProtocolEnvelopeV2<TType extends string, TPayload> {
  protocol: 2;
  type: TType;
  payload: TPayload;
}

type ReversionHostCommand<T> = T extends ProtocolEnvelope<infer TType, infer TPayload>
  ? ProtocolEnvelopeV2<TType, TPayload>
  : never;

/**
 * Cursor pages are a v2-only desktop/read-only API. The cursor is opaque and
 * host-held; it never contains a filesystem path or source entry identifier.
 */
export interface CursorTimelinePageRequest {
  projectId: ProjectId;
  sessionId: SessionId;
  cursor?: string;
  limit?: number;
}

/** Safe WebView projection for cursor pages; unlike the extension-facing
 * TimelineBlock it intentionally has no arbitrary JSON `content` field. */
export interface DesktopTimelineBlock {
  id: string;
  parentId?: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'custom' | 'error' | 'compaction' | 'unknown';
  createdAt?: string;
  label: string;
  text?: string;
  safeSummary?: string;
  /** Host-derived semantic operation metadata; raw Pi JSON is never exposed. */
  title?: string;
  toolName?: string;
  collapsible?: boolean;
  truncated?: boolean;
  fallback?: boolean;
  status: 'complete' | 'streaming' | 'failed' | 'interrupted';
}

export interface DesktopReadOnlyTree {
  nodes: Array<{
    entryId: string;
    parentId?: string;
    label: string;
    kind: string;
    depth: number;
    isCurrentPath: boolean;
    issue?: 'orphan' | 'cycle' | 'duplicate' | 'depth-limit' | 'truncated';
  }>;
  diagnosticCount: number;
  navigationSupported: false;
}

/** PiUI-owned, path-free local display preferences. These values are not Pi
 * configuration and are persisted only in PiUI's rebuildable local index. */
export interface UiPreferences {
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  reducedMotion: 'system' | 'reduce';
}

/** Desktop bootstrap payload. This is v2 because v1's HostSnapshot is frozen;
 * it is intentionally a safe projection, with no filesystem or auth data. */
/** Desktop project projection adds local registry pinning without mutating
 * the frozen v1 ProjectSummary contract. */
export interface DesktopProjectSummaryV2 extends ProjectSummary {
  pinned: boolean;
}

export interface DesktopBootstrapSnapshotV2 {
  appVersion: string;
  safeMode: boolean;
  preferences: UiPreferences;
  projects: DesktopProjectSummaryV2[];
  selectedProjectId?: ProjectId;
  selectedSessionId?: SessionId;
}

export interface CursorTimelinePage {
  /** Projection v2 groups known Pi v3 messages, reasoning, and tool results. */
  projectionVersion: 2;
  sessionId: SessionId;
  blocks: DesktopTimelineBlock[];
  tree: DesktopReadOnlyTree;
  fileRevision: string;
  rangeStart: number;
  totalBlocks: number;
  olderCursor?: string;
  staleCursor: boolean;
}

export type HostCommandV2 =
  | ReversionHostCommand<HostCommand>
  | ProtocolEnvelopeV2<'session.search', { query: string }>
  | ProtocolEnvelopeV2<'session.pageByCursor', CursorTimelinePageRequest>
  | ProtocolEnvelopeV2<'ui.preferences.set', UiPreferences>;

export interface HostCommandRequest {
  commandId: CommandId;
  command: HostCommand;
}

export interface HostCommandRequestV2 {
  commandId: CommandId;
  command: HostCommandV2;
}

export type HostCommandResponse =
  | { protocol: 1; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 1; commandId: CommandId; ok: false; error: HostError };

export type HostCommandResponseV2 =
  | { protocol: 2; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 2; commandId: CommandId; ok: false; error: HostError };

/**
 * Protocol v3 adds the explicit local live-Pi runtime preview. It is separate
 * from the frozen v1/v2 request shapes because it adds an event channel and
 * lifecycle commands rather than mutating their semantics.
 */
export interface ProtocolEnvelopeV3<TType extends string, TPayload> {
  protocol: 3;
  type: TType;
  payload: TPayload;
}

type ReversionV2HostCommand<T> = T extends ProtocolEnvelopeV2<infer TType, infer TPayload>
  ? ProtocolEnvelopeV3<TType, TPayload>
  : never;

export interface DesktopLiveModelV3 {
  provider: string;
  id: string;
  label?: string;
}

/** Intentionally has no session-file path: paths stay host-private. */
export interface DesktopLiveSessionStateV3 {
  sessionId: SessionId;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  steeringMode: string;
  followUpMode: string;
  model?: DesktopLiveModelV3;
  thinkingLevel: string;
}

export interface DesktopLiveRuntimeSnapshotV3 {
  runtimeId: RuntimeId;
  state: RuntimeState;
  revision: number;
  capabilities: {
    rpc: true;
    'session.tree.read': true;
    'session.tree.navigate': false;
    'auth.headless': false;
    'ui.standardDialogs': false;
  };
  safeSummary?: string;
}

export interface DesktopLiveRuntimeStartV3 {
  runtime: DesktopLiveRuntimeSnapshotV3;
  runtimeId: RuntimeId;
  launchLabel: string;
  sessionState: DesktopLiveSessionStateV3;
  sessionId?: SessionId;
}

/** Direct payload on the `piui://runtime-event` channel. */
export type DesktopRuntimeStreamEventV3 =
  | { kind: 'state'; state: RuntimeState; revision: number; safeSummary?: string }
  | { kind: 'stateSnapshot'; state: DesktopLiveSessionStateV3; revision: number }
  | { kind: 'modelsAvailable'; models: DesktopLiveModelV3[] }
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
  | { kind: 'extensionUiRequest'; id: string; method: string; safeSummary?: string }
  | { kind: 'runtimeError'; safeSummary: string };

/** Versioned direct event payload emitted by the desktop host. */
export type DesktopRuntimeEventEnvelopeV3 = {
  protocol: 3;
  runtimeId: RuntimeId;
  projectId: ProjectId;
  sessionId?: SessionId;
} & DesktopRuntimeStreamEventV3;

export type HostCommandV3 =
  | ReversionV2HostCommand<HostCommandV2>
  | ProtocolEnvelopeV3<'runtime.start', { projectId: ProjectId; sessionId?: SessionId }>
  | ProtocolEnvelopeV3<'runtime.prompt', { runtimeId: RuntimeId; text: string }>
  | ProtocolEnvelopeV3<'runtime.steer', { runtimeId: RuntimeId; text: string }>
  | ProtocolEnvelopeV3<'runtime.followUp', { runtimeId: RuntimeId; text: string }>
  | ProtocolEnvelopeV3<'runtime.abort', { runtimeId: RuntimeId }>
  | ProtocolEnvelopeV3<'runtime.stop', { runtimeId: RuntimeId }>
  | ProtocolEnvelopeV3<'runtime.state.get', { runtimeId: RuntimeId }>
  | ProtocolEnvelopeV3<'runtime.models.get', { runtimeId: RuntimeId }>
  | ProtocolEnvelopeV3<'runtime.model.set', { runtimeId: RuntimeId; provider: string; modelId: string }>
  | ProtocolEnvelopeV3<'runtime.thinking.set', { runtimeId: RuntimeId; level: string }>
  | ProtocolEnvelopeV3<'runtime.sessionName.set', { runtimeId: RuntimeId; name: string }>;

export interface HostCommandRequestV3 {
  commandId: CommandId;
  command: HostCommandV3;
}

export type HostCommandResponseV3 =
  | { protocol: 3; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 3; commandId: CommandId; ok: false; error: HostError };

/**
 * Protocol v4 preserves the v3 surface while adding Pi-reported thinking
 * levels. The runtime event envelope also advances to v4 so a v3 WebView does
 * not silently consume a command/event surface it cannot fully represent.
 */
export interface ProtocolEnvelopeV4<TType extends string, TPayload> {
  protocol: 4;
  type: TType;
  payload: TPayload;
}

type ReversionV3HostCommand<T> = T extends ProtocolEnvelopeV3<infer TType, infer TPayload>
  ? ProtocolEnvelopeV4<TType, TPayload>
  : never;

export type DesktopRuntimeStreamEventV4 = DesktopRuntimeStreamEventV3;

export type DesktopRuntimeEventEnvelopeV4 = {
  protocol: 4;
  runtimeId: RuntimeId;
  projectId: ProjectId;
  sessionId?: SessionId;
} & DesktopRuntimeStreamEventV4;

export type HostCommandV4 =
  | ReversionV3HostCommand<HostCommandV3>
  | ProtocolEnvelopeV4<'runtime.thinkingLevels.get', { runtimeId: RuntimeId }>;

export interface HostCommandRequestV4 {
  commandId: CommandId;
  command: HostCommandV4;
}

export type HostCommandResponseV4 =
  | { protocol: 4; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 4; commandId: CommandId; ok: false; error: HostError };

/**
 * Protocol v5 adds the host-owned personal Chats scope. It is deliberately a
 * distinct command family rather than `projectId: undefined`: the WebView
 * never receives the neutral workspace path or treats it as a user project.
 * Runtime stream envelopes advance to v5 so personal events omit the
 * host-owned backing workspace identity entirely.
 */
export interface ProtocolEnvelopeV5<TType extends string, TPayload> {
  protocol: 5;
  type: TType;
  payload: TPayload;
}

type ReversionV4HostCommand<T> = T extends ProtocolEnvelopeV4<infer TType, infer TPayload>
  ? ProtocolEnvelopeV5<TType, TPayload>
  : never;

export interface PersonalTimelinePageRequest {
  sessionId: SessionId;
  cursor?: string;
  limit?: number;
}

export type DesktopRuntimeStreamEventV5 = DesktopRuntimeStreamEventV4;

/** The scope is discriminated so a projectless event cannot carry a hidden
 * backing project id into the WebView. */
export type DesktopRuntimeEventEnvelopeV5 =
  | ({
    protocol: 5;
    runtimeId: RuntimeId;
    scope: 'project';
    projectId: ProjectId;
    sessionId?: SessionId;
  } & DesktopRuntimeStreamEventV5)
  | ({
    protocol: 5;
    runtimeId: RuntimeId;
    scope: 'personal';
    sessionId?: SessionId;
  } & DesktopRuntimeStreamEventV5);

export type HostCommandV5 =
  | ReversionV4HostCommand<HostCommandV4>
  | ProtocolEnvelopeV5<'session.personal.list', Record<string, never>>
  | ProtocolEnvelopeV5<'session.personal.page', PersonalTimelinePageRequest>
  | ProtocolEnvelopeV5<'session.personal.tree', { sessionId: SessionId }>
  | ProtocolEnvelopeV5<'runtime.personal.start', { sessionId?: SessionId }>;

export interface HostCommandRequestV5 {
  commandId: CommandId;
  command: HostCommandV5;
}

export type HostCommandResponseV5 =
  | { protocol: 5; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 5; commandId: CommandId; ok: false; error: HostError };

/** Protocol v6 versions the semantic transcript projection. Commands remain
 * behaviorally compatible; cursor-page responses now declare projection v2. */
export interface ProtocolEnvelopeV6<TType extends string, TPayload> {
  protocol: 6;
  type: TType;
  payload: TPayload;
}

type ReversionV5HostCommand<T> = T extends ProtocolEnvelopeV5<infer TType, infer TPayload>
  ? ProtocolEnvelopeV6<TType, TPayload>
  : never;

export type HostCommandV6 = ReversionV5HostCommand<HostCommandV5>;

export interface HostCommandRequestV6 {
  commandId: CommandId;
  command: HostCommandV6;
}

export type HostCommandResponseV6 =
  | { protocol: 6; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 6; commandId: CommandId; ok: false; error: HostError };

/** Protocol v7 adds a cache-first, generation-safe session catalog surface.
 * It is deliberately distinct from strong JSONL observations used for a
 * transcript or mutation admission: catalog freshness never authorizes Pi
 * session mutation. */
export interface ProtocolEnvelopeV7<TType extends string, TPayload> {
  protocol: 7;
  type: TType;
  payload: TPayload;
}

type ReversionV6HostCommand<T> = T extends ProtocolEnvelopeV6<infer TType, infer TPayload>
  ? ProtocolEnvelopeV7<TType, TPayload>
  : never;

export type SessionCatalogFreshness = 'cached' | 'refreshing' | 'current' | 'degraded';
export type SessionCatalogScope = 'project' | 'personal';

/** Safe materialized sidebar projection. `sequence` is an opaque host event
 * watermark, never a filesystem path, Pi id, or content revision. */
export interface DesktopSessionCatalogSnapshotV7 {
  protocol: 7;
  scope: SessionCatalogScope;
  projectId?: ProjectId;
  sequence: number;
  freshness: SessionCatalogFreshness;
  sessions: SessionSummary[];
}

export type DesktopSessionCatalogEventV7 =
  | {
      protocol: 7;
      kind: 'refreshStarted';
      scope: SessionCatalogScope;
      projectId?: ProjectId;
      sequence: number;
    }
  | { protocol: 7; kind: 'snapshot'; snapshot: DesktopSessionCatalogSnapshotV7 }
  | {
      protocol: 7;
      kind: 'refreshFailed';
      scope: SessionCatalogScope;
      projectId?: ProjectId;
      sequence: number;
      safeSummary: string;
    };

/** Watcher transport is an opaque, lossy scheduling hint. Source paths,
 * native event names, and errors stay in the host; reconciliation remains the
 * authoritative JSONL read path. */
export interface DesktopSessionRootHintV7 {
  protocol: 7;
  sequence: number;
  kind: 'changed' | 'overflow' | 'unavailable';
}

export type HostCommandV7 =
  | ReversionV6HostCommand<HostCommandV6>
  | ProtocolEnvelopeV7<'session.catalog.get', { projectId: ProjectId }>
  | ProtocolEnvelopeV7<'session.catalog.refresh', { projectId: ProjectId }>
  | ProtocolEnvelopeV7<'session.personal.catalog.get', Record<string, never>>
  | ProtocolEnvelopeV7<'session.personal.catalog.refresh', Record<string, never>>;

export interface HostCommandRequestV7 {
  commandId: CommandId;
  command: HostCommandV7;
}

export type HostCommandResponseV7 =
  | { protocol: 7; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 7; commandId: CommandId; ok: false; error: HostError };

/** Protocol v8 versions the full local appearance preference set. The v2
 * preference payload stays frozen so older WebViews can retain its smaller
 * compatible surface. */
export interface ProtocolEnvelopeV8<TType extends string, TPayload> {
  protocol: 8;
  type: TType;
  payload: TPayload;
}

type ReversionV7HostCommand<T> = T extends ProtocolEnvelopeV7<infer TType, infer TPayload>
  ? ProtocolEnvelopeV8<TType, TPayload>
  : never;

export interface UiPreferencesV8 extends UiPreferences {
  /** Presentation-only chat text scale. */
  fontSize: 'small' | 'medium' | 'large';
  /** Controls the centered conversation lane, never a session or project. */
  chatWidth: 'wide' | 'centered' | 'focused';
}

export interface DesktopBootstrapSnapshotV8 extends Omit<DesktopBootstrapSnapshotV2, 'preferences'> {
  preferences: UiPreferencesV8;
}

export type HostCommandV8 =
  | ReversionV7HostCommand<HostCommandV7>
  | ProtocolEnvelopeV8<'ui.preferences.set.v8', UiPreferencesV8>;

export interface HostCommandRequestV8 {
  commandId: CommandId;
  command: HostCommandV8;
}

export type HostCommandResponseV8 =
  | { protocol: 8; commandId: CommandId; ok: true; result: JsonValue | null }
  | { protocol: 8; commandId: CommandId; ok: false; error: HostError };

export interface HostError {
  code:
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'NOT_TRUSTED'
    | 'NOT_SUPPORTED'
    | 'PERMISSION_DENIED'
    | 'CONFLICT'
    | 'RUNTIME_NOT_READY'
    | 'RUNTIME_FAILED'
    | 'PROTOCOL_ERROR'
    | 'TIMEOUT'
    | 'IO_ERROR'
    | 'INTERNAL_ERROR';
  message: string;
  recoverable: boolean;
  details?: JsonValue;
}

export type HostEvent =
  | ProtocolEnvelope<'host.ready', HostSnapshot>
  | ProtocolEnvelope<'project.changed', { project: ProjectSummary; reason: ChangeReason }>
  | ProtocolEnvelope<'session.changed', { session: SessionSummary; reason: ChangeReason }>
  | ProtocolEnvelope<'session.removed', { sessionId: SessionId; reason: 'trashed' | 'external' }>
  | ProtocolEnvelope<'session.delta', RuntimeSessionDelta>
  | ProtocolEnvelope<'session.reindexed', { sessionId: SessionId; fileRevision: string }>
  | ProtocolEnvelope<'runtime.state', RuntimeStateEvent>
  | ProtocolEnvelope<'runtime.snapshot', RuntimeSnapshot>
  | ProtocolEnvelope<'ui.request', { runtimeId: RuntimeId; request: UiRequest }>
  | ProtocolEnvelope<'notification', HostNotification>
  | ProtocolEnvelope<'extension.changed', { extensionId: string; reason: ChangeReason }>
  | ProtocolEnvelope<'diagnostic', DiagnosticNotice>;

export type ChangeReason = 'created' | 'updated' | 'removed' | 'reindexed' | 'external';

export interface HostSnapshot {
  appVersion: string;
  protocolVersion: 1;
  safeMode: boolean;
  projects: ProjectSummary[];
  selectedProjectId?: ProjectId;
  selectedSessionId?: SessionId;
}

export type ProjectTrustState = 'unknown' | 'trusted' | 'restricted';

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  displayPath: string;
  trustState: ProjectTrustState;
  missing: boolean;
  lastOpenedAt?: string;
}

export interface SessionSummary {
  id: SessionId;
  projectId?: ProjectId;
  title: string;
  titleSource: 'pi-name' | 'first-user-message' | 'date-id' | 'ui-alias';
  createdAt?: string;
  updatedAt?: string;
  preview?: string;
  entryCount: number;
  branchCount?: number;
  parseState: 'healthy' | 'partial' | 'unsupported' | 'corrupt';
  runtimeState?: RuntimeState;
  model?: ModelRef;
}

export type RuntimeState =
  | 'dormant'
  | 'starting'
  | 'ready'
  | 'running'
  | 'recovering'
  | 'stopping'
  | 'failed';

export interface RuntimeStateEvent {
  runtimeId: RuntimeId;
  projectId: ProjectId;
  sessionId?: SessionId;
  state: RuntimeState;
  previousState?: RuntimeState;
  reasonCode?: string;
  safeSummary?: string;
}

export interface RuntimeCapabilities {
  rpc: boolean;
  images: boolean;
  'models.list': boolean;
  'models.switch': boolean;
  'thinking.set': boolean;
  'queue.setMode': boolean;
  'session.switch': boolean;
  'session.new': boolean;
  'session.rename': boolean;
  'session.export': boolean;
  'session.fork': boolean;
  'session.clone': boolean;
  'session.tree.read': boolean;
  'session.tree.navigate': boolean;
  'session.shutdown': boolean;
  'auth.headless': boolean;
  'ui.standardDialogs': boolean;
  'ui.customTui': false;
  [futureCapability: string]: boolean | string | number | null;
}

export interface RuntimeSnapshot {
  runtimeId: RuntimeId;
  projectId: ProjectId;
  sessionId?: SessionId;
  state: RuntimeState;
  revision: Revision;
  capabilities: RuntimeCapabilities;
  currentModel?: ModelRef;
  availableModels: ModelDescriptor[];
  thinkingLevel?: string;
  thinkingLevels?: string[];
  queueMode?: QueueMode;
  queuedCount: number;
  blocks: TimelineBlock[];
}

export interface RuntimeSessionDelta {
  runtimeId: RuntimeId;
  sessionId?: SessionId;
  revision: Revision;
  previousRevision: Revision;
  delta: SessionDelta;
}

export type SessionDelta =
  | { kind: 'turn.started'; turnId: string }
  | { kind: 'message.started'; block: TimelineBlock }
  | { kind: 'message.text.delta'; blockId: string; text: string }
  | { kind: 'message.thinking.delta'; blockId: string; text: string }
  | { kind: 'tool.started'; blockId: string; tool: ToolInvocation }
  | { kind: 'tool.updated'; blockId: string; update: JsonValue }
  | { kind: 'tool.completed'; blockId: string; result: JsonValue; isError: boolean }
  | { kind: 'entry.appended'; entryId: string; parentId?: string; raw: JsonValue }
  | { kind: 'block.status'; blockId: string; status: BlockStatus }
  | { kind: 'turn.completed'; turnId: string; stopReason?: string }
  | { kind: 'queue.changed'; queuedCount: number }
  | { kind: 'runtime.error'; code: string; recoverable: boolean; safeSummary: string };

export type TimelineBlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'custom'
  | 'error'
  | 'compaction';

export type BlockStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'interrupted';

export interface TimelineBlock {
  id: string;
  parentId?: string;
  kind: TimelineBlockKind;
  status: BlockStatus;
  createdAt?: string;
  source: {
    sessionId: SessionId;
    entryId?: string;
    extensionId?: string;
    type?: string;
  };
  content: JsonValue;
  raw?: JsonValue;
}

export interface ToolInvocation {
  name: string;
  label?: string;
  extensionId?: string;
  arguments: JsonValue;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelDescriptor extends ModelRef {
  label?: string;
  supportsImages?: boolean;
  contextWindow?: number;
  thinkingLevels?: string[];
  unavailableReason?: string;
}

export type QueueMode = 'steer' | 'followUp';
export type DeliveryMode = 'prompt' | 'steer' | 'followUp';

export interface SendTurnRequest {
  runtimeId: RuntimeId;
  text: string;
  mode: DeliveryMode;
  attachments: AttachmentDescriptor[];
}

export type AttachmentDescriptor =
  | {
      kind: 'image';
      attachmentId: string;
      mime: string;
      displayName: string;
      sizeBytes: number;
    }
  | {
      kind: 'project-file';
      projectId: ProjectId;
      relativePath: string;
      displayName: string;
    }
  | {
      kind: 'external-file';
      handleId: string;
      mode: 'reference' | 'managed-copy';
      displayName: string;
      mime?: string;
      sizeBytes?: number;
    };

export type UiRequest =
  | { id: string; kind: 'select'; title: string; message?: string; options: UiSelectOption[]; allowCancel: boolean }
  | { id: string; kind: 'confirm'; title: string; message: string; confirmLabel?: string; cancelLabel?: string }
  | { id: string; kind: 'input'; title: string; message?: string; value?: string; placeholder?: string; password?: boolean }
  | { id: string; kind: 'editor'; title: string; value?: string; language?: string; allowCancel: boolean };

export interface UiSelectOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export type UiResponse =
  | { kind: 'selected'; optionId: string }
  | { kind: 'confirmed'; value: boolean }
  | { kind: 'submitted'; value: string }
  | { kind: 'cancelled'; reason: 'user' | 'session-closed' | 'timeout' | 'runtime-stopped' };

export interface EntryPageRequest {
  sessionId: SessionId;
  direction: 'older' | 'newer';
  anchorEntryId?: string;
  fileRevision: string;
  limit: number;
}

export interface EntryPage {
  sessionId: SessionId;
  blocks: TimelineBlock[];
  fileRevision: string;
  olderCursor?: string;
  newerCursor?: string;
  staleCursor: boolean;
}

export type ExportFormat = 'pi-native' | 'markdown' | 'json' | 'html';

export interface ExtensionGrantChange {
  extensionId: string;
  projectId?: ProjectId;
  permission: ExtensionPermission;
  decision: 'deny' | 'allow-once' | 'allow-project' | 'allow-global' | 'revoke';
}

export type ExtensionPermission =
  | 'session.read'
  | 'session.command'
  | 'session.prompt'
  | 'composer.read'
  | 'composer.write'
  | 'project.read'
  | 'project.write'
  | 'externalFiles.read'
  | 'network'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'notifications'
  | 'storage'
  | 'secrets'
  | 'ui.richView'
  | 'ui.shell';

export interface ExtensionCommandInvocation {
  extensionId: string;
  command: string;
  args?: JsonValue;
  userGesture: boolean;
}

export interface DiagnosticsExportRequest {
  targetPath: string;
  include: Array<'versions' | 'capabilities' | 'safe-logs' | 'paths' | 'raw-runtime-output'>;
  acknowledgeSensitiveContent: boolean;
}

export interface HostNotification {
  level: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  sourceExtensionId?: string;
  actions?: Array<{ id: string; label: string }>;
}

export interface DiagnosticNotice {
  code: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  safeSummary: string;
  runtimeId?: RuntimeId;
  sessionId?: SessionId;
}
