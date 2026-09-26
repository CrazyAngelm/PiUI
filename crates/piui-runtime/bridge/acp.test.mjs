import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAcpAdapter } from './acp.mjs';

const fixture = fileURLToPath(new URL('./acp.test-fixture.mjs', import.meta.url));
const config = (flags = [], overrides = {}) => ({
  harness: 'acp:fixture-agent', acp: { id: 'fixture-agent', displayName: 'Fixture Agent', disable: {} },
  cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: 'native',
  runtimeProgram: process.execPath, runtimeArgs: [fixture, ...flags], ...overrides,
});
function events() {
  const values = [], waiters = [];
  return {
    values,
    emit(value) { values.push(value); for (const waiter of [...waiters]) if (waiter.p(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); } },
    next(p) { const found = values.find(p); return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ p, resolve })); },
    after(p) { return new Promise(resolve => waiters.push({ p, resolve })); },
  };
}
const turnDone = e => e.after(v => v.type === 'turnCompleted');

test('streams LF-framed text, tools, plans and usage with a generic fallback', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    assert.equal(a.snapshot().status, 'idle');
    const done = turnDone(e);
    assert.deepEqual(await a.prompt({ text: 'hello', mode: 'prompt' }), { accepted: true });
    assert.equal((await done).outcome, 'succeeded');
    const blocks = a.snapshot().blocks;
    const assistant = blocks.find(b => b.kind === 'assistant');
    assert.equal(assistant.text, 'hello world', 'U+2028 stays inside one LF frame');
    assert.equal(assistant.status, 'complete');
    assert.ok(e.values.some(v => v.type === 'textDelta' && v.blockId === assistant.id && v.text === 'world'));
    assert.equal(blocks.find(b => b.kind === 'thinking').text, 'thinking');
    const tool = blocks.find(b => b.kind === 'tool');
    assert.equal(tool.title, 'Run tests');
    assert.equal(tool.toolName, 'command');
    assert.equal(tool.status, 'complete');
    assert.match(tool.text, /3 passed/);
    assert.match(tool.text, /--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n@@ -1,4 \+1,4 @@\n a\n-b\n\+B\n c/);
    assert.equal(blocks.find(b => b.id.startsWith('acp-plan-')).text, '[x] Read\n[ ] Write');
    const fallback = blocks.find(b => b.fallback && b.title === 'Fixture Agent event');
    assert.equal(fallback.text, 'Unsupported agent update: future_event');
    assert.ok(blocks.some(b => b.fallback && /not supported by the current renderer/.test(b.text)), 'non-text content falls back');
    assert.deepEqual(e.values.filter(v => v.type === 'usage').map(v => ({ ...v.usage, id: 'receipt' })), [{ id: 'receipt', inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 14 }]);
    assert.deepEqual((await a.resources()).items.map(item => [item.kind, item.id]), [['skill', 'review'], ['skill', 'init']]);
    assert.equal(a.snapshot().modes.current, 'plan', 'current_mode_update is applied');
    assert.doesNotMatch(JSON.stringify(e.values), /SECRET-MUST-NOT-LEAK|never shown/);
    assert.deepEqual(e.values.filter(v => v.type === 'binding'), [{ type: 'binding', nativeId: 'fixture-session' }]);
    assert.equal(a.snapshot().materialized, true);
    assert.deepEqual(a.composerCapabilities(), { steer: false, compact: false });
  } finally { await a.dispose(); }
});

