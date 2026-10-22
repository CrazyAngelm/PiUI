// S1 (Codex): how long a dynamic host-tool call may stay unanswered, and what
// interrupt does to it. Synthetic provider; the model "calls" piui/board once.
// Usage: node scripts/fusion-spikes/s1-codex.mjs <delaySeconds> [--interrupt-after <s>]
import { codexCli, codexHome, eventSink, recorder, sleep, syntheticProvider, unpinnedCodexFactory } from './lib.mjs';

const createCodexAdapter = await unpinnedCodexFactory();

const delay = Number(process.argv[2] ?? 5);
const interruptAt = process.argv.includes('--interrupt-after') ? Number(process.argv[process.argv.indexOf('--interrupt-after') + 1]) : undefined;
const { log } = recorder(`s1-codex-${delay}${interruptAt !== undefined ? `-int${interruptAt}` : ''}`);
const provider = await syntheticProvider((payload, index) => {
  if (index === 0) {
    const ns = payload.tools?.find((tool) => tool.type === 'namespace' && tool.name === 'piui');
    log({ kind: 'tool-shape', namespace: ns ? { name: ns.name, tools: ns.tools?.map((t) => t.name) } : null, raw: JSON.stringify(payload.tools).slice(0, 600) });
    return [{ call: { name: 'board', namespace: 'piui', args: { op: 'context' } } }];
  }
  const output = payload.input?.filter((item) => item.type === 'function_call_output').at(-1);
  log({ kind: 'tool-output-seen', output: JSON.stringify(output).slice(0, 300) });
  return [{ text: 'DONE' }];
}, log);
const paths = codexHome(`s1-codex-${delay}`, provider.baseUrl);
process.env.CODEX_HOME = paths.agent;
const sink = eventSink(log, 'lead');
let adapter;
const boardRequest = async (operation, metadata = {}) => {
  log({ kind: 'board-request', operation, metadata: Object.keys(metadata) });
  const aborted = new Promise((done) => metadata.signal?.addEventListener?.('abort', () => done('aborted'), { once: true }));
  const outcome = await Promise.race([sleep(delay * 1000).then(() => 'answered'), aborted]);
  log({ kind: 'board-settle', outcome });
  if (outcome === 'aborted') throw Object.assign(new Error('cancelled'), { bridgeCode: 'board-cancelled' });
  return { ok: true, result: { probe: true, waitedSeconds: delay } };
};
try {
  adapter = await createCodexAdapter({ harness: 'codex', cwd: paths.project, sessionDir: paths.sessions, permissionMode: 'native', hostTools: ['board'], runtimeProgram: process.execPath, runtimeArgs: [codexCli] }, sink.emit, undefined, undefined, boardRequest);
  log({ kind: 'started' });
  const turn = sink.nextTurn((delay + 120) * 1000);
  await adapter.prompt({ text: 'Spike: call the board tool once.', mode: 'prompt' });
  if (interruptAt !== undefined) { await sleep(interruptAt * 1000); log({ kind: 'interrupt' }); await adapter.interrupt(); }
  const outcome = await turn;
  log({ kind: 'result', outcome, lastAssistant: sink.lastAssistant(), providerRequests: provider.payloads.length });
  console.log(JSON.stringify({ delay, interruptAt, outcome, providerRequests: provider.payloads.length, lastAssistant: sink.lastAssistant() }));
} catch (error) {
  log({ kind: 'failure', message: error.message, code: error.bridgeCode });
  console.log(JSON.stringify({ delay, failure: error.message, code: error.bridgeCode }));
} finally {
  if (adapter) await adapter.dispose().catch(() => {});
  provider.close();
}
