// S3: does a follow-up delivered to an IDLE lead start a turn by itself?
// Synthetic provider. Usage: node scripts/fusion-spikes/s3-idle.mjs codex|pi
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiAdapter } from '../../crates/piui-runtime/bridge/pi.mjs';
import { codexCli, codexHome, eventSink, outRoot, piCli, recorder, sleep, syntheticProvider, unpinnedCodexFactory } from './lib.mjs';

const harness = process.argv[2] ?? 'codex';
const { log } = recorder(`s3-${harness}`);
const provider = await syntheticProvider(async () => [{ text: 'ACK report' }], log);
const sink = eventSink(log, 'lead');
let adapter;
if (harness === 'codex') {
  const paths = codexHome('s3-codex', provider.baseUrl);
  process.env.CODEX_HOME = paths.agent;
  adapter = await (await unpinnedCodexFactory())({ harness: 'codex', cwd: paths.project, sessionDir: paths.sessions, permissionMode: 'native', runtimeProgram: process.execPath, runtimeArgs: [codexCli] }, sink.emit);
} else {
  const home = join(outRoot, 'homes', 's3-pi');
  for (const folder of ['agent', 'sessions', 'project']) mkdirSync(join(home, folder), { recursive: true });
  writeFileSync(join(home, 'agent/models.json'), JSON.stringify({ providers: { probe: { baseUrl: provider.baseUrl, api: 'openai-responses', apiKey: 'local-synthetic-key', models: [{ id: 'gpt-5.5', name: 'Synthetic', reasoning: false, input: ['text'] }] } } }));
  process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
  adapter = await createPiAdapter({ harness: 'pi', cwd: join(home, 'project'), sessionDir: join(home, 'sessions'), permissionMode: 'native', model: { id: 'gpt-5.5', provider: 'probe', name: 'Synthetic' }, allowedTools: [], runtimeProgram: process.execPath, runtimeArgs: [piCli] }, sink.emit);
}
try {
  await sleep(1000);
  const turn = sink.maybeTurn(30000);
  const accepted = await adapter.prompt({ text: '[PiUI sidekick report b1 · r1 · STATUS done] synthetic [/PiUI sidekick report b1 r1]', mode: 'follow-up' }).then(() => 'accepted', (error) => error.bridgeCode ?? error.message);
  const outcome = await turn;
  console.log(JSON.stringify({ harness, accepted, outcome, providerRequests: provider.payloads.length, lastAssistant: sink.lastAssistant() }));
} finally { await adapter.dispose().catch(() => {}); provider.close(); }
