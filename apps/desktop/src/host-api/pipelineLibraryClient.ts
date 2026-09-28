import { hostInvoke, type HostInvoke } from './transport';
import type {
  ChatPipelineRunV1,
  ChatPipelineV1,
  PipelineLibraryCommandV1,
  PipelineLibraryErrorCode,
  PipelineLibraryResultV1,
  PipelineTemplateScopeV1,
  PipelineTemplateV1,
} from '../../../../contracts/pipeline-library-v1';
import { isRecord } from './sessionToolErrors';

export type * from '../../../../contracts/pipeline-library-v1';

/**
 * Client of `pipeline_library_v1` (ADR-040): pipeline templates and chat
 * pipelines. Templates are data; using one is a separate orchestration save.
 */

/** Fixed copy per refusal code; host text never reaches the UI. */
export const PIPELINE_LIBRARY_ERROR_COPY: Readonly<Record<PipelineLibraryErrorCode | 'unknown', string>> = {
  SAFE_MODE: 'Safe mode is on: PiUI does not change pipelines or chats.',
  INVALID_ARGUMENT: 'Check the template or chat details and try again.',
  NOT_FOUND: 'This template or chat is no longer available. Refresh and try again.',
  LIMIT: 'The pipeline library is full. Delete a template, then try again.',
  IO_ERROR: 'PiUI could not save the pipeline library. Nothing was lost.',
  unknown: 'The operation could not be completed.',
};

export type PipelineLibraryErrorKind = PipelineLibraryErrorCode | 'unknown';

export class PipelineLibraryError extends Error {
  constructor(readonly code: PipelineLibraryErrorKind, message: string = PIPELINE_LIBRARY_ERROR_COPY[code]) {
    super(message);
    this.name = 'PipelineLibraryError';
  }
}

function isErrorCode(value: unknown): value is PipelineLibraryErrorCode {
  return typeof value === 'string' && value !== 'unknown' && Object.hasOwn(PIPELINE_LIBRARY_ERROR_COPY, value);
}

/** Maps a rejected invoke to a typed error with safe copy. */
export function pipelineLibraryError(cause: unknown): PipelineLibraryError {
  if (cause instanceof PipelineLibraryError) return cause;
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  const code = isRecord(value) && isErrorCode(value.code) ? value.code : 'unknown';
  return new PipelineLibraryError(code);
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';

function isScope(value: unknown): value is PipelineTemplateScopeV1 {
  return isRecord(value) && (value.kind === 'global' || (value.kind === 'workspace' && text(value.workspaceId)));
}

function isTemplate(value: unknown): value is PipelineTemplateV1 {
  return isRecord(value)
    && text(value.id)
    && text(value.name)
    && optionalText(value.description)
    && isScope(value.scope)
    && text(value.createdAt)
    && text(value.updatedAt)
    && isRecord(value.system)
    && value.system.format === 'piui-system';
}

function isRun(value: unknown): value is ChatPipelineRunV1 {
  return isRecord(value) && text(value.runId) && text(value.startedAt) && (value.consumed === undefined || value.consumed === true);
}

function isChat(value: unknown): value is ChatPipelineV1 {
  return isRecord(value)
    && text(value.sessionId)
    && text(value.workspaceId)
    && (value.launchCommandId === undefined || text(value.launchCommandId))
    && Array.isArray(value.runs)
    && value.runs.every(isRun);
}

export function decodePipelineLibraryResult(value: unknown): PipelineLibraryResultV1 | undefined {
  if (!isRecord(value) || value.protocol !== 1) return undefined;
  switch (value.type) {
    case 'library':
      return Array.isArray(value.templates) && value.templates.every(isTemplate) && (value.chatDefault === undefined || text(value.chatDefault))
        ? (value as unknown as PipelineLibraryResultV1)
        : undefined;
    case 'template':
      return isTemplate(value.template) ? (value as unknown as PipelineLibraryResultV1) : undefined;
    case 'deleted':
      return text(value.id) ? (value as unknown as PipelineLibraryResultV1) : undefined;
    case 'chat':
      return value.chat === null || isChat(value.chat) ? (value as unknown as PipelineLibraryResultV1) : undefined;
    default:
      return undefined;
  }
}

export interface PipelineLibraryClient {
  request(command: PipelineLibraryCommandV1): Promise<PipelineLibraryResultV1>;
}

export function createPipelineLibraryClient(invoke: HostInvoke): PipelineLibraryClient {
  return {
    async request(command) {
      let result: unknown;
      try {
        result = await invoke<unknown>('pipeline_library_v1', { command });
      } catch (error) {
        throw pipelineLibraryError(error);
      }
      const decoded = decodePipelineLibraryResult(result);
      if (decoded === undefined) throw new PipelineLibraryError('unknown');
      return decoded;
    },
  };
}

export const pipelineLibraryHost: PipelineLibraryClient = createPipelineLibraryClient((command, args) => hostInvoke(command, args));
