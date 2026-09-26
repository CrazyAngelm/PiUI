import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workspaceFixture } from '../../../../contracts/fixtures/workspace-v15';

describe('workspace v11 cross-language fixture', () => {
  it('matches the shared Rust golden JSON with compile-time checked public fields', () => {
    const data: unknown = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/workspace-v15.json', import.meta.url), 'utf8'));
    expect(workspaceFixture).toEqual(data);
  });
  it('contains no native identity, path, actor, executable, or credential fields', () => {
    const forbidden = new Set(['nativeId', 'nativePath', 'cwd', 'runtimeProgram', 'runtimeArgs', 'agentDir', 'packageRoot', 'sender', 'auth', 'apiKey']);
    function check(value: unknown): void {
      if (Array.isArray(value)) { for (const item of value) check(item); return; }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) { expect(forbidden.has(key), key).toBe(false); check(item); }
      }
    }
    check(workspaceFixture);
  });
});

it('keeps the explicit history read independently versioned without changing workspace v15', async () => {
  const { default: fixture } = await import('../../../../contracts/fixtures/workspace-history-v1.json');
  const request: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryRequestV1 = fixture.request;
  const result: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryResultV1 = { ...fixture.result, protocol: 1 };
  expect(request).toEqual({sessionId:'opaque-session'});
  expect(result).toEqual({protocol:1,sessionId:'opaque-session',blocks:[]});
});
