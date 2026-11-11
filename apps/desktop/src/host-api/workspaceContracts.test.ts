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

it('accepts Nano as an additive v15 harness value and words its sign-in refusal', async () => {
  const { createWorkspaceClient, workspaceError } = await import('./workspaceClient');
  const kind: import('../../../../contracts/workspace-v15').HarnessKind = 'nano';
  const model: import('../../../../contracts/workspace-v15').WorkspaceModel = { id: 'auto', provider: 'nano', name: 'Auto' };
  const catalog: import('../../../../contracts/workspace-v15').WorkspaceCatalog = {
    ...workspaceFixture.catalog,
    harnesses: [...workspaceFixture.catalog.harnesses, { kind, name: 'Nano', installed: true, version: '1.4.0', status: 'available' }],
  };
  const client = createWorkspaceClient(async () => ({ type: 'catalog', catalog }), async () => () => undefined);
  expect((await client.catalog()).harnesses.map((harness) => harness.kind)).toEqual(['codex', 'nano']);
  const command: import('../../../../contracts/workspace-v15').WorkspaceCommand = {
    type: 'createSession', workspaceId: 'workspace', harness: kind, permissionMode: 'native', model,
  };
  expect(Object.keys(command).sort()).toEqual(['harness', 'model', 'permissionMode', 'type', 'workspaceId']);
  // The refusal of a signed-out Nano start has its own code and fixed copy: no host text reaches the UI.
  const refusal = workspaceError({ code: 'NANO_SIGN_IN_REQUIRED', message: 'token expired for user@example.com' });
  expect(refusal.code).toBe('NANO_SIGN_IN_REQUIRED');
  expect(refusal.message).toBe('Sign in to your Nano account to use Nano.');
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

describe('harness identity grammar v3', () => {
  it('keeps every v2 identity and adds nano without changing any shape', async () => {
    const identity = await import('../../../../contracts/harness-identity-v3');
    const historical = await import('../../../../contracts/harness-identity-v2');
    expect(identity.HARNESS_IDENTITY_VERSION).toBe(3);
    expect(historical.HARNESS_IDENTITY_VERSION).toBe(2);
    // v3 is v2 plus exactly one built-in; v2 stays the frozen historical grammar.
    expect(identity.BUILTIN_HARNESSES).toEqual([...historical.BUILTIN_HARNESSES, 'nano']);
    expect(historical.isHarnessId('nano')).toBe(false);
    expect(identity.isBuiltinHarness('nano') && identity.isHarnessId('nano') && !identity.isAcpHarness('nano')).toBe(true);
    expect(identity.isHarnessId('Nano')).toBe(false);
    expect(identity.isHarnessId('acp:nano')).toBe(true);
  });

  it('keeps every v1 identity and adds acp:<descriptor id> without changing any shape', async () => {
    const identity = await import('../../../../contracts/harness-identity-v3');
    for (const kind of ['pi', 'prime-agent', 'codex', 'hermes', 'claude-code', 'nano']) {
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

describe('harness registry v1', () => {
  it('matches the shared Rust golden JSON with compile-time checked fields', async () => {
    const { harnessRegistryFixture } = await import('../../../../contracts/fixtures/harness-registry-v1');
    const data: unknown = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/harness-registry-v1.json', import.meta.url), 'utf8'));
    expect(harnessRegistryFixture).toEqual(data);
  });
  it('carries names and fixed texts only: no credential, environment value or native session field', async () => {
    const { harnessRegistryFixture } = await import('../../../../contracts/fixtures/harness-registry-v1');
    const forbidden = new Set(['nativeId', 'nativePath', 'apiKey', 'token', 'env', 'credentials', 'auth']);
    function check(value: unknown): void {
      if (Array.isArray(value)) { for (const item of value) check(item); return; }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) { expect(forbidden.has(key), key).toBe(false); check(item); }
      }
    }
    check(harnessRegistryFixture);
    // Additive v15 snapshot field for agent-advertised session modes.
    const modes: NonNullable<import('../../../../contracts/workspace-v15').SessionSnapshot['modes']> = {
      current: 'default',
      available: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read-only' }],
    };
    expect(modes.available).toHaveLength(2);
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

describe('harness models v18 request part', () => {
  type HarnessModelsRequest = import('../../../../contracts/harness-models-v18').HarnessModelsRequest;
  type HarnessCatalogPart = import('../../../../contracts/harness-models-v18').HarnessCatalogPart;
  // The Rust host decodes the same document in its `workspace_api` tests.
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/harness-models-v18.json', import.meta.url), 'utf8')) as {
    accepted: { request: HarnessModelsRequest; expectedPart: HarnessCatalogPart | null }[];
    rejected: { reason: string; request: unknown }[];
  };
  it('keeps a request without `part` valid and adds `models` and `resources` without a version bump', async () => {
    const { decode } = await import('./lab/labSchema');
    const { harnessModelsRequestSchema } = await import('./lab/labSchemas');
    expect(fixture.accepted.map(({ expectedPart }) => expectedPart)).toEqual([null, 'models', 'resources']);
    expect(Object.keys(fixture.accepted[0].request).sort(), 'the earlier v18 request shape').toEqual(['harness', 'workspaceId']);
    for (const { request, expectedPart } of fixture.accepted) {
      expect(decode<HarnessModelsRequest>(harnessModelsRequestSchema, request).part ?? null, JSON.stringify(request)).toBe(expectedPart);
    }
  });
  it('rejects an unknown part and unknown request fields', async () => {
    const { decode } = await import('./lab/labSchema');
    const { harnessModelsRequestSchema } = await import('./lab/labSchemas');
    expect(fixture.rejected.length).toBeGreaterThanOrEqual(3);
    for (const { reason, request } of fixture.rejected) {
      expect(() => decode(harnessModelsRequestSchema, request), reason).toThrow();
    }
  });
});
