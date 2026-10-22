// S4 + S9: prompt-cache behaviour of a lead across idle gaps and across a
// resume with identical appended instructions. Real providers on the user's
// own sign-in (Claude subscription or Codex), tiny prompts, few turns.
// Usage: node scripts/fusion-spikes/s4-cache.mjs claude|codex <gapSeconds...>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../crates/piui-runtime/bridge/claude.mjs';
import { claudeExe, codexCli, eventSink, outRoot, recorder, sleep, unpinnedCodexFactory } from './lib.mjs';

const harness = process.argv[2] ?? 'claude';
const gaps = process.argv.slice(3).map(Number);
const { log } = recorder(`s4-${harness}`);
const project = join(outRoot, 'homes', `s4-${harness}`, 'project');
mkdirSync(project, { recursive: true });
const instructions = 'PiUI Fusion spike: you are the LEAD. Keep answers to one word.';
const usages = [];
const start = async (nativeId) => {
  const sink = eventSink((record) => {
    if (record.event?.type === 'usage') usages.push({ at: record.t, ...record.event.usage });
    if (record.event?.type === 'binding') nativeRef.id = record.event.nativeId;
    return log(record);
  }, 'lead');
  let adapter;
  if (harness === 'claude') {
    adapter = await createClaudeAdapter({ harness: 'claude-code', cwd: project, sessionDir: project, permissionMode: 'native', model: { id: 'haiku', provider: 'anthropic', name: 'haiku' }, thinkingLevel: 'low', instructions, runtimeProgram: claudeExe, ...(nativeId ? { nativeId } : {}) }, sink.emit);
  } else {
    const createCodexAdapter = await unpinnedCodexFactory();
    adapter = await createCodexAdapter({ harness: 'codex', cwd: project, sessionDir: join(outRoot, 'homes', 's4-codex', 'sessions'), permissionMode: 'read-only', model: { id: 'gpt-6-luna', provider: 'openai', name: 'GPT-6 Luna' }, thinkingLevel: 'low', instructions, runtimeProgram: process.execPath, runtimeArgs: [codexCli], ...(nativeId ? { nativeId } : {}) }, sink.emit);
  }
  return { adapter, sink };
};
const nativeRef = { id: undefined };
const turn = async (session, label) => {
  const before = usages.length;
  const done = session.sink.nextTurn(300000);
  await session.adapter.prompt({ text: `Reply with the word ${label}.`, mode: 'prompt' });
  const outcome = await done;
  await sleep(1500);
  const usage = usages.slice(before);
  log({ kind: 'turn', label, outcome, usage });
  console.log(JSON.stringify({ label, outcome, usage: usage.map(({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens })) }));
};
let session = await start();
try {
  await turn(session, 'one');
  for (const gap of gaps) {
    log({ kind: 'gap', seconds: gap });
    await sleep(gap * 1000);
    await turn(session, `after${gap}s`);
  }
  // S9: resume the same native session with identical appended instructions.
  const snapshot = await session.adapter.snapshot();
  const id = nativeRef.id ?? snapshot.nativeId;
  await session.adapter.dispose();
  log({ kind: 'resume', nativeId: id });
  session = await start(id);
  await turn(session, 'resumed');
} finally {
  await session.adapter.dispose().catch(() => {});
}
