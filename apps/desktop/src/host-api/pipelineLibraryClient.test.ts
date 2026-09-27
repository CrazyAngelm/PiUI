import { describe, expect, it } from 'vitest';
import {
  createPipelineLibraryClient,
  decodePipelineLibraryResult,
  PIPELINE_LIBRARY_ERROR_COPY,
  PipelineLibraryError,
  pipelineLibraryError,
} from './pipelineLibraryClient';

const TEMPLATE = {
  id: '6f1c2b1e-4d0a-4c35-9d9b-0c2f4e1a7b10',
  name: 'Review pipeline',
  scope: { kind: 'workspace', workspaceId: 'ws' },
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-28T10:00:00.000Z',
  system: { format: 'piui-system', version: 4 },
};

const CHAT = {
  sessionId: 'chat',
  workspaceId: 'ws',
  launchCommandId: 'launch',
  runs: [{ runId: 'r1', startedAt: '2026-09-28T10:00:00.000Z' }, { runId: 'r2', startedAt: '2026-09-28T10:01:00.000Z', consumed: true }],
};

describe('pipeline library v1 client', () => {
  it('decodes every result in the contract shape', () => {
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'library', templates: [TEMPLATE], chatDefault: 'launch' })?.type).toBe('library');
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'library', templates: [] })?.type).toBe('library');
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'template', template: TEMPLATE })?.type).toBe('template');
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'deleted', id: TEMPLATE.id })?.type).toBe('deleted');
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'chat', chat: CHAT })?.type).toBe('chat');
    expect(decodePipelineLibraryResult({ protocol: 1, type: 'chat', chat: null })?.type).toBe('chat');
  });

  it('rejects results outside the contract', () => {
    for (const value of [
      null,
      { protocol: 2, type: 'deleted', id: 'x' },
      { protocol: 1, type: 'other' },
      { protocol: 1, type: 'library', templates: [{ ...TEMPLATE, system: { format: 'other' } }] },
      { protocol: 1, type: 'library', templates: [{ ...TEMPLATE, scope: { kind: 'workspace' } }] },
      { protocol: 1, type: 'library', templates: [], chatDefault: 3 },
      { protocol: 1, type: 'template', template: { ...TEMPLATE, name: '' } },
      { protocol: 1, type: 'chat', chat: { ...CHAT, runs: [{ runId: 'r', startedAt: 'x', consumed: false }] } },
      { protocol: 1, type: 'chat' },
    ]) {
      expect(decodePipelineLibraryResult(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('maps host refusals to typed errors with fixed copy', () => {
    expect(pipelineLibraryError({ code: 'LIMIT', message: 'C:\\secret' })).toMatchObject({ code: 'LIMIT', message: PIPELINE_LIBRARY_ERROR_COPY.LIMIT });
    expect(pipelineLibraryError('{"code":"SAFE_MODE"}').code).toBe('SAFE_MODE');
    expect(pipelineLibraryError({ code: 'unknown' }).code).toBe('unknown');
    expect(pipelineLibraryError({ code: 'GIT_BUSY' }).code).toBe('unknown');
    expect(pipelineLibraryError(new Error('boom')).code).toBe('unknown');
  });

  it('calls its route with the command and refuses malformed answers', async () => {
    const calls: [string, unknown][] = [];
    const answer = (value: unknown) => async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([command, args]);
      return value as T;
    };
    await expect(createPipelineLibraryClient(answer({ protocol: 1, type: 'chat', chat: null })).request({ type: 'chat', sessionId: 'chat' }))
      .resolves.toEqual({ protocol: 1, type: 'chat', chat: null });
    await expect(createPipelineLibraryClient(answer({ protocol: 1, type: 'library' })).request({ type: 'list', workspaceId: 'ws' }))
      .rejects.toBeInstanceOf(PipelineLibraryError);
    const failing = createPipelineLibraryClient(async () => {
      throw { code: 'NOT_FOUND', message: 'That chat is no longer available.', recoverable: true };
    });
    await expect(failing.request({ type: 'deleteTemplate', id: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toEqual([
      ['pipeline_library_v1', { command: { type: 'chat', sessionId: 'chat' } }],
      ['pipeline_library_v1', { command: { type: 'list', workspaceId: 'ws' } }],
    ]);
  });
});
