import type {
  ChatPipelineV1,
  PipelineLibraryCommandV1,
  PipelineLibraryResultV1,
  PipelineTemplateScopeV1,
  PipelineTemplateV1,
} from '../../../../../contracts/pipeline-library-v1';
import { MAX_CHAT_RUNS, MAX_TEMPLATE_BYTES, MAX_TEMPLATES } from '../../../../../contracts/pipeline-library-v1';
import type { HostErrorPayload } from './labErrors';
import type { LabHandlers } from './labHandlers';
import { arrayOf, decodeArgument, json, object, option, string, tagged } from './labSchema';
import type { LabSessions } from './sessionRuntime';

/**
 * UI Lab fake of `pipeline_library_v1` (ADR-040): pipeline templates and chat
 * pipelines in memory, with the host's validation, limits, safe-mode rules
 * and error codes. Templates are data only; nothing is evaluated or saved as
 * orchestration definitions.
 */
const MAX_ID_BYTES = 128;
const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_CONSUMED_IDS = 1000;

const scopeSchema = tagged('kind', {
  global: {},
  workspace: { workspaceId: string },
});

const commandSchema = tagged('type', {
  list: { workspaceId: string },
  saveTemplate: {
    template: object({
      id: option(string),
      name: string,
      description: option(string),
      scope: scopeSchema,
      system: json,
    }),
  },
  deleteTemplate: { id: string },
  setChatDefault: { workspaceId: string, launchCommandId: option(string) },
  chat: { sessionId: string },
  setChatPipeline: { sessionId: string, workspaceId: string, launchCommandId: option(string) },
  recordChatRun: { sessionId: string, workspaceId: string, runId: string },
  consumeChatRuns: { sessionId: string, runIds: arrayOf(string) },
});

function failure(code: string, message: string): HostErrorPayload {
  return { code, message, recoverable: true };
}

const SAFE_MODE = failure('SAFE_MODE', 'Safe mode is on: PiUI does not change files, git or chats.');
const INVALID = failure('INVALID_ARGUMENT', 'Check the required fields and try again.');
const NOT_FOUND = failure('NOT_FOUND', 'That pipeline template or chat is no longer available.');
const CHAT_NOT_FOUND = failure('NOT_FOUND', 'That chat is no longer available.');
const LIMIT = failure('LIMIT', 'The pipeline library is full. Delete a template, then try again.');

const CONTROL = /\p{Cc}/u;
const encoder = new TextEncoder();

function chars(value: string): number {
  return [...value].length;
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && encoder.encode(id).length <= MAX_ID_BYTES && !CONTROL.test(id);
}

function requireId(id: unknown): asserts id is string {
  if (!validId(id)) throw INVALID;
}

function validScope(scope: PipelineTemplateScopeV1): boolean {
  return scope.kind === 'global' || validId(scope.workspaceId);
}

function validSystem(system: unknown): system is Record<string, unknown> {
  return typeof system === 'object'
    && system !== null
    && !Array.isArray(system)
    && (system as Record<string, unknown>).format === 'piui-system'
    && encoder.encode(JSON.stringify(system)).length <= MAX_TEMPLATE_BYTES;
}

interface TemplateDraft {
  id?: string;
  name: string;
  description?: string;
  scope: PipelineTemplateScopeV1;
  system: unknown;
}

/** In-memory library state of one lab host (exported for tests). */
export interface LabPipelineLibrary {
  templates: PipelineTemplateV1[];
  chatDefaults: Map<string, string>;
  chats: Map<string, ChatPipelineV1>;
}

