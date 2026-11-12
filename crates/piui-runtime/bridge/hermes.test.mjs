import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHermesAdapter } from './hermes.mjs';
const config = { harness: 'hermes', cwd: process.cwd(), agentDir: process.cwd(), permissionMode: 'native', runtimeProgram: process.execPath, runtimeArgs: [fileURLToPath(new URL('./hermes.test-fixture.mjs', import.meta.url))] };
function events() {
  const values = [], waiters = [];
  return { values, emit(value) { values.push(value); for (const waiter of waiters) if (waiter.p(value)) waiter.resolve(value); }, next(p) { return new Promise(resolve => waiters.push({ p, resolve })); } };
}
test('catalog-only Hermes lists models while independent resource discovery is pending or fails', async () => {
  const invocations = [];
  const spawnInventory = (_program, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const finish = (code, payload) => {
      child.stdout.end(payload === undefined ? undefined : JSON.stringify(payload));
      child.emit('exit', code);
      child.emit('close', code);
    };
    child.kill = () => finish(1);
    assert.deepEqual(args.slice(0, 2), ['-P', '-c']);
    invocations.push({ source: args[2], finish });
    return child;
  };
  const adapter = await createHermesAdapter({ ...config, catalogOnly: true }, () => {}, undefined, undefined, undefined, spawnInventory);
  try {
    assert.equal(invocations.length, 0);
    const resources = adapter.resources();
    const models = adapter.catalogModels();
    assert.match(invocations[0].source, /_find_all_skills/);
    assert.doesNotMatch(invocations[0].source, /piui_model_state/);
    assert.match(invocations[1].source, /piui_model_state/);
    assert.doesNotMatch(invocations[1].source, /_find_all_skills|get_tool_definitions/);
    const model = { id: 'fixture-model', name: 'Fixture Model', supportsFast: false };
    invocations[1].finish(0, [model]);
    assert.deepEqual(await models, [model]);
    invocations[0].finish(1);
    await assert.rejects(resources, { bridgeCode: 'catalog-unavailable' });
    assert.deepEqual(await adapter.models(), [{ id: model.id, name: model.name }]);

    const retry = adapter.resources();
    assert.equal(invocations.length, 3);
    const partial = { items: [{ kind: 'mcp', id: 'fixture', name: 'fixture', enabled: true, configurable: false }], warnings: ['Hermes skill inventory is unavailable.'] };
    invocations[2].finish(0, partial);
    assert.deepEqual(await retry, partial);
  } finally { await adapter.dispose(); }
});

test('native ACP streams LF-framed text and preserves generic fallback', async () => {
  const e = events(); const a = await createHermesAdapter(config, e.emit);
  try {
    const done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'hello', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    assert.deepEqual(e.values.filter(v => v.type === 'usage').map(v => ({...v.usage,id:'receipt'})), [{id:'receipt',inputTokens:10,outputTokens:4,cacheReadTokens:2,totalTokens:14}]);
    assert.ok(a.snapshot().blocks.some(b => b.text === 'hello\u2028world'));
    assert.ok(a.snapshot().blocks.some(b => b.fallback));
    assert.equal((await a.catalogModels())[0].supportsFast, false);
  } finally { await a.dispose(); }
});
test('resume replays native history and rejects missing or foreign sessions', async () => {
  const a = await createHermesAdapter({ ...config, nativeId: 'saved' }, () => {});
  assert.equal(a.snapshot().blocks[0].text, 'native history'); await a.dispose();
  await assert.rejects(createHermesAdapter({ ...config, nativeId: 'missing' }, () => {}), { bridgeCode: 'invalid-session' });
  await assert.rejects(createHermesAdapter({ ...config, nativeId: 'saved', runtimeArgs: [...config.runtimeArgs, '--wrong-cwd'] }, () => {}), { bridgeCode: 'invalid-session' });
});
test('permissions are native request responses and cancellation is terminal', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    const approval = e.next(v => v.type === 'approval'), done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'approve', mode: 'prompt' }); await approval;
    assert.equal(a.snapshot().approvals.length, 1);
    await a.respond({ requestId: 'permission', decision: 'approve-once' });
    assert.equal((await done).outcome, 'succeeded');
    const cancelled = e.next(v => v.type === 'turnCompleted' && v.outcome === 'interrupted');
    await a.prompt({ text: 'wait', mode: 'prompt' }); await a.interrupt(); await cancelled;
    assert.equal(a.snapshot().approvals.length, 0);
  } finally { await a.dispose(); }
});
test('managed sessions route native MCP calls to the host coordinator', async () => {
  const calls = [];
  const a = await createHermesAdapter({ ...config, coordination: true }, () => {}, async request => { calls.push(request); return { members: [] }; });
  try { assert.deepEqual(calls, [{ type: 'roster' }]); } finally { await a.dispose(); }
});
test('a plugin MCP server reaches Hermes as a stdio server for this session only (plugins v2)', async () => {
  const server = { name: 'example-tool-cards-issues', command: process.execPath, args: ['--permission', 'server.mjs', '--stdio'] };
  const events = [];
  const adapter = await createHermesAdapter({ ...config, pluginMcpServers: [server] }, event => events.push(event));
  try {
    const text = JSON.stringify(events.concat(adapter.snapshot?.()?.blocks ?? []));
    assert.ok(text.includes('example-tool-cards-issues'), 'the session received the plugin server');
  } finally { await adapter.dispose(); }
  await assert.rejects(createHermesAdapter({ ...config, pluginMcpServers: [{ ...server, command: 'node' }] }, () => {}), { bridgeCode: 'unsupported-settings' });
});

