/**
 * PiUI pipeline library protocol v1 (`pipeline_library_v1`): pipeline
 * templates and chat pipelines (ADR-040). Independently versioned;
 * orchestration v6, workspace v15 and the system file format are unchanged.
 *
 * - A template is a portable `piui-system` document (system-file v4 or an
 *   older importable version) with a name. `global` templates are offered in
 *   every project; `workspace` templates only in theirs. The host stores the
 *   document as data: it checks only its size and `format`, never evaluates
 *   it, and never turns it into saved definitions. Using a template is a
 *   separate, user-visible save through orchestration v6 (`save_graph`).
 * - A chat pipeline binds an ordinary workspace chat to one saved launch
 *   command of its project. A message sent through it starts a run with the
 *   `chat` trigger and a `message` input; `runs` lists those runs in order so
 *   the chat can show them. The binding is UI metadata: runs keep their own
 *   `trigger.sessionId`, and the native chat history is never changed.
 * - `chatDefault` is the launch command a project's new chats start with;
 *   absent means new chats talk to the harness directly.
 *
 * `list` and `chat` work in safe mode; every change is refused there
 * (`SAFE_MODE`). Ids are opaque; templates get a host-generated UUID.
 */
export const PIPELINE_LIBRARY_PROTOCOL = 1 as const;

/** Largest serialized template document, in UTF-8 bytes. */
export const MAX_TEMPLATE_BYTES = 256 * 1024;
/** Most templates in the library (global and every project together). */
export const MAX_TEMPLATES = 200;
/** Most runs remembered per chat; the oldest are forgotten first. */
export const MAX_CHAT_RUNS = 200;

export type PipelineTemplateScopeV1 = { kind: 'global' } | { kind: 'workspace'; workspaceId: string };

export interface PipelineTemplateV1 {
  /** Host-generated UUID. */
  id: string;
  /** 1–120 characters. */
  name: string;
  /** At most 500 characters. */
  description?: string;
  scope: PipelineTemplateScopeV1;
  /** Host time the template was first saved (ISO 8601). */
  createdAt: string;
  /** Host time of the last save (ISO 8601). */
  updatedAt: string;
  /** A `piui-system` document; `format` must be `"piui-system"`. */
  system: Record<string, unknown>;
}

export interface ChatPipelineRunV1 {
  runId: string;
  /** Host time the run was recorded (ISO 8601); orders the run in the chat. */
  startedAt: string;
  /** Its result was handed to the chat in a later message. */
  consumed?: true;
}

export interface ChatPipelineV1 {
  sessionId: string;
  workspaceId: string;
  /** Messages go through this launch command; absent sends them directly. */
  launchCommandId?: string;
  runs: ChatPipelineRunV1[];
}

export interface TemplateDraftV1 {
  /** Present to replace an existing template. */
  id?: string;
  name: string;
  description?: string;
  scope: PipelineTemplateScopeV1;
  system: Record<string, unknown>;
}

export type PipelineLibraryCommandV1 =
  /** Global templates, this project's templates and its chat default. */
  | { type: 'list'; workspaceId: string }
  | { type: 'saveTemplate'; template: TemplateDraftV1 }
  | { type: 'deleteTemplate'; id: string }
  /** Without `launchCommandId` new chats of the project talk directly. */
  | { type: 'setChatDefault'; workspaceId: string; launchCommandId?: string }
  | { type: 'chat'; sessionId: string }
  /** The chat must belong to `workspaceId`. Without `launchCommandId` it talks directly. */
  | { type: 'setChatPipeline'; sessionId: string; workspaceId: string; launchCommandId?: string }
  /** Records a run started from the chat; repeating a recorded run id changes nothing. */
  | { type: 'recordChatRun'; sessionId: string; workspaceId: string; runId: string }
  /** Marks runs whose result the chat has handed on. Unknown ids are ignored. */
  | { type: 'consumeChatRuns'; sessionId: string; runIds: string[] };

export type PipelineLibraryResultV1 =
  | { protocol: 1; type: 'library'; templates: PipelineTemplateV1[]; chatDefault?: string }
  | { protocol: 1; type: 'template'; template: PipelineTemplateV1 }
  | { protocol: 1; type: 'deleted'; id: string }
  | { protocol: 1; type: 'chat'; chat: ChatPipelineV1 | null };

export type PipelineLibraryErrorCode =
  | 'SAFE_MODE'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'LIMIT'
  | 'IO_ERROR';

export interface PipelineLibraryErrorV1 {
  code: PipelineLibraryErrorCode;
  message: string;
  recoverable: boolean;
}
