// S2: round <-> admitted turn <-> final answer for a persistent sidekick, on one
// native session per harness (Codex or Pi), synthetic provider, no account.
// Usage: node scripts/fusion-spikes/s2-turns.mjs codex|pi
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiAdapter } from '../../crates/piui-runtime/bridge/pi.mjs';
import { codexCli, codexHome, eventSink, outRoot, piCli, recorder, sleep, syntheticProvider, unpinnedCodexFactory, userTexts } from './lib.mjs';

const harness = process.argv[2] ?? 'codex';
const { log } = recorder(`s2-${harness}`);
const behaviour = new Map(); // scenario tag -> async (payload) => items
const lastTag = (payload) => userTexts(payload).at(-1)?.split(' ')[0];
const provider = await syntheticProvider(async (payload, index) => {
  const texts = userTexts(payload);
  const tag = lastTag(payload);
  const hasToolOutput = (payload.input ?? []).some((item) => item.type === 'function_call_output');
  log({ kind: 'provider-sees', index, tag, texts, hasToolOutput });
  const handler = behaviour.get(tag);
  return handler ? handler(payload, { hasToolOutput, texts }) : [{ text: `ANSWER ${tag}` }];
}, log);

let adapter;
const sink = eventSink(log, 'sidekick');
const boardRequest = async (operation) => { log({ kind: 'board-request', operation }); await sleep(3000); return { ok: true, result: { probe: true } }; };
if (harness === 'codex') {
  const paths = codexHome('s2-codex', provider.baseUrl);
  process.env.CODEX_HOME = paths.agent;
  const createCodexAdapter = await unpinnedCodexFactory();
  adapter = await createCodexAdapter({ harness: 'codex', cwd: paths.project, sessionDir: paths.sessions, permissionMode: 'native', hostTools: ['board'], runtimeProgram: process.execPath, runtimeArgs: [codexCli] }, sink.emit, undefined, undefined, boardRequest);
} else {
  const home = join(outRoot, 'homes', 's2-pi');
  for (const folder of ['agent', 'sessions', 'project']) mkdirSync(join(home, folder), { recursive: true });
  writeFileSync(join(home, 'agent/models.json'), JSON.stringify({ providers: { probe: { baseUrl: provider.baseUrl, api: 'openai-responses', apiKey: 'local-synthetic-key', models: [{ id: 'gpt-5.5', name: 'Synthetic', reasoning: false, input: ['text'] }] } } }));
  process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
  adapter = await createPiAdapter({ harness: 'pi', cwd: join(home, 'project'), sessionDir: join(home, 'sessions'), permissionMode: 'native', model: { id: 'gpt-5.5', provider: 'probe', name: 'Synthetic' }, allowedTools: [], runtimeProgram: process.execPath, runtimeArgs: [piCli] }, sink.emit);
}
log({ kind: 'started', harness });

const results = [];
const scenario = async (name, fn) => {
  log({ kind: 'scenario', name });
  const before = sink.completions.length;
  let note;
  try { note = await fn(); } catch (error) { note = { error: error.bridgeCode ?? error.message }; }
  await sleep(1500);
  const record = { name, completions: sink.completions.slice(before), lastAssistant: sink.lastAssistant()?.slice(0, 80), note };
  results.push(record);
  log({ kind: 'scenario-result', ...record });
};
const prompt = (text, mode = 'prompt') => adapter.prompt({ text, mode });

try {
  await scenario('R1 normal', async () => { const turn = sink.nextTurn(); await prompt('S2-R1 normal round'); return { outcome: await turn }; });

  behaviour.set('S2-R2', async () => { await sleep(4000); return [{ text: 'ANSWER S2-R2' }]; });
  behaviour.set('S2-R2-STEER', async () => [{ text: 'ANSWER S2-R2-STEER' }]);
  await scenario('R2 steer during sampling', async () => {
    const turn = sink.nextTurn();
    await prompt('S2-R2 slow answer');
    await sleep(1000);
    const steer = await prompt('S2-R2-STEER extra input', 'steer').then(() => 'accepted', (error) => error.bridgeCode ?? error.message);
    const first = await turn;
    const second = await sink.maybeTurn(8000);
    return { steer, first, second };
  });

  if (harness === 'codex') {
    behaviour.set('S2-R3', async (_payload, { hasToolOutput }) => (hasToolOutput ? [{ text: 'ANSWER S2-R3' }] : [{ call: { name: 'board', namespace: 'piui', args: { op: 'context' } } }]));
    behaviour.set('S2-R3-STEER', async (_payload, { hasToolOutput }) => [{ text: `ANSWER S2-R3-STEER toolOutput=${hasToolOutput}` }]);
    await scenario('R3 steer during tool call', async () => {
      const turn = sink.nextTurn();
      await prompt('S2-R3 tool round');
      await sleep(1200);
      const steer = await prompt('S2-R3-STEER extra input', 'steer').then(() => 'accepted', (error) => error.bridgeCode ?? error.message);
      const first = await turn;
      const second = await sink.maybeTurn(8000);
      return { steer, first, second };
    });
  }

  await scenario('R4 steer after completion', async () => prompt('S2-R4-STEER late', 'steer').then(() => 'accepted', (error) => error.bridgeCode ?? error.message));

  behaviour.set('S2-R5', async () => []);
  await scenario('R5 no final answer', async () => { const turn = sink.nextTurn(); await prompt('S2-R5 empty output'); return { outcome: await turn }; });

  behaviour.set('S2-R6', async () => ({ httpError: 400 }));
  await scenario('R6 provider failure', async () => { const turn = sink.nextTurn(60000); await prompt('S2-R6 failing'); return { outcome: await turn.catch((error) => error.message) }; });

  behaviour.set('S2-R7', async () => { await sleep(3000); return [{ text: 'ANSWER S2-R7' }]; });
  await scenario('R7 follow-up while running', async () => {
    const turn = sink.nextTurn();
    await prompt('S2-R7 slow');
    await sleep(800);
    const followUp = await prompt('S2-R7-FOLLOW queued', 'follow-up').then(() => 'accepted', (error) => error.bridgeCode ?? error.message);
    const first = await turn;
    const second = await sink.maybeTurn(8000);
    return { followUp, first, second };
  });

  await scenario('R8 interrupt then prompt', async () => {
    behaviour.set('S2-R8', async () => { await sleep(5000); return [{ text: 'ANSWER S2-R8' }]; });
    const turn = sink.nextTurn();
    await prompt('S2-R8 to interrupt');
    await sleep(1000);
    await adapter.interrupt();
    const first = await turn;
    const next = sink.nextTurn();
    await prompt('S2-R9 after interrupt');
    return { first, next: await next };
  });
  console.log(JSON.stringify({ harness, results }, null, 1));
} finally {
  await adapter.dispose().catch(() => {});
  provider.close();
}
