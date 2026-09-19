// Real native harnesses, isolated homes and a local deterministic Responses provider.
// No account keys, remote inference, or the user's Prime supervisor are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createCodexAdapter } from '../crates/piui-runtime/bridge/codex.mjs';
import { createPrimeAdapter } from '../crates/piui-runtime/bridge/prime.mjs';
const daemonSocket = process.argv[process.argv.indexOf('--daemon-socket') + 1];
if (!process.argv.includes('--daemon-socket') || !daemonSocket) throw new Error('Explicit isolated --daemon-socket is required');
const root = mkdtempSync(resolve('target/native-skills-'));
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
  for (const harness of ['codex', 'prime-agent']) {
    const home = join(root, harness);
    for (const folder of ['agent', 'sessions', 'project']) mkdirSync(join(home, folder), { recursive: true });
    for (const name of ['piui-disabled-canary', 'piui-kept-canary', 'piui-global-disabled-canary']) {
      const folder = join(home, 'agent/skills', name); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}-description-marker\n---\nSynthetic skill body.\n`);
    }
    const provider = harness === 'prime-agent' ? 'openai' : 'probe';
    const model = { id: 'gpt-5.5', provider, name: 'Local synthetic GPT-5.5' };
    writeFileSync(join(home, 'agent/models.json'), JSON.stringify({ providers: { [provider]: { baseUrl, api: 'openai-responses', apiKey: 'local-synthetic-key', models: [{ id: model.id, name: model.name, reasoning: true, input: ['text'] }] } } }));
    process.env.CODEX_HOME = join(home, 'agent');
    writeFileSync(join(home, 'agent/config.toml'), `model = "${model.id}"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local synthetic provider"\nbase_url = "${baseUrl}"\nwire_api = "responses"\n`);
    if (harness === 'codex') {
      const configPath = join(home, 'agent/config.toml');
      const { appendFileSync } = await import('node:fs');
      appendFileSync(configPath, `\n[[skills.config]]\npath = ${JSON.stringify(join(home, 'agent/skills/piui-global-disabled-canary/SKILL.md'))}\nenabled = false\n`);
    }
    for (const disabled of [false, true]) {
      let complete;
      const completed = new Promise(resolve => { complete = resolve; });
      const config = { harness, cwd: join(home, 'project'), sessionDir: join(home, 'sessions'), permissionMode: 'native', model,
        ...(disabled ? { resourceRules: [{ kind: 'skill', id: harness === 'codex' ? join(home, 'agent/skills/piui-disabled-canary/SKILL.md') : 'piui-disabled-canary', enabled: false }] } : {}),
        ...(harness === 'codex' ? { runtimeProgram: process.execPath, runtimeArgs: [join(npm, '@openai/codex/bin/codex.js')] } : { packageRoot: join(npm, 'prime-agent'), agentDir: join(home, 'agent'), daemonSocket, allowedTools: ['ipython'] }) };
      const adapter = await (harness === 'codex' ? createCodexAdapter : createPrimeAdapter)(config, event => { if (event.type === 'turnCompleted') complete(event); });
      try {
        const count = payloads.length;
        await adapter.prompt({ text: 'Return the synthetic result without using tools.', mode: 'prompt' });
        const outcome = await completed;
        assert.equal(outcome.outcome, 'succeeded');
        assert(payloads.length > count);
        const text = JSON.stringify(payloads[count]);
        const disabledListed = text.includes('piui-disabled-canary-description-marker');
        const globallyDisabledListed = text.includes('piui-global-disabled-canary-description-marker');
        if (harness === 'codex') assert.equal(globallyDisabledListed, false, 'Per-thread settings must preserve other disabled skills');
        const keptListed = text.includes('piui-kept-canary-description-marker');
        reports.push({ harness, disabled, disabledListed, keptListed, outcome: outcome.outcome });
        console.log(JSON.stringify(reports.at(-1)));
        assert.equal(disabledListed, !disabled, `${harness}: disabled skill context mismatch`);
        assert.equal(keptListed, true, `${harness}: enabled control skill missing`);
      } finally { await adapter.dispose(); }
    }
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ reportPath: join(root, 'report.json') }));
} finally { server.closeAllConnections(); server.close(); }