test('legacy models and modes are selectable and validated before the first prompt', async () => {
  const a = await createAcpAdapter(config([], { model: { id: 'fixture-deep', name: 'Fixture Deep' } }), () => {});
  try {
    const snapshot = a.snapshot();
    assert.deepEqual(snapshot.models, [{ id: 'fixture-fast', name: 'Fixture Fast' }, { id: 'fixture-deep', name: 'Fixture Deep' }]);
    assert.equal(snapshot.model.id, 'fixture-deep', 'the requested model was applied with session/set_model');
    assert.deepEqual(snapshot.modes, { current: 'default', available: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read-only' }] });
    await a.setMode({ modeId: 'plan' });
    assert.equal(a.snapshot().modes.current, 'plan');
    await assert.rejects(a.setMode({ modeId: 'yolo' }), { bridgeCode: 'invalid-request' });
    await a.setModel({ model: { id: 'fixture-fast', name: 'Fixture Fast' } });
    assert.equal(a.snapshot().model.id, 'fixture-fast');
    await assert.rejects(a.setModel({ model: { id: 'fixture-fast' }, thinkingLevel: 'high' }), { bridgeCode: 'unsupported-settings' });
    await assert.rejects(a.setModel({ model: { id: 'fixture-fast' }, serviceTier: 'fast' }), { bridgeCode: 'unsupported-settings' });
  } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(config([], { model: { id: 'unknown-model', name: 'x' } }), () => {}), { bridgeCode: 'invalid-model' });
  const keep = await createAcpAdapter(config([], { model: { id: 'default', name: 'Agent default' } }), () => {});
  try { assert.equal(keep.snapshot().model.id, 'fixture-fast', '"default" keeps the agent model'); } finally { await keep.dispose(); }
});

test('session config options drive model, reasoning and mode', async () => {
  const e = events();
  const a = await createAcpAdapter(config(['--config-options'], { model: { id: 'fixture-deep', name: 'Fixture Deep' }, thinkingLevel: 'high' }), e.emit);
  try {
    const snapshot = a.snapshot();
    assert.deepEqual(snapshot.models.map(m => [m.id, m.provider, m.thinkingLevels]), [['fixture-fast', 'Fixture', ['low', 'medium', 'high']], ['fixture-deep', 'Fixture', ['low', 'medium', 'high']]]);
    assert.equal(snapshot.model.id, 'fixture-deep');
    assert.equal(snapshot.thinkingLevel, 'high');
    await a.setMode({ modeId: 'plan' });
    await a.setModel({ model: { id: 'default' }, thinkingLevel: 'low' });
    const done = turnDone(e);
    await a.prompt({ text: 'settings?', mode: 'prompt' });
    await done;
    assert.ok(a.snapshot().blocks.some(b => b.text === 'model=fixture-deep mode=plan thought=low'));
  } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(config(['--config-options'], { thinkingLevel: 'ultra' }), () => {}), { bridgeCode: 'unsupported-settings' });
  await assert.rejects(createAcpAdapter(config([], { thinkingLevel: 'low' }), () => {}), { bridgeCode: 'unsupported-settings' }, 'no reasoning option without the agent');
});

test('descriptor overrides can switch advertised features off', async () => {
  const a = await createAcpAdapter(config([], { acp: { id: 'fixture-agent', displayName: 'Fixture Agent', disable: { models: true, modes: true } } }), () => {});
  try {
    assert.deepEqual(a.snapshot().models, []);
    assert.equal(a.snapshot().modes, undefined);
    assert.equal(a.snapshot().capabilities.models.supported, false);
  } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(config([], { nativeId: 'saved', acp: { id: 'fixture-agent', displayName: 'Fixture Agent', disable: { loadSession: true } } }), () => {}), { bridgeCode: 'resume-unsupported' });
});