test('unsupported mandatory settings fail before spawning', async () => {
  for (const override of [{ permissionMode: 'read-only' }, { serviceTier: 'fast' }, { allowedTools: [] }, { resourceRules: [{ kind: 'skill', id: 'x', enabled: false }] }, { nativeSubagents: false }, { baseInstructions: '' }, { thinkingLevel: 'high' }]) {
    await assert.rejects(createHermesAdapter({ ...config, ...override, runtimeProgram: 'must-not-launch' }, () => {}), { bridgeCode: 'unsupported-settings' });
  }
});

test('an idle follow-up is delivered immediately and steer stays unsupported', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    const done = e.next(v => v.type === 'turnCompleted');
    assert.deepEqual(await a.prompt({ text: 'follow: now', mode: 'follow-up' }), { accepted: true });
    assert.equal(a.snapshot().status, 'running');
    assert.equal((await done).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'ack follow: now'));
    assert.equal(a.snapshot().status, 'idle');
    await assert.rejects(a.prompt({ text: 'redirect', mode: 'steer' }), { bridgeCode: 'unsupported-method' });
    await assert.rejects(a.prompt({ text: '  ', mode: 'follow-up' }), { bridgeCode: 'invalid-request' });
  } finally { await a.dispose(); }
});

test('follow-ups sent during a turn run next in FIFO order without an idle gap', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    let completed = 0;
    const all = e.next(v => v.type === 'turnCompleted' && ++completed === 3);
    const firstStatus = e.values.length;
    await a.prompt({ text: 'slow', mode: 'prompt' });
    assert.deepEqual(await a.prompt({ text: 'follow: one', mode: 'follow-up' }), { accepted: true });
    assert.deepEqual(await a.prompt({ text: 'follow: two', mode: 'follow-up' }), { accepted: true });
    await assert.rejects(a.prompt({ text: 'not queued', mode: 'prompt' }), { bridgeCode: 'busy' });
    assert.ok(!a.snapshot().blocks.some(b => b.text === 'follow: one'), 'queued until the running turn ends');
    await all;
    const transcript = a.snapshot().blocks.filter(b => b.kind === 'user' || b.kind === 'assistant').map(b => b.text);
    assert.deepEqual(transcript, ['slow', 'ack slow', 'follow: one', 'ack follow: one', 'follow: two', 'ack follow: two']);
    assert.deepEqual(e.values.filter(v => v.type === 'turnCompleted').map(v => v.outcome), ['succeeded', 'succeeded', 'succeeded']);
    const statuses = e.values.slice(firstStatus).filter(v => v.type === 'status').map(v => v.status);
    assert.deepEqual(statuses.filter(s => s === 'idle'), ['idle'], 'idle only after the last queued turn');
    assert.equal(statuses.at(-1), 'idle');
  } finally { await a.dispose(); }
});

