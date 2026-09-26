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

it('accepts Claude Code as an additive v15 harness value without changing the catalog shape', async () => {
  const { createWorkspaceClient } = await import('./workspaceClient');
  const kind: import('../../../../contracts/workspace-v15').HarnessKind = 'claude-code';
  const catalog: import('../../../../contracts/workspace-v15').WorkspaceCatalog = {
    ...workspaceFixture.catalog,
    harnesses: [...workspaceFixture.catalog.harnesses, {
      kind, name: 'Claude Code', installed: true, version: '2.1.232', status: 'available',
      reason: 'Sign in to Claude Code with your Claude subscription: run `claude` in a terminal and use /login.',
    }],
  };
  const client = createWorkspaceClient(async () => ({ type: 'catalog', catalog }), async () => () => undefined);
  expect((await client.catalog()).harnesses.map((harness) => harness.kind)).toEqual(['codex', 'claude-code']);
  const command: import('../../../../contracts/workspace-v15').WorkspaceCommand = {
    type: 'createSession', workspaceId: 'workspace', harness: kind, permissionMode: 'read-only',
  };
  expect(Object.keys(command).sort()).toEqual(['harness', 'permissionMode', 'type', 'workspaceId']);
});

describe('harness identity grammar v2', () => {
  it('keeps every v1 identity and adds acp:<descriptor id> without changing any shape', async () => {
    const identity = await import('../../../../contracts/harness-identity-v2');
    expect(identity.HARNESS_IDENTITY_VERSION).toBe(2);
    for (const kind of ['pi', 'prime-agent', 'codex', 'hermes', 'claude-code']) {
      expect(identity.isHarnessId(kind), kind).toBe(true);
      expect(identity.isAcpHarness(kind), kind).toBe(false);
    }
    for (const kind of ['acp:gemini-cli', 'acp:a', 'acp:qwen-code2', `acp:${'x'.repeat(32)}`]) {
      expect(identity.isHarnessId(kind), kind).toBe(true);
      expect(identity.isAcpHarness(kind), kind).toBe(true);
    }
    for (const kind of ['acp:', 'acp:Gemini', 'acp:gemini_cli', 'acp:-x', 'acp:x-', 'acp:gem--ini', `acp:${'x'.repeat(33)}`, 'gemini-cli', 'ACP:gemini-cli', 'claude', 7, null]) {
      expect(identity.isHarnessId(kind), String(kind)).toBe(false);
    }
    expect(identity.acpAgentId('acp:gemini-cli')).toBe('gemini-cli');
    expect(identity.acpHarnessId('gemini-cli')).toBe('acp:gemini-cli');
  });

  it('carries ACP identities through the existing v15 catalog and commands', async () => {
    const { createWorkspaceClient } = await import('./workspaceClient');
    const kind: import('../../../../contracts/workspace-v15').HarnessKind = 'acp:gemini-cli';
    const catalog: import('../../../../contracts/workspace-v15').WorkspaceCatalog = {
      ...workspaceFixture.catalog,
      harnesses: [...workspaceFixture.catalog.harnesses, { kind, name: 'Gemini CLI', installed: true, version: '0.39.1', status: 'available' }],
    };
    const client = createWorkspaceClient(async () => ({ type: 'catalog', catalog }), async () => () => undefined);
    expect((await client.catalog()).harnesses.map((harness) => harness.kind)).toEqual(['codex', 'acp:gemini-cli']);
    const command: import('../../../../contracts/workspace-v15').WorkspaceCommand = {
      type: 'createSession', workspaceId: 'workspace', harness: kind, permissionMode: 'native',
    };
    expect(Object.keys(command).sort()).toEqual(['harness', 'permissionMode', 'type', 'workspaceId']);
    const profile: Pick<import('../../../../contracts/orchestration-v6').AgentProfile, 'harness'> = { harness: kind };
    expect(profile.harness).toBe('acp:gemini-cli');
  });
});

describe('ACP agent descriptor v1 schema', () => {
  it('agrees with the host rules on every shared fixture', async () => {
    const { readdirSync } = await import('node:fs');
    const { default: Ajv } = await import('ajv');
    const schema: unknown = JSON.parse(readFileSync(new URL('../../../../contracts/acp-agent-descriptor-v1.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema as object);
    const directory = new URL('../../../../contracts/fixtures/acp-descriptors/', import.meta.url);
    const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      const document: unknown = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
      // `invalid-semantic-*` documents have a valid shape; only the host rules
      // (regular expression, range order, case-insensitive names) reject them.
      const shapeValid = name.startsWith('valid-') || name.startsWith('invalid-semantic-');
      expect(validate(document), `${name}: ${JSON.stringify(validate.errors)}`).toBe(shapeValid);
    }
  });
});

it('keeps the explicit history read independently versioned without changing workspace v15', async () => {
  const { default: fixture } = await import('../../../../contracts/fixtures/workspace-history-v1.json');
  const request: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryRequestV1 = fixture.request;
  const result: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryResultV1 = { ...fixture.result, protocol: 1 };
  expect(request).toEqual({sessionId:'opaque-session'});
  expect(result).toEqual({protocol:1,sessionId:'opaque-session',blocks:[]});
});
