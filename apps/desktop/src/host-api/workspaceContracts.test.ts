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

it('carries MCP form requests as an additive v15 approval field without changing other approvals', () => {
  const approvals: readonly import('../../../../contracts/workspace-v15').WorkspaceApproval[] = workspaceFixture.snapshot.approvals;
  // Approvals without a form keep their exact earlier v15 shape.
  expect(approvals.filter((approval) => approval.form === undefined).map((approval) => approval.id)).toEqual(['approval-fixture', 'approval-select-fixture']);
  const form = approvals.find((approval) => approval.id === 'approval-form-fixture');
  expect(form?.form?.fields.map((field) => field.type)).toEqual(['text', 'number', 'boolean', 'choice']);
  // Only opaque ids and native labels cross the boundary: no schema or native property names.
  expect(JSON.stringify(form)).not.toMatch(/"(properties|requestedSchema|enum|const|name)"/);
  const answer: import('../../../../contracts/workspace-v15').WorkspaceCommand = {
    type: 'respond', sessionId: 'session', requestId: 'approval-form-fixture', decision: 'approve-once',
    text: JSON.stringify({ 'field-1': 'Fixture', 'field-4': 'choice-2' }),
  };
  expect(Object.keys(answer).sort()).toEqual(['decision', 'requestId', 'sessionId', 'text', 'type']);
});

it('keeps the explicit history read independently versioned without changing workspace v15', async () => {
  const { default: fixture } = await import('../../../../contracts/fixtures/workspace-history-v1.json');
  const request: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryRequestV1 = fixture.request;
  const result: import('../../../../contracts/workspace-history-v1').WorkspaceHistoryResultV1 = { ...fixture.result, protocol: 1 };
  expect(request).toEqual({sessionId:'opaque-session'});
  expect(result).toEqual({protocol:1,sessionId:'opaque-session',blocks:[]});
});
