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
