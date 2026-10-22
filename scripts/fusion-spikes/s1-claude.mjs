// S1 (Claude Code): how long the board host tool (session HTTP MCP server) may
// stay unanswered before Claude Code gives up, and what interrupt does to it.
// Runs on the user's Claude subscription (adapter scrubs API-key env).
// Usage: node scripts/fusion-spikes/s1-claude.mjs <delaySeconds> [--interrupt-after <s>] [--mode read-only]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../crates/piui-runtime/bridge/claude.mjs';
import { claudeExe, eventSink, outRoot, recorder, sleep } from './lib.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const delay = Number(process.argv[2] ?? 5);
const interruptAt = arg('--interrupt-after') !== undefined ? Number(arg('--interrupt-after')) : undefined;
const mode = arg('--mode') ?? 'native';
const model = arg('--model') ?? 'haiku';
const name = `s1-claude-${delay}${interruptAt !== undefined ? `-int${interruptAt}` : ''}${mode !== 'native' ? `-${mode}` : ''}`;
const { log } = recorder(name);
const project = join(outRoot, 'homes', name, 'project');
mkdirSync(project, { recursive: true });
const sink = eventSink(log, 'lead');
let adapter;
const boardRequest = async (operation, metadata = {}) => {
  log({ kind: 'board-request', operation, metadata: Object.keys(metadata), toolCallId: metadata.toolCallId });
  const aborted = new Promise((done) => metadata.signal?.addEventListener?.('abort', () => done('aborted'), { once: true }));
  const outcome = await Promise.race([sleep(delay * 1000).then(() => 'answered'), aborted]);
  log({ kind: 'board-settle', outcome });
  if (outcome === 'aborted') throw Object.assign(new Error('cancelled'), { bridgeCode: 'board-cancelled' });
  return { ok: true, result: { probe: true, waitedSeconds: delay } };
};
try {
  adapter = await createClaudeAdapter({ harness: 'claude-code', cwd: project, sessionDir: project, permissionMode: mode, model: { id: model, provider: 'anthropic', name: model }, thinkingLevel: 'low', hostTools: ['board'], runtimeProgram: claudeExe }, sink.emit, undefined, boardRequest);
  log({ kind: 'started' });
  const turn = sink.nextTurn((delay + 300) * 1000);
  await adapter.prompt({ text: 'This is a connectivity test. Call the board tool exactly once with {"op":"context"}. Do not call any other tool. After the board tool returns (success or error), reply with one line: DONE followed by the tool result or the error text, verbatim.', mode: 'prompt' });
  if (interruptAt !== undefined) { await sleep(interruptAt * 1000); log({ kind: 'interrupt' }); await adapter.interrupt(); }
  const outcome = await turn;
  log({ kind: 'result', outcome, lastAssistant: sink.lastAssistant() });
  console.log(JSON.stringify({ delay, interruptAt, mode, outcome, lastAssistant: sink.lastAssistant()?.slice(0, 400) }));
} catch (error) {
  log({ kind: 'failure', message: error.message, code: error.bridgeCode, safe: error.safeMessage });
  console.log(JSON.stringify({ delay, failure: error.message, code: error.bridgeCode, safe: error.safeMessage }));
} finally {
  if (adapter) await adapter.dispose().catch(() => {});
}