test('permission options become approval buttons; deny, dismiss and cancel resolve natively', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    let approval = e.after(v => v.type === 'approval'); let done = turnDone(e);
    await a.prompt({ text: 'approve', mode: 'prompt' });
    let request = (await approval).approval;
    assert.equal(request.kind, 'file-change');
    assert.equal(request.title, 'Delete build output');
    assert.deepEqual(request.decisions, ['approve-once', 'cancel']);
    assert.deepEqual(request.options.map(o => o.label), ['Allow', 'Allow for this session', 'Reject']);
    assert.ok(request.options.every(o => /^option-\d$/.test(o.id)), 'native option ids stay adapter-private');
    assert.equal(a.snapshot().approvals.length, 1);
    await assert.rejects(a.respond({ requestId: request.id, decision: 'approve-once', text: 'no-such-option' }), { bridgeCode: 'invalid-request' });
    await assert.rejects(a.respond({ requestId: request.id, decision: 'deny' }), { bridgeCode: 'invalid-request' });
    await a.respond({ requestId: request.id, decision: 'approve-once', text: request.options[2].id });
    assert.equal((await done).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'outcome no'), 'the reject option reached the agent');
    await assert.rejects(a.respond({ requestId: request.id, decision: 'cancel' }), { bridgeCode: 'stale-approval' });

    approval = e.after(v => v.type === 'approval'); done = turnDone(e);
    await a.prompt({ text: 'approve', mode: 'prompt' });
    request = (await approval).approval;
    await a.respond({ requestId: request.id, decision: 'approve-once', text: 'Allow' });
    assert.equal((await done).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.text === 'outcome yes'), 'an exact label selects its option');

    approval = e.after(v => v.type === 'approval'); done = turnDone(e);
    await a.prompt({ text: 'approve', mode: 'prompt' });
    request = (await approval).approval;
    await a.respond({ requestId: request.id, decision: 'cancel' });
    assert.equal((await done).outcome, 'interrupted', 'dismiss is the cancelled outcome');

    approval = e.after(v => v.type === 'approval'); done = turnDone(e);
    await a.prompt({ text: 'approve', mode: 'prompt' });
    request = (await approval).approval;
    const resolved = e.after(v => v.type === 'approvalResolved' && v.requestId === request.id);
    await a.interrupt();
    await resolved;
    assert.equal((await done).outcome, 'interrupted', 'turn cancel resolves the pending permission as cancelled');
    assert.equal(a.snapshot().approvals.length, 0);
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});

test('a required sign-in fails with typed hints from the agent and no credential handling', async () => {
  await assert.rejects(createAcpAdapter(config(['--auth-required']), () => {}), error => {
    assert.equal(error.bridgeCode, 'acp-sign-in-required');
    assert.equal(error.safeMessage, 'Sign in to Fixture Agent first.');
    assert.deepEqual(error.safeDetails, { authMethods: ['Agent login', 'API key'] });
    return true;
  });
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    const done = turnDone(e);
    await a.prompt({ text: 'auth-expired', mode: 'prompt' });
    assert.equal((await done).outcome, 'failed');
    assert.ok(a.snapshot().blocks.some(b => b.kind === 'error' && b.safeSummary === 'Sign in to Fixture Agent again, then retry this message.'));
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});

test('a crash mid-turn fails the session and leaves the turn outcome uncertain', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  await a.prompt({ text: 'wait-free', mode: 'prompt' });
  await turnDone(e);
  const failed = e.after(v => v.type === 'status' && v.status === 'failed');
  await a.prompt({ text: 'crash', mode: 'prompt' });
  await a.prompt({ text: 'follow: never', mode: 'follow-up' });
  await failed;
  assert.ok(e.values.some(v => v.type === 'error' && v.message === 'Fixture Agent stopped unexpectedly.'));
  assert.ok(e.values.some(v => v.type === 'error' && /not delivered/.test(v.message)));
  assert.equal(e.values.filter(v => v.type === 'turnCompleted').length, 1, 'no terminal proof, no outcome');
  await assert.rejects(a.prompt({ text: 'again', mode: 'prompt' }), { bridgeCode: 'not-running' });
  await a.dispose();
});

