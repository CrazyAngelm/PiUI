// Real native harnesses, isolated homes and a local deterministic Responses provider.
// No account keys, remote inference, or the user's Prime supervisor are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createPiAdapter } from '../crates/piui-runtime/bridge/pi.mjs';
import { createCodexAdapter } from '../crates/piui-runtime/bridge/codex.mjs';
import { createPrimeAdapter } from '../crates/piui-runtime/bridge/prime.mjs';
const daemonSocket = process.argv[process.argv.indexOf('--daemon-socket') + 1];
if (!process.argv.includes('--daemon-socket') || !daemonSocket) throw new Error('Explicit isolated --daemon-socket is required');
const root = mkdtempSync(resolve('target/native-settings-'));
const npm = join(process.env.APPDATA, 'npm/node_modules');
const payloads = [];
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  payloads.push(JSON.parse(body));
  const text = 'PIUI_NATIVE_RESULT';
  const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'resp_probe', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_probe', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const reports = [];
try {
  let previousResult = '';
  for (const harness of ['pi', 'codex', 'prime-agent']) {
    const home = join(root, harness);
    for (const folder of ['agent', 'sessions', 'project']) mkdirSync(join(home, folder), { recursive: true });
    const provider = harness === 'prime-agent' ? 'openai' : 'probe';
    const model = { id: 'gpt-5.5', provider, name: 'Local synthetic GPT-5.5' };
    writeFileSync(join(home, 'agent/models.json'), JSON.stringify({ providers: { [provider]: { baseUrl, api: 'openai-responses', apiKey: 'local-synthetic-key', models: [{ id: model.id, name: model.name, reasoning: true, input: ['text'] }] } } }));
    process.env.CODEX_HOME = join(home, 'agent');
    process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
    writeFileSync(join(home, 'agent/config.toml'), `model = "${model.id}"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local synthetic provider"\nbase_url = "${baseUrl}"\nwire_api = "responses"\n`);
    const events = [];
    let resolveTurn;
    const completed = new Promise(resolve => { resolveTurn = resolve; });
    const emit = event => { if (event.type === 'error' || event.type === 'status' || event.type === 'turnCompleted') console.log(JSON.stringify({harness, event})); events.push(event); if (event.type === 'turnCompleted') resolveTurn(event); };
    const config = { harness, cwd: join(home, 'project'), sessionDir: join(home, 'sessions'), permissionMode: 'native', model, thinkingLevel: 'low', instructions: 'PIUI_NATIVE_INSTRUCTION',
      ...(harness === 'pi' ? { runtimeProgram: process.execPath, runtimeArgs: [join(npm, '@earendil-works/pi-coding-agent/dist/cli.js')], allowedTools: [] } : harness === 'codex' ? { runtimeProgram: process.execPath, runtimeArgs: [join(npm, '@openai/codex/bin/codex.js')], serviceTier: 'fast' } : { packageRoot: join(npm, 'prime-agent'), agentDir: join(home, 'agent'), daemonSocket, allowedTools: [], serviceTier: 'fast' }) };
    const factory = harness === 'pi' ? createPiAdapter : harness === 'codex' ? createCodexAdapter : createPrimeAdapter;
    console.log(JSON.stringify({harness, phase:'starting'}));
    const adapter = await factory(config, emit);
    console.log(JSON.stringify({harness, phase:'started'}));
    try {
      const catalog = await adapter.models();
      console.log(JSON.stringify({harness, phase:'catalog'}));
      const snapshot = await adapter.snapshot();
      const selected = catalog.find(entry => entry.id === model.id && entry.provider === provider) ?? snapshot.model;
      assert(selected);
      assert.equal(snapshot.thinkingLevel, 'low');
      if (harness !== 'pi') assert.equal(snapshot.serviceTier, 'fast');
      await adapter.setModel({ model: selected, thinkingLevel: 'low', ...(harness !== 'pi' ? { serviceTier: 'fast' } : {}) });
      const configured = await adapter.snapshot();
      assert.equal(configured.thinkingLevel, 'low');
      if (harness !== 'pi') assert.equal(configured.serviceTier, 'fast');
      const count = payloads.length;
      await adapter.prompt({ text: `Return the result. Prior harness result: ${previousResult}`, mode: 'prompt' });
      const outcome = await completed;
      assert.equal(outcome.outcome, 'succeeded');
      const final = await adapter.snapshot();
      previousResult = final.blocks.filter(block => block.kind === 'assistant').map(block => block.text ?? '').join('');
      assert(previousResult.includes('PIUI_NATIVE_RESULT'));
      const request = payloads[count];
      assert.equal(request.reasoning?.effort, 'low');
      assert(JSON.stringify(request).includes('PIUI_NATIVE_INSTRUCTION'));
      if (harness !== 'pi') assert.equal(request.service_tier, 'priority');
      reports.push({ harness, model: selected.id, reasoning: configured.thinkingLevel, serviceTier: configured.serviceTier ?? null, outcome: outcome.outcome, resultReceived: true });
      console.log(JSON.stringify(reports.at(-1)));
    } finally { await adapter.dispose(); }
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ reportPath: join(root, 'report.json') }));
} finally { server.closeAllConnections(); server.close(); }
