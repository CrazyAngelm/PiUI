import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Match the host's concatenated bridge; this also detects injection/export drift.
const source = ['codex.mjs', 'codex-pool.mjs', 'runner.mjs']
  .map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const { createCodexPool } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const fixture = fileURLToPath(new URL('codex.test-fixture.mjs', import.meta.url));
const config = {
  harness: 'codex', cwd: process.cwd(), sessionDir: process.cwd(),
  permissionMode: 'native', coordination: true, runtimeProgram: process.execPath,
  runtimeArgs: [fixture, '--pool', '--hold-turn'],
};

test('pooled threads isolate output and active retirement; native failure reaches every owner', async () => {
  const events = [];
  const pool = await createCodexPool(config, event => events.push(event));
  const request = (sessionId, method, params = {}) => pool.sessionRequest({ sessionId, method, params });
  try {
    await Promise.all(['one', 'two'].map(sessionId => pool.openSession({ sessionId, config })));
    const one = await request('one', 'snapshot'), two = await request('two', 'snapshot');
    assert.notEqual(one.nativeId, two.nativeId);
    await request('one', 'prompt', { text: 'first agent', mode: 'prompt' });
    await request('two', 'prompt', { text: 'second agent', mode: 'prompt' });
    await request('one', 'dispose');
    assert.equal((await request('two', 'snapshot')).status, 'running');
    assert.ok(events.some(e => e.sessionId === 'one' && e.event.type === 'textDelta' && e.event.text === 'first agent'));
    assert.ok(events.some(e => e.sessionId === 'two' && e.event.type === 'textDelta' && e.event.text === 'second agent'));
    assert.ok(!events.some(e => e.sessionId === 'two' && e.event.type === 'textDelta' && e.event.text === 'first agent'));
    await assert.rejects(request('one', 'snapshot'));
    await assert.rejects(pool.openSession({ sessionId: 'foreign', config: { ...config, runtimeArgs: [] } }));
    await pool.openSession({ sessionId: 'three', config });
    await assert.rejects(request('three', 'prompt', { text: 'crash fixture', mode: 'prompt' }));
    assert.equal((await request('two', 'snapshot')).status, 'failed');
    assert.equal((await request('three', 'snapshot')).status, 'failed');
    assert.ok(events.some(event => event.type === 'error'), 'root transport must be invalidated for recovery');
  } finally {
    await pool.dispose();
  }
});