test('provider errors and refusals end the turn, not the session, without leaking native text', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    for (const [text, summary] of [['reject', 'Fixture Agent could not complete this turn (-32603).'], ['refuse', 'Fixture Agent refused to continue this turn.']]) {
      const done = turnDone(e);
      await a.prompt({ text, mode: 'prompt' });
      assert.equal((await done).outcome, 'failed');
      assert.ok(a.snapshot().blocks.some(b => b.kind === 'error' && b.safeSummary === summary), summary);
      assert.equal(a.snapshot().status, 'idle');
    }
    assert.doesNotMatch(JSON.stringify(e.values), /SECRET-MUST-NOT-LEAK/);
  } finally { await a.dispose(); }
});

test('resume replays history through session/load and never substitutes a new session', async () => {
  const e = events();
  const a = await createAcpAdapter(config([], { nativeId: 'saved' }), e.emit);
  try {
    const blocks = a.snapshot().blocks;
    assert.deepEqual(blocks.filter(b => b.kind !== 'tool').map(b => [b.kind, b.text, b.status]), [['user', 'earlier question', 'complete'], ['assistant', 'earlier answer', 'complete']]);
    assert.equal(blocks.find(b => b.kind === 'tool').title, 'Read notes');
    assert.equal(a.snapshot().nativeId, 'saved');
    assert.equal(a.snapshot().materialized, true);
    assert.ok(!e.values.some(v => v.type === 'textDelta'), 'a replay sends whole blocks');
    assert.equal(a.snapshot().capabilities.resume.supported, true);
    const done = turnDone(e);
    await a.prompt({ text: 'next', mode: 'prompt' });
    await done;
    assert.ok(!e.values.some(v => v.type === 'binding'), 'a resumed conversation keeps its binding');
  } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(config([], { nativeId: 'missing' }), () => {}), { bridgeCode: 'invalid-session' });
  await assert.rejects(createAcpAdapter(config(['--no-load'], { nativeId: 'saved' }), () => {}), { bridgeCode: 'resume-unsupported' });
  const fresh = await createAcpAdapter(config(['--no-load']), () => {});
  try { assert.equal(fresh.snapshot().capabilities.resume.supported, false); } finally { await fresh.dispose(); }
});

test('managed sessions route the workspace tool over HTTP MCP or refuse before starting', async () => {
  const calls = [];
  const a = await createAcpAdapter(config([], { coordination: true }), () => {}, async request => { calls.push(request); return { members: [] }; });
  try { assert.deepEqual(calls, [{ type: 'roster' }]); } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(config(['--no-http'], { coordination: true }), () => {}, async () => ({})), { bridgeCode: 'unsupported-coordinator' });
  await assert.rejects(createAcpAdapter(config([], { coordination: true, acp: { id: 'fixture-agent', displayName: 'Fixture Agent', disable: { mcpHttp: true } } }), () => {}, async () => ({})), { bridgeCode: 'unsupported-coordinator' });
});

test('unsupported settings and configuration fail before the agent starts', async () => {
  for (const override of [{ permissionMode: 'read-only' }, { serviceTier: 'fast' }, { allowedTools: [] }, { resourceRules: [{ kind: 'skill', id: 'x', enabled: false }] }, { nativeSubagents: false }, { baseInstructions: '' }, { networkAccess: true }]) {
    await assert.rejects(createAcpAdapter(config([], { ...override, runtimeProgram: process.execPath, runtimeArgs: ['-e', 'process.exit(42)'] }), () => {}), { bridgeCode: 'unsupported-settings' }, JSON.stringify(override));
  }
  for (const override of [{ harness: 'acp:other-agent' }, { harness: 'hermes' }, { runtimeProgram: 'relative-node' }, { cwd: 'relative' }]) {
    await assert.rejects(createAcpAdapter(config([], override), () => {}), { bridgeCode: 'invalid-configuration' }, JSON.stringify(override));
  }
  await assert.rejects(createAcpAdapter(config([], { catalogOnly: true }), () => {}), { bridgeCode: 'unsupported-method' });
  await assert.rejects(createAcpAdapter(config(['--protocol=2']), () => {}), { bridgeCode: 'unsupported-protocol' });
  await assert.rejects(createAcpAdapter(config([], { runtimeProgram: `${process.execPath}-missing` }), () => {}), { bridgeCode: 'native-exited' });
});