export function createPipelineLibrary(): LabPipelineLibrary {
  return { templates: [], chatDefaults: new Map(), chats: new Map() };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function pipelineLibraryHandlers(runtime: LabSessions, library: LabPipelineLibrary = createPipelineLibrary()): LabHandlers {
  const { state } = runtime;

  function list(workspaceId: string): PipelineLibraryResultV1 {
    requireId(workspaceId);
    const templates = library.templates
      .filter((template) => template.scope.kind === 'global' || template.scope.workspaceId === workspaceId)
      .map(copy)
      .sort((a, b) => {
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        if (left !== right) return left < right ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    const chatDefault = library.chatDefaults.get(workspaceId);
    return { protocol: 1, type: 'library', templates, ...(chatDefault === undefined ? {} : { chatDefault }) };
  }

  function saveTemplate(decoded: TemplateDraft): PipelineLibraryResultV1 {
    // `Option` fields may arrive as null, exactly as serde accepts them.
    const draft: TemplateDraft = { ...decoded, id: decoded.id ?? undefined, description: decoded.description ?? undefined };
    const name = draft.name.trim();
    const nameLength = chars(name);
    if (nameLength < 1 || nameLength > MAX_NAME_CHARS || CONTROL.test(name)) throw INVALID;
    if (draft.description !== undefined && chars(draft.description) > MAX_DESCRIPTION_CHARS) throw INVALID;
    if (!validScope(draft.scope) || !validSystem(draft.system)) throw INVALID;
    const system = copy(draft.system);
    const now = runtime.clock.iso();
    const description = draft.description === undefined ? {} : { description: draft.description };
    if (draft.id !== undefined) {
      requireId(draft.id);
      const index = library.templates.findIndex((template) => template.id === draft.id);
      const existing = library.templates[index];
      if (existing === undefined) throw NOT_FOUND;
      const replaced: PipelineTemplateV1 = {
        id: existing.id,
        name,
        ...description,
        scope: copy(draft.scope),
        createdAt: existing.createdAt,
        updatedAt: now,
        system,
      };
      library.templates[index] = replaced;
      return { protocol: 1, type: 'template', template: copy(replaced) };
    }
    if (library.templates.length >= MAX_TEMPLATES) throw LIMIT;
    const template: PipelineTemplateV1 = {
      id: state.ids.next('pipeline-template'),
      name,
      ...description,
      scope: copy(draft.scope),
      createdAt: now,
      updatedAt: now,
      system,
    };
    library.templates.push(template);
    return { protocol: 1, type: 'template', template: copy(template) };
  }

  function deleteTemplate(id: string): PipelineLibraryResultV1 {
    requireId(id);
    const index = library.templates.findIndex((template) => template.id === id);
    if (index < 0) throw NOT_FOUND;
    library.templates.splice(index, 1);
    return { protocol: 1, type: 'deleted', id };
  }

  function setChatDefault(workspaceId: string, launchCommandId: string | undefined): PipelineLibraryResultV1 {
    requireId(workspaceId);
    if (launchCommandId === undefined) {
      library.chatDefaults.delete(workspaceId);
    } else {
      requireId(launchCommandId);
      library.chatDefaults.set(workspaceId, launchCommandId);
    }
    return list(workspaceId);
  }

  function chatResult(chat: ChatPipelineV1 | undefined): PipelineLibraryResultV1 {
    return { protocol: 1, type: 'chat', chat: chat === undefined ? null : copy(chat) };
  }

  /** The chat must exist, belong to `workspaceId` and not be a run's chat. */
  function checkChat(sessionId: string, workspaceId: string): void {
    requireId(sessionId);
    requireId(workspaceId);
    const record = state.sessions.get(sessionId);
    if (record === undefined || record.workspaceId !== workspaceId || record.runId !== undefined) throw CHAT_NOT_FOUND;
  }

  function entry(sessionId: string, workspaceId: string): ChatPipelineV1 {
    const existing = library.chats.get(sessionId);
    if (existing !== undefined) {
      if (existing.workspaceId !== workspaceId) throw NOT_FOUND;
      return existing;
    }
    return { sessionId, workspaceId, runs: [] };
  }

  function setChatPipeline(sessionId: string, workspaceId: string, launchCommandId: string | undefined): PipelineLibraryResultV1 {
    checkChat(sessionId, workspaceId);
    if (launchCommandId !== undefined) requireId(launchCommandId);
    const current = entry(sessionId, workspaceId);
    const next: ChatPipelineV1 = {
      sessionId: current.sessionId,
      workspaceId: current.workspaceId,
      ...(launchCommandId === undefined ? {} : { launchCommandId }),
      runs: current.runs,
    };
    if (next.launchCommandId === undefined && next.runs.length === 0) {
      library.chats.delete(sessionId);
      return chatResult(undefined);
    }
    library.chats.set(sessionId, next);
    return chatResult(next);
  }

  function recordChatRun(sessionId: string, workspaceId: string, runId: string): PipelineLibraryResultV1 {
    checkChat(sessionId, workspaceId);
    requireId(runId);
    const chat = entry(sessionId, workspaceId);
    if (!chat.runs.some((run) => run.runId === runId)) {
      const runs = [...chat.runs, { runId, startedAt: runtime.clock.iso() }];
      chat.runs = runs.slice(Math.max(0, runs.length - MAX_CHAT_RUNS));
      library.chats.set(sessionId, chat);
    }
    return chatResult(chat);
  }

  function consumeChatRuns(sessionId: string, runIds: string[]): PipelineLibraryResultV1 {
    requireId(sessionId);
    if (runIds.length > MAX_CONSUMED_IDS || !runIds.every(validId)) throw INVALID;
    const chat = library.chats.get(sessionId);
    if (chat === undefined) return chatResult(undefined);
    const wanted = new Set(runIds);
    chat.runs = chat.runs.map((run) => (wanted.has(run.runId) ? { ...run, consumed: true as const } : run));
    return chatResult(chat);
  }

  function dispatch(command: PipelineLibraryCommandV1): PipelineLibraryResultV1 {
    if (state.safeMode && command.type !== 'list' && command.type !== 'chat') throw SAFE_MODE;
    switch (command.type) {
      case 'list':
        return list(command.workspaceId);
      case 'saveTemplate':
        return saveTemplate(command.template);
      case 'deleteTemplate':
        return deleteTemplate(command.id);
      case 'setChatDefault':
        return setChatDefault(command.workspaceId, command.launchCommandId ?? undefined);
      case 'chat':
        requireId(command.sessionId);
        return chatResult(library.chats.get(command.sessionId));
      case 'setChatPipeline':
        return setChatPipeline(command.sessionId, command.workspaceId, command.launchCommandId ?? undefined);
      case 'recordChatRun':
        return recordChatRun(command.sessionId, command.workspaceId, command.runId);
      case 'consumeChatRuns':
        return consumeChatRuns(command.sessionId, command.runIds);
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  return {
    pipeline_library_v1: (args) => dispatch(decodeArgument<PipelineLibraryCommandV1>(args, 'command', commandSchema)),
  };
}