test('a failed native prompt ends the turn, not the session, and keeps queued follow-ups', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    let completed = 0;
    const both = e.next(v => v.type === 'turnCompleted' && ++completed === 2);
    await a.prompt({ text: 'slow-reject', mode: 'prompt' });
    await a.prompt({ text: 'follow: after failure', mode: 'follow-up' });
    await both;
    assert.deepEqual(e.values.filter(v => v.type === 'turnCompleted').map(v => v.outcome), ['failed', 'succeeded']);
    assert.ok(a.snapshot().blocks.some(b => b.text === 'ack follow: after failure'));
    const error = a.snapshot().blocks.find(b => b.kind === 'error');
    assert.equal(error.status, 'failed');
    assert.equal(error.safeSummary, 'Hermes could not complete session/prompt (provider, -32603).');
    assert.ok(e.values.some(v => v.type === 'error' && v.message === error.safeSummary));
    assert.ok(!e.values.some(v => v.type === 'status' && v.status === 'failed'));
    assert.equal(a.snapshot().status, 'idle');

    const rejected = e.next(v => v.type === 'turnCompleted' && v.outcome === 'failed');
    await a.prompt({ text: 'reject', mode: 'prompt' });
    await rejected;
    assert.equal(a.snapshot().status, 'idle');
    const recovered = e.next(v => v.type === 'turnCompleted' && v.outcome === 'succeeded');
    await a.prompt({ text: 'hello', mode: 'prompt' });
    await recovered;
    assert.equal(a.snapshot().blocks.filter(b => b.kind === 'error').length, 2, 'failures stay visible');
    assert.doesNotMatch(JSON.stringify(e.values), /SECRET-MUST-NOT-LEAK/);
  } finally { await a.dispose(); }
});

test('dispose rejects follow-ups that were never delivered', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  await a.prompt({ text: 'wait', mode: 'prompt' });
  await a.prompt({ text: 'follow: never', mode: 'follow-up' });
  const settled = e.next(v => v.type === 'turnCompleted');
  await a.dispose();
  await settled;
  assert.ok(e.values.some(v => v.type === 'error' && /not delivered/.test(v.message)));
  assert.ok(!a.snapshot().blocks.some(b => b.text === 'follow: never'));
  assert.ok(!a.snapshot().blocks.some(b => b.kind === 'error'), 'a deliberate close is not a turn error');
});

test('native error metadata cannot become successful graph completion', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    const done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'fail', mode: 'prompt' });
    assert.equal((await done).outcome, 'failed');
    assert.ok(e.values.some(v => v.type === 'error'));
    for (const block of a.snapshot().blocks) {
      assert.equal(typeof block.label, 'string');
      assert.ok(['complete', 'streaming', 'failed', 'interrupted'].includes(block.status));
    }
  } finally { await a.dispose(); }
});

const PNG = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };

test('images reach Hermes as ACP image blocks when the agent declares image input', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    assert.deepEqual(a.composerCapabilities(), { steer: false, compact: false, images: true });
    const done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'look', mode: 'prompt', images: [PNG] });
    assert.equal((await done).outcome, 'succeeded');
    const texts = a.snapshot().blocks.map(b => b.text);
    assert.ok(texts.includes('look\n\n[image]'));
    assert.ok(texts.includes('images:image/png/iVBORw0KGgo='));
    // A follow-up keeps its images while it waits for the running turn.
    const first = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'slow', mode: 'prompt' });
    await a.prompt({ text: 'and this', mode: 'follow-up', images: [PNG, PNG] });
    await first;
    await e.next(v => v.type === 'turnCompleted');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'and this\n\n[image]\n[image]'));
    assert.ok(a.snapshot().blocks.some(b => b.text === 'images:image/png/iVBORw0KGgo=,image/png/iVBORw0KGgo='));
    await assert.rejects(a.prompt({ text: 'bad', mode: 'prompt', images: [{ mimeType: 'image/bmp', data: 'Qk0=' }] }), { bridgeCode: 'invalid-request' });
  } finally { await a.dispose(); }
});