test('follow-ups queue during a turn; steer is unsupported; instructions go with the first prompt only', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    let completed = 0;
    const all = e.after(v => v.type === 'turnCompleted' && ++completed === 3);
    await a.prompt({ text: 'slow', mode: 'prompt' });
    assert.deepEqual(await a.prompt({ text: 'follow: one', mode: 'follow-up' }), { accepted: true });
    await assert.rejects(a.prompt({ text: 'now', mode: 'prompt' }), { bridgeCode: 'busy' });
    await assert.rejects(a.prompt({ text: 'redirect', mode: 'steer' }), { bridgeCode: 'unsupported-method' });
    await assert.rejects(a.prompt({ text: '  ', mode: 'follow-up' }), { bridgeCode: 'invalid-request' });
    assert.deepEqual(await a.prompt({ text: 'echo me', mode: 'follow-up' }), { accepted: true });
    await all;
    const transcript = a.snapshot().blocks.filter(b => b.kind === 'user' || b.kind === 'assistant').map(b => b.text);
    assert.deepEqual(transcript, ['slow', 'ack slow', 'follow: one', 'ack follow: one', 'echo me', 'echo me']);
    assert.ok(!e.values.some(v => v.type === 'status' && v.status === 'idle' && completed < 3));
  } finally { await a.dispose(); }
  const f = events(); const first = await createAcpAdapter(config([], { instructions: 'Be exact.' }), f.emit);
  try {
    let done = turnDone(f);
    await first.prompt({ text: 'echo me', mode: 'prompt' });
    await done;
    assert.ok(first.snapshot().blocks.some(b => b.kind === 'assistant' && b.text === 'Agent instructions:\nBe exact.\n\nTask:\necho me'));
    assert.ok(first.snapshot().blocks.some(b => b.kind === 'user' && b.text === 'echo me'), 'the transcript shows the user text');
    done = turnDone(f);
    await first.prompt({ text: 'echo again', mode: 'prompt' });
    await done;
    assert.ok(first.snapshot().blocks.some(b => b.kind === 'assistant' && b.text === 'echo again'), 'later prompts carry no instructions');
  } finally { await first.dispose(); }
});

test('client methods that were never advertised are refused', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    const done = turnDone(e);
    await a.prompt({ text: 'fs', mode: 'prompt' });
    await done;
    assert.ok(a.snapshot().blocks.some(b => b.text === 'fs -32601'));
  } finally { await a.dispose(); }
});

test('stray log lines are tolerated; a broken frame or an unbounded frame stops the agent', async () => {
  const noisy = await createAcpAdapter(config(['--noise']), () => {});
  await noisy.dispose();
  for (const text of ['garbage', 'flood']) {
    const e = events(); const a = await createAcpAdapter(config(), e.emit);
    const failed = e.after(v => v.type === 'status' && v.status === 'failed');
    await a.prompt({ text, mode: 'prompt' });
    await failed;
    assert.ok(e.values.some(v => v.type === 'error' && /invalid protocol message/.test(v.message)), text);
    assert.ok(!e.values.some(v => v.type === 'turnCompleted'), `${text}: no outcome without proof`);
    await a.dispose();
  }
});

test('dispose reports undelivered follow-ups and is not a turn error', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  await a.prompt({ text: 'wait', mode: 'prompt' });
  await a.prompt({ text: 'follow: never', mode: 'follow-up' });
  await a.dispose();
  assert.ok(e.values.some(v => v.type === 'error' && /not delivered/.test(v.message)));
  assert.ok(!a.snapshot().blocks.some(b => b.kind === 'error'));
  assert.ok(!e.values.some(v => v.type === 'status' && v.status === 'failed'), 'a deliberate close is not a failure');
});
