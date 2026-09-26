import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHermesAdapter } from './hermes.mjs';
const config = { harness: 'hermes', cwd: process.cwd(), agentDir: process.cwd(), permissionMode: 'native', runtimeProgram: process.execPath, runtimeArgs: [fileURLToPath(new URL('./hermes.test-fixture.mjs', import.meta.url))] };
function events() {
  const values = [], waiters = [];
  return { values, emit(value) { values.push(value); for (const waiter of waiters) if (waiter.p(value)) waiter.resolve(value); }, next(p) { return new Promise(resolve => waiters.push({ p, resolve })); } };
}
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
