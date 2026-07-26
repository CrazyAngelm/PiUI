/**
 * PiUI Extension Host API v1 — author-facing contract.
 *
 * Workers and rich views receive a capability-limited implementation of this
 * interface after manifest validation and permission checks. No Tauri API,
 * process handle, unrestricted path, or secret value is exposed directly.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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

export type ResourceRef =
  | { scheme: 'project'; projectId: string; relativePath: string }
  | { scheme: 'picked'; handleId: string }
  | { scheme: 'attachment'; attachmentId: string }
  | { scheme: 'package'; extensionId: string; relativePath: string };

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (event: T) => void) => Disposable;

export interface PiUiExtensionContext {
  readonly extension: ExtensionIdentity;
  readonly apiVersion: string;
  readonly grantedPermissions: ReadonlySet<ExtensionPermission>;
  readonly capabilities: Readonly<Record<string, boolean | string | number | null>>;
  readonly commands: CommandsApi;
  readonly session: SessionApi;
  readonly composer: ComposerApi;
  readonly project: ProjectApi;
  readonly externalFiles: ExternalFilesApi;
  readonly ui: UiApi;
  readonly storage: StorageApi;
  readonly network: NetworkApi;
  readonly clipboard: ClipboardApi;
  readonly notifications: NotificationsApi;
  readonly secrets: SecretsApi;
  readonly subscriptions: Disposable[];
}

export interface ExtensionIdentity {
  id: string;
  name: string;
  version: string;
  source: 'global' | 'project' | 'built-in' | 'development';
  packageFingerprint: string;
}

export type ExtensionActivator = (context: PiUiExtensionContext) => void | Promise<void>;

export interface CommandsApi {
  register(
    handlerId: string,
    handler: (args: JsonValue | undefined, context: CommandExecutionContext) => JsonValue | void | Promise<JsonValue | void>,
  ): Disposable;
  execute(commandId: string, args?: JsonValue, options?: { userVisible?: boolean }): Promise<JsonValue | undefined>;
}

export interface CommandExecutionContext {
  readonly userGesture: boolean;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

export interface SessionApi {
  getCurrent(): Promise<SessionSnapshot | null>;
  getBlocks(options?: { before?: string; after?: string; limit?: number }): Promise<TimelineBlockPage>;
  onDidChange: Event<SessionChangeEvent>;
  executePiCommand(name: string, args?: string): Promise<void>;
  send(input: SessionInput, options: { mode: 'prompt' | 'steer' | 'followUp'; userVisible: true }): Promise<void>;
}

export interface SessionSnapshot {
  id: string;
  projectId: string;
  title: string;
  state: 'dormant' | 'starting' | 'ready' | 'running' | 'recovering' | 'stopping' | 'failed';
  revision: number;
  model?: { provider: string; id: string };
  queuedCount: number;
  capabilities: Readonly<Record<string, boolean | string | number | null>>;
}

export interface SessionInput {
  text: string;
  attachments?: ExtensionAttachment[];
}

export type ExtensionAttachment =
  | { kind: 'resource'; resource: ResourceRef; displayName?: string }
  | { kind: 'text'; text: string; label?: string };

export interface TimelineBlockPage {
  blocks: TimelineBlock[];
  olderCursor?: string;
  newerCursor?: string;
}

export interface TimelineBlock {
  id: string;
  parentId?: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'custom' | 'error' | 'compaction';
  status: 'pending' | 'streaming' | 'complete' | 'failed' | 'interrupted';
  createdAt?: string;
  source: {
    sessionId: string;
    entryId?: string;
    extensionId?: string;
    type?: string;
  };
  content: JsonValue;
  raw?: JsonValue;
}

export interface SessionChangeEvent {
  sessionId: string;
  revision: number;
  kind: 'snapshot' | 'block-added' | 'block-updated' | 'state' | 'queue' | 'model';
  block?: TimelineBlock;
}

export interface ComposerApi {
  getState(): Promise<ComposerState>;
  replaceText(text: string): Promise<void>;
  insertText(text: string, options?: { at: 'cursor' | 'start' | 'end' }): Promise<void>;
  addAttachment(attachment: ExtensionAttachment): Promise<void>;
  removeAttachment(attachmentId: string): Promise<void>;
  focus(): Promise<void>;
  onDidChange: Event<ComposerState>;
}

export interface ComposerState {
  text: string;
  attachments: Array<{
    id: string;
    kind: 'image' | 'project-file' | 'external-file' | 'extension';
    displayName: string;
    resource?: ResourceRef;
  }>;
  deliveryMode: 'prompt' | 'steer' | 'followUp';
}

export interface ProjectApi {
  getCurrent(): Promise<ProjectSnapshot | null>;
  readText(resource: ResourceRef, options?: { maxBytes?: number }): Promise<TextResource>;
  readBinary(resource: ResourceRef, options?: { maxBytes?: number }): Promise<BinaryResource>;
  stat(resource: ResourceRef): Promise<ResourceStat>;
  list(relativeDirectory: string, options?: { maxEntries?: number }): Promise<ResourceStat[]>;
  writeText(
    resource: ResourceRef,
    text: string,
    options: { expectedRevision?: string; create?: boolean },
  ): Promise<{ revision: string }>;
  onDidChangeResources: Event<{ resources: ResourceRef[] }>;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  displayPath: string;
  trusted: boolean;
}

export interface TextResource {
  resource: ResourceRef;
  text: string;
  encoding: 'utf-8';
  revision: string;
  truncated: boolean;
}

export interface BinaryResource {
  resource: ResourceRef;
  bytes: Uint8Array;
  mime?: string;
  revision: string;
  truncated: boolean;
}

export interface ResourceStat {
  resource: ResourceRef;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes?: number;
  mime?: string;
  modifiedAt?: string;
  revision?: string;
}

export interface ExternalFilesApi {
  pick(options: {
    mode: 'file' | 'files' | 'directory';
    title?: string;
    mime?: string[];
  }): Promise<ResourceRef[]>;
  copyToManaged(resource: ResourceRef): Promise<ResourceRef>;
}

export interface UiApi {
  showInformation(message: string, options?: MessageOptions): Promise<string | undefined>;
  showWarning(message: string, options?: MessageOptions): Promise<string | undefined>;
  showError(message: string, options?: MessageOptions): Promise<string | undefined>;
  showQuickPick<T extends QuickPickItem>(items: readonly T[], options: QuickPickOptions): Promise<T | undefined>;
  showInput(options: InputOptions): Promise<string | undefined>;
  openView(viewId: string, options?: { column?: 'rightPanel' | 'modal'; preserveFocus?: boolean }): Promise<void>;
  closeView(viewId: string): Promise<void>;
  setStatus(itemId: string, update: StatusUpdate | null): Promise<void>;
  render(handlerId: string, handler: DeclarativeRenderHandler): Disposable;
  getTheme(): Promise<ThemeSnapshot>;
  onDidChangeTheme: Event<ThemeSnapshot>;
}

export interface MessageOptions {
  title?: string;
  modal?: boolean;
  actions?: string[];
}

export interface QuickPickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  disabled?: boolean;
}

export interface QuickPickOptions {
  title?: string;
  placeholder?: string;
  canPickMany?: false;
}

export interface InputOptions {
  title?: string;
  prompt?: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
}

export interface StatusUpdate {
  text: string;
  tooltip?: string;
  tone?: Tone;
  command?: string;
}

export type DeclarativeRenderHandler = (
  input: DeclarativeRenderInput,
  context: { signal: AbortSignal },
) => UiNode | Promise<UiNode>;

export interface DeclarativeRenderInput {
  rendererId: string;
  block?: TimelineBlock;
  resource?: ResourceRef;
  data?: JsonValue;
}

export type Tone = 'neutral' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export type UiNode =
  | { type: 'text'; value: string; tone?: Tone; selectable?: boolean }
  | { type: 'markdown'; value: string; trusted: false }
  | { type: 'code'; value: string; language?: string; maxLines?: number }
  | { type: 'icon'; name: string; label?: string }
  | { type: 'badge'; label: string; tone?: Tone }
  | { type: 'image'; source: ResourceRef; alt: string; fit?: 'contain' | 'cover' }
  | { type: 'row'; children: UiNode[]; gap?: 'xs' | 'sm' | 'md'; wrap?: boolean }
  | { type: 'column'; children: UiNode[]; gap?: 'xs' | 'sm' | 'md' }
  | { type: 'separator' }
  | { type: 'button'; label: string; command: string; args?: JsonValue; disabled?: boolean }
  | { type: 'link'; label: string; target: ResourceRef }
  | { type: 'progress'; value?: number; label: string }
  | { type: 'table'; columns: TableColumn[]; rows: JsonValue[][]; maxRows?: number }
  | { type: 'tree'; items: TreeItem[] }
  | { type: 'details'; summary: UiNode[]; children: UiNode[]; open?: boolean }
  | { type: 'empty'; title: string; description?: string; action?: UiAction };

export interface TableColumn {
  id: string;
  label: string;
  align?: 'start' | 'center' | 'end';
}

export interface TreeItem {
  id: string;
  label: string;
  description?: string;
  children?: TreeItem[];
  command?: string;
  args?: JsonValue;
}

export interface UiAction {
  label: string;
  command: string;
  args?: JsonValue;
}

export interface ThemeSnapshot {
  id: string;
  kind: 'light' | 'dark';
  highContrast: boolean;
  reducedMotion: boolean;
  direction: 'ltr' | 'rtl';
  tokens: Readonly<Record<string, string>>;
}

export interface StorageApi {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export interface NetworkApi {
  fetch(input: NetworkRequest): Promise<NetworkResponse>;
}

export interface NetworkRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  finalUrl: string;
  truncated: boolean;
}

export interface ClipboardApi {
  readText(options: { userGesture: true }): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface NotificationsApi {
  show(options: { title: string; body: string; tag?: string }): Promise<void>;
}

export interface SecretsApi {
  createReference(label: string): Promise<SecretRef>;
  has(reference: SecretRef): Promise<boolean>;
  delete(reference: SecretRef): Promise<void>;
  use<T extends JsonValue>(
    reference: SecretRef,
    operation: { kind: 'network-header'; request: NetworkRequest; headerName: string; prefix?: string },
  ): Promise<NetworkResponse>;
}

export interface SecretRef {
  id: string;
  label: string;
}

export interface PiUiHostError extends Error {
  code:
    | 'PERMISSION_DENIED'
    | 'NOT_SUPPORTED'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_ARGUMENT'
    | 'LIMIT_EXCEEDED'
    | 'CANCELLED'
    | 'TIMEOUT'
    | 'INTERNAL_ERROR';
  recoverable: boolean;
  details?: JsonValue;
}

export interface RichViewReadyMessage {
  type: 'piui.view.ready';
  apiVersion: string;
  viewId: string;
  channelToken: string;
}

export interface RichViewInitializeMessage {
  type: 'piui.view.initialize';
  apiVersion: string;
  viewId: string;
  channelToken: string;
  extension: ExtensionIdentity;
  grantedPermissions: ExtensionPermission[];
  theme: ThemeSnapshot;
  locale: string;
  capabilities: Record<string, boolean | string | number | null>;
  state?: JsonValue;
}

export interface RichViewRequestMessage {
  type: 'piui.request';
  id: string;
  channelToken: string;
  method: string;
  params?: JsonValue;
}

export type RichViewResponseMessage =
  | { type: 'piui.response'; id: string; channelToken: string; ok: true; result?: JsonValue }
  | { type: 'piui.response'; id: string; channelToken: string; ok: false; error: { code: string; message: string } };

export interface RichViewEventMessage {
  type: 'piui.event';
  channelToken: string;
  subscriptionId: string;
  event: JsonValue;
}