test('an agent without image input refuses images and lists its ACP commands', async () => {
  const a = await createHermesAdapter({ ...config, runtimeArgs: [...config.runtimeArgs, '--no-image'] }, () => {});
  try {
    assert.equal(a.composerCapabilities().images, false);
    await assert.rejects(a.prompt({ text: 'look', mode: 'prompt', images: [PNG] }), { bridgeCode: 'unsupported-input' });
    assert.equal(a.snapshot().status, 'idle', 'nothing was sent');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(a.composerCatalog(), {
      commands: [
        { name: 'help', description: 'List available commands', source: 'command' },
        { name: 'model', description: 'Show current model and provider, or switch models', hint: 'model name to switch to', source: 'command' },
      ],
      skills: [],
    });
  } finally { await a.dispose(); }
});

const withFixtureArgs = (...args) => ({ ...config, runtimeArgs: [...config.runtimeArgs, ...args] });

test('the minimum Hermes version and every newer one start; the tested version is no ceiling', async () => {
  for (const version of ['0.21.0', '0.21.7', '0.22.0', '1.0.0', 'v1.2.3+build.7']) {
    const a = await createHermesAdapter(withFixtureArgs(`--hermes-version=${version}`), () => {});
    try { assert.equal(a.snapshot().status, 'idle', version); } finally { await a.dispose(); }
  }
});

test('an older, pre-release or unrecognizable Hermes version is refused as unsupported', async () => {
  for (const version of ['0.20.9', '0.21.0-rc.1', '0.9.99', 'dev', '0.21']) {
    await assert.rejects(createHermesAdapter(withFixtureArgs(`--hermes-version=${version}`), () => {}), { bridgeCode: 'unsupported-version' }, version);
  }
});

test('handshake drift is a typed protocol mismatch without native text', async () => {
  for (const args of [['--protocol-version=2'], ['--protocol-version=0'], ['--no-agent-info'], ['--initialize-error'], ['--exit-before-init']]) {
    await assert.rejects(createHermesAdapter(withFixtureArgs(...args), () => {}), error => {
      assert.equal(error.bridgeCode, 'native-protocol-mismatch', args.join());
      assert.doesNotMatch(`${error.message} ${error.safeMessage}`, /PRIVATE_PAYLOAD/);
      return true;
    });
  }
});

test('reshaped session responses fail closed as a protocol mismatch', async () => {
  await assert.rejects(createHermesAdapter({ ...withFixtureArgs('--sessions-not-array'), nativeId: 'saved' }, () => {}), { bridgeCode: 'native-protocol-mismatch' });
  await assert.rejects(createHermesAdapter(withFixtureArgs('--models-not-array'), () => {}), { bridgeCode: 'native-protocol-mismatch' });
});

test('an unknown native event or content type shows one safe fallback per name and never its payload', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    const done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'unknown', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    const fallbacks = a.snapshot().blocks.filter(b => b.fallback);
    assert.deepEqual(fallbacks.map(b => b.text).sort(), [
      'This native content type is not supported by the current renderer.',
      'Unsupported Hermes event: future_event',
      'Unsupported Hermes event: other_event',
      'Unsupported Hermes event: unknown',
    ], 'repeated events report once and a hostile kind is shown as unknown');
    assert.doesNotMatch(JSON.stringify([a.snapshot(), e.values]), /PRIVATE_PAYLOAD|<script>/);
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});

test('a handler failure on one native message does not end the session', async () => {
  const e = events(), a = await createHermesAdapter(config, e.emit);
  try {
    const done = e.next(v => v.type === 'turnCompleted');
    await a.prompt({ text: 'malformed', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    assert.deepEqual(a.snapshot().blocks.filter(b => b.fallback).map(b => b.text), ['Unsupported Hermes event: tool_call'], 'the unprocessable update is named by kind, once');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'after malformed'), 'later updates still arrive');
    assert.ok(!e.values.some(v => v.type === 'status' && v.status === 'failed'));

    // An unprocessable agent request is answered with a JSON-RPC error, not by killing the agent.
    const finished = e.next(v => v.type === 'turnCompleted' && e.values.filter(w => w.type === 'turnCompleted').length === 2);
    await a.prompt({ text: 'bad-permission', mode: 'prompt' });
    assert.equal((await finished).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'client-error:-32602'));
    assert.equal(a.snapshot().approvals.length, 0);
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});
