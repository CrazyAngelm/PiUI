import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workspaceFixture } from '../../../../contracts/fixtures/workspace-v11';

describe('workspace v11 cross-language fixture', () => {
  it('matches the shared Rust golden JSON with compile-time checked public fields', () => {
    const data: unknown = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/workspace-v11.json', import.meta.url), 'utf8'));
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
