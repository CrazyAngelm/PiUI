import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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

test('a plugin MCP server joins only this session as a stdio server (plugins v2)', async () => {
  const e = events();
  const server = { name: 'example-tool-cards-issues', command: process.execPath, args: ['--permission', 'server.mjs', '--stdio'] };
  const a = await createAcpAdapter(config([], { pluginMcpServers: [server] }), e.emit);
  try {
    const done = turnDone(e);
    await a.prompt({ text: 'mcp', mode: 'prompt' });
    await done;
    const answer = a.snapshot().blocks.filter(b => b.kind === 'assistant').map(b => b.text).join('');
    assert.deepEqual(JSON.parse(answer), [{ ...server, env: [] }]);
  } finally { await a.dispose(); }
  for (const bad of [[{ ...server, name: 'Bad Name' }], [{ ...server, command: 'node' }], [server, server], [{ ...server, name: 'piui-workspace' }]]) {
    await assert.rejects(createAcpAdapter(config([], { pluginMcpServers: bad }), () => {}), { bridgeCode: 'unsupported-settings' }, JSON.stringify(bad));
  }
  await assert.rejects(createAcpAdapter(config([], { pluginMcpServers: [server], coordination: true }), () => {}, async () => ({})), { bridgeCode: 'unsupported-settings' });
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

test('the handshake is the gate: a rejected, malformed or newer protocol is a typed failure', async () => {
  // Protocol 2 is a version this adapter does not implement; it is not a mismatch of shape.
  await assert.rejects(createAcpAdapter(config(['--protocol=2']), () => {}), { bridgeCode: 'unsupported-protocol' });
  await assert.rejects(createAcpAdapter(config(['--protocol=abc']), () => {}), { bridgeCode: 'native-protocol-mismatch' }, 'a protocol version that is not an integer');
  await assert.rejects(createAcpAdapter(config(['--no-protocol']), () => {}), { bridgeCode: 'native-protocol-mismatch' }, 'no protocol version at all');
  await assert.rejects(createAcpAdapter(config(['--reject-initialize']), () => {}), { bridgeCode: 'native-protocol-mismatch' }, 'initialize rejected');
  await assert.rejects(createAcpAdapter(config(['--reject-new']), () => {}), { bridgeCode: 'native-protocol-mismatch' }, 'session/new rejected as invalid');
  await assert.rejects(createAcpAdapter(config(['--no-session-id']), () => {}), { bridgeCode: 'native-protocol-mismatch' }, 'session/new answered without a conversation');
  await assert.rejects(createAcpAdapter(config(['--auth-initialize']), () => {}), error => {
    assert.equal(error.bridgeCode, 'acp-sign-in-required', 'a sign-in request at initialize stays a sign-in request');
    assert.deepEqual(error.safeDetails, { authMethods: [] });
    return true;
  });
  // The failure text is the adapter's own, never the agent's.
  await assert.rejects(createAcpAdapter(config(['--reject-initialize']), () => {}), error => {
    assert.equal(error.safeMessage, 'Fixture Agent rejected the ACP handshake.');
    return true;
  });
  // An agent that answers version 1 starts, whatever its own release number is.
  const a = await createAcpAdapter(config(), () => {});
  await a.dispose();
});

test('PiUI introduces itself with its own release number', () => {
  const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('./acp.mjs', import.meta.url), 'utf8');
  const [, version] = source.match(/clientInfo:\s*\{\s*name:\s*'piui',\s*title:\s*'PiUI',\s*version:\s*'([^']+)'/) ?? [];
  assert.equal(version, root.version, 'acp.mjs reports the release in package.json (the fixture also rejects a clientInfo that is not PiUI)');
});

test('an update kind the adapter does not know shows one generic notice, never a copy per update', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    let done = turnDone(e);
    await a.prompt({ text: 'updates', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    let fallbacks = a.snapshot().blocks.filter(b => b.fallback && b.title === 'Fixture Agent event');
    assert.deepEqual(fallbacks.map(b => b.text), ['Unsupported agent update: future_alpha', 'Unsupported agent update: future_beta']);
    assert.equal(a.snapshot().blocks.find(b => b.kind === 'assistant').text, 'abc', 'repeated notices do not split the message around them');
    assert.doesNotMatch(JSON.stringify(e.values), /SECRET-MUST-NOT-LEAK/);

    done = turnDone(e);
    await a.prompt({ text: 'updates-many', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    fallbacks = a.snapshot().blocks.filter(b => b.fallback && b.title === 'Fixture Agent event');
    assert.equal(fallbacks.length, 16, 'notices per session are bounded');
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});

test('a frame the adapter cannot interpret is answered and shown once, and the session carries on', async () => {
  let failures = 0;
  const e = events();
  const emit = value => {
    // The host side of one streamed block fails once, as a bug in the adapter would.
    if (value.type === 'block' && value.block.kind === 'assistant' && value.block.text === 'boom' && failures === 0) { failures += 1; throw new Error('simulated interpretation failure'); }
    e.emit(value);
  };
  const a = await createAcpAdapter(config(), emit);
  try {
    let done = turnDone(e);
    await a.prompt({ text: 'boom', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded', 'the turn is not failed by one frame it could not read');
    assert.equal(failures, 1);
    assert.ok(a.snapshot().blocks.some(b => b.fallback && b.text === 'Unsupported agent update: agent_message_chunk'));
    assert.ok(!e.values.some(v => v.type === 'status' && v.status === 'failed'));
    assert.ok(!e.values.some(v => v.type === 'error'));
    assert.equal(a.snapshot().status, 'idle');

    done = turnDone(e);
    await a.prompt({ text: 'follow: later', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.kind === 'assistant' && b.text === 'ack follow: later'), 'later prompts still work');
  } finally { await a.dispose(); }
});

test('a permission request that cannot be shown is cancelled, never approved', async () => {
  let failures = 0;
  const e = events();
  const emit = value => {
    if (value.type === 'approval' && failures++ === 0) throw new Error('simulated interpretation failure');
    e.emit(value);
  };
  const a = await createAcpAdapter(config(), emit);
  try {
    const done = turnDone(e);
    await a.prompt({ text: 'approve', mode: 'prompt' });
    assert.equal((await done).outcome, 'interrupted', 'the agent was told the permission was cancelled');
    assert.equal(a.snapshot().approvals.length, 0, 'no approval is left pending');
    assert.ok(!a.snapshot().blocks.some(b => b.text === 'outcome yes'), 'nothing was allowed');
    assert.ok(!e.values.some(v => v.type === 'approval'), 'the user never saw a request that was not recorded');
    assert.equal(a.snapshot().status, 'idle');
  } finally { await a.dispose(); }
});

test('requests outside the advertised client surface get method-not-found and never become approvals', async () => {
  const e = events(); const a = await createAcpAdapter(config(), e.emit);
  try {
    const done = turnDone(e);
    await a.prompt({ text: 'unknown-requests', mode: 'prompt' });
    assert.equal((await done).outcome, 'succeeded');
    assert.ok(a.snapshot().blocks.some(b => b.kind === 'assistant' && b.text === 'u-1:-32601 u-2:-32601 u-3:-32601 u-4:cancelled'),
      'approval lookalikes, terminal and private methods are refused; an empty permission request is cancelled');
    assert.ok(!e.values.some(v => v.type === 'approval'), 'only session/request_permission with choices is an approval');
    assert.equal(a.snapshot().approvals.length, 0);
  } finally { await a.dispose(); }
});

// --- Nano model source (ADR-050) ---------------------------------------------
const nanoModes = [{ id: 'auto', name: 'Auto' }, { id: 'fast', name: 'Fast' }];
const nanoConfig = (overrides = {}, modes = nanoModes) => config(['--nano-models'], {
  harness: 'acp:opencode',
  sessionDir: join(process.cwd(), 'target'),
  acp: { id: 'opencode', displayName: 'OpenCode', disable: {}, nano: { provider: 'nano', modes } },
  model: { id: 'auto', provider: 'nano', name: 'Auto' },
  ...overrides,
});

test('the Nano source offers exactly the entitled modes, maps them to the agent ids and keeps the key out of the bridge', async () => {
  process.env.OPENCODE_CONFIG_CONTENT = '{"provider":{"nano":{"options":{"apiKey":"lease-key-not-for-the-bridge"}}}}';
  const e = events();
  let a;
  try {
    a = await createAcpAdapter(nanoConfig(), e.emit);
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined, 'the bridge removes the key-bearing variable once the agent has it');
    const snapshot = a.snapshot();
    assert.deepEqual(snapshot.models, [{ id: 'auto', name: 'Auto', provider: 'nano' }, { id: 'fast', name: 'Fast', provider: 'nano' }],
      'only entitled modes of the nano provider, named by the host; no locked mode, no foreign provider, no reasoning levels');
    assert.deepEqual(snapshot.model, { id: 'auto', name: 'Auto', provider: 'nano' });
    assert.deepEqual((await a.catalogModels()).map(model => [model.id, model.provider]), [['auto', 'nano'], ['fast', 'nano']]);
    let done = turnDone(e);
    await a.prompt({ text: 'env OPENCODE_CONFIG_CONTENT', mode: 'prompt' });
    await done;
    assert.ok(a.snapshot().blocks.some(b => b.text === 'OPENCODE_CONFIG_CONTENT=visible'), 'the agent keeps its own copy');
    done = turnDone(e);
    await a.prompt({ text: 'shell environment', mode: 'prompt' });
    await done;
    assert.ok(a.snapshot().blocks.some(b => b.text === 'ENV_CLEAN'), 'the actual bundled hook blanks the child environment');
    await a.setModel({ model: { id: 'fast', provider: 'nano', name: 'Fast' } });
    assert.equal(a.snapshot().model.id, 'fast');
    done = turnDone(e);
    await a.prompt({ text: 'settings?', mode: 'prompt' });
    await done;
    assert.ok(a.snapshot().blocks.some(b => /^model=nano\/fast /.test(b.text ?? '')), 'the agent was told its own model id');
    assert.doesNotMatch(JSON.stringify([e.values, a.snapshot()]), /lease-key-not-for-the-bridge/);
    // A change of source or an unoffered mode is refused, never matched by id alone.
    for (const model of [{ id: 'smart', provider: 'nano', name: 'Smart' }, { id: 'other/gpt', name: 'Other' }, { id: 'default' }, { id: 'fast', name: 'Fast' }, { id: 'nano/fast', provider: 'nano', name: 'x' }]) {
      await assert.rejects(a.setModel({ model }), { bridgeCode: 'invalid-model' }, JSON.stringify(model));
    }
    assert.equal(a.snapshot().model.id, 'fast', 'a refused change keeps the session on its mode');
  } finally { delete process.env.OPENCODE_CONFIG_CONTENT; await a?.dispose(); }
});

test('the Nano source fails closed instead of falling back to a native model or source', async () => {
  const start = overrides => createAcpAdapter(nanoConfig(overrides), () => {});
  // A mode the account does not offer now (a reopened session whose mode was locked).
  await assert.rejects(start({ model: { id: 'smart', provider: 'nano', name: 'Smart' } }), { bridgeCode: 'invalid-model' });
  // Explicit Nano routing requires an entitled Nano mode.
  await assert.rejects(start({ model: undefined }), { bridgeCode: 'invalid-configuration' });
  await assert.rejects(start({ model: { id: 'fixture-fast', name: 'x' } }), { bridgeCode: 'invalid-configuration' });
  await assert.rejects(createAcpAdapter(config(['--nano-models'], { model: { id: 'auto', provider: 'nano', name: 'Auto' } }), () => {}), { bridgeCode: 'invalid-model' });
  // Only the built-in OpenCode has a Nano source, with a valid mode list.
  const nano = { provider: 'nano', modes: nanoModes };
  await assert.rejects(start({ acp: { id: 'fixture-agent', displayName: 'Fixture Agent', disable: {}, nano }, harness: 'acp:fixture-agent' }), { bridgeCode: 'invalid-configuration' });
  for (const bad of [{ provider: 'other', modes: nanoModes }, { provider: 'nano', modes: [] }, { provider: 'nano', modes: [{ id: 'a/b', name: 'x' }] },
    { provider: 'nano', modes: [{ id: 'auto', name: 'A' }, { id: 'auto', name: 'B' }] }, { provider: 'nano' }, null]) {
    await assert.rejects(start({ acp: { id: 'opencode', displayName: 'OpenCode', disable: {}, nano: bad } }), { bridgeCode: 'invalid-configuration' }, JSON.stringify(bad));
  }
});

test('a native provider named nano remains native without explicit Nano routing', async () => {
  const a = await createAcpAdapter(config(['--nano-group'], { model: { id: 'fixture-fast', provider: 'nano' } }), () => {});
  try {
    assert.deepEqual(a.snapshot().models.map(model => [model.id, model.provider]), [['fixture-fast', 'nano']]);
    await a.setModel({ model: { id: 'fixture-fast', provider: 'nano', name: 'x' } });
    await a.setModel({ model: { id: 'default', provider: 'nano', name: 'x' } });
  } finally { await a.dispose(); }
});

test('the Nano source refuses a missing or stale trusted plugin acknowledgement before prompting', async () => {
  for (const flag of ['--missing-nano-guard', '--stale-nano-guard']) {
    await assert.rejects(createAcpAdapter(nanoConfig({ runtimeArgs: [fixture, '--nano-models', flag] }), () => {}), {
      bridgeCode: 'native-start-failed', safeMessage: 'The Nano shell environment guard did not load.',
    });
  }
});

test('the Nano source rejects a native response which did not select the requested mode', async () => {
  const a = await createAcpAdapter(nanoConfig({ runtimeArgs: [fixture, '--nano-models', '--refuse-model-change'] }), () => {});
  try {
    await assert.rejects(a.setModel({ model: { id: 'fast', provider: 'nano' } }), { bridgeCode: 'invalid-model' });
    assert.equal(a.snapshot().model.id, 'auto', 'the snapshot reflects the actual native response');
  } finally { await a.dispose(); }
  await assert.rejects(createAcpAdapter(nanoConfig({
    runtimeArgs: [fixture, '--nano-models', '--refuse-model-change'], model: { id: 'fast', provider: 'nano' },
  }), () => {}), { bridgeCode: 'invalid-model' });
});

test('the Nano source accepts host mode lists without invented count or identifier limits', async () => {
  const modes = [...nanoModes, ...Array.from({ length: 17 }, (_, index) => ({ id: `mode_${'x'.repeat(65)}_${index}`, name: 'Mode' }))];
  const a = await createAcpAdapter(nanoConfig({}, modes), () => {});
  try { assert.equal(a.snapshot().model.id, 'auto'); } finally { await a.dispose(); }
});

test('the Nano source refuses MCP and host tool subprocess routes', async () => {
  for (const overrides of [
    { pluginMcpServers: [{ name: 'fixture', command: process.execPath, args: [] }] },
    { coordination: true }, { hostTools: ['board'] },
  ]) {
    await assert.rejects(createAcpAdapter(nanoConfig(overrides), () => {}), { bridgeCode: 'unsupported-settings' });
  }
});

test('Goose starts privately, preserves the project cwd and locks the Nano model and permissions', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(process.cwd(), 'target', 'goose-nano-test-'));
  const provider = 'nano-goose-subscription';
  const model = { id: 'fast', provider, name: 'Fast' };
  const environment = {
    GOOSE_PATH_ROOT: root, GOOSE_SHELL: process.execPath, PIUI_GOOSE_NANO_SHELL: '1',
    OPENAI_BASE_URL: 'http://127.0.0.1:4455/c/7/v1', OPENAI_API_KEY: 'goose-fixture-lease', GOOSE_MODEL: 'fast',
  };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  const launch = (flags = [], overrides = {}) => config(['--goose-models', ...flags], {
    harness: 'acp:goose', acp: { id: 'goose', displayName: 'Goose', nano: { provider, modes: [model] } },
    model, ...overrides,
  });
  let a;
  try {
    Object.assign(process.env, environment);
    a = await createAcpAdapter(launch(), () => {});
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(a.snapshot().models, [model]);
    assert.deepEqual(a.snapshot().modes, { current: 'approve', available: [{ id: 'approve', name: 'Approve' }] });
    await assert.rejects(a.setModel({ model: { id: 'fast', provider: 'openai' } }), { bridgeCode: 'invalid-model' });
    await assert.rejects(a.setModel({ model: { id: 'auto', provider } }), { bridgeCode: 'invalid-model' });
    await assert.rejects(a.setMode({ modeId: 'auto' }), { bridgeCode: 'invalid-request' });
    await assert.rejects(a.prompt({ text: '/extensions', mode: 'prompt' }), { bridgeCode: 'unsupported-method' });
    assert.doesNotMatch(JSON.stringify(a.snapshot()), /goose-fixture-lease/);
    await a.dispose();
    a = undefined;
    Object.assign(process.env, environment);
    a = await createAcpAdapter(launch([], { nativeId: 'saved' }), () => {});
    assert.equal(a.snapshot().nativeId, 'saved');
    assert.deepEqual(a.snapshot().models, [model]);
    await a.dispose();
    a = undefined;
    Object.assign(process.env, environment);
    await assert.rejects(createAcpAdapter(launch(['--unverified-goose']), () => {}), { bridgeCode: 'native-protocol-mismatch' });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await a?.dispose();
    rmdirSync(root);
  }
});
