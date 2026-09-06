// Native Prime SDK + local synthetic provider. Requires its own supervisor.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createPrimeAdapter } from '../crates/piui-runtime/bridge/prime.mjs';
const socketIndex = process.argv.indexOf('--daemon-socket');
const daemonSocket = socketIndex >= 2 ? process.argv[socketIndex + 1] : undefined;
if (!daemonSocket?.includes('piui') || daemonSocket.startsWith('--')) throw new Error('Supply an explicit non-default --daemon-socket');
const root = mkdtempSync(resolve('target/prime-settings-'));
for (const name of ['project', 'sessions', 'agent/skills/piui-probe']) mkdirSync(join(root, name), { recursive: true });
writeFileSync(join(root, 'agent/skills/piui-probe/SKILL.md'), '---\nname: piui-probe\ndescription: PIUI_SYNTHETIC_SKILL_MARKER\n---\nSynthetic skill.');
let resolvePayload;
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  resolvePayload?.(payload);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const item = { id: 'message-probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PIUI_PRIME_RESULT', annotations: [] }] };
  for (const event of [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response-probe', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-responses', apiKey: 'local-synthetic-key', models: [{ id: 'probe-model', name: 'Synthetic probe', reasoning: true, input: ['text'] }] } } }));
const reports = [];
try {
  for (const enabled of [false, true]) {
    const received = new Promise(resolve => { resolvePayload = resolve; });
    const adapter = await createPrimeAdapter({ harness: 'prime-agent', cwd: join(root, 'project'), sessionDir: join(root, 'sessions'), agentDir: join(root, 'agent'), packageRoot: join(process.env.APPDATA, 'npm/node_modules/prime-agent'), permissionMode: 'native', daemonSocket, allowedTools: ['ipython'], nativeSubagents: true, model: { id: 'probe-model', provider: 'probe', name: 'Synthetic' }, thinkingLevel: 'low', resourceRules: [{ kind: 'skill', id: 'piui-probe', enabled }] }, () => {});
    try {
      await adapter.prompt({ text: 'Synthetic local task. No tools.', mode: 'prompt' });
      const payload = await received;
      const visible = JSON.stringify(payload).includes('PIUI_SYNTHETIC_SKILL_MARKER');
      const report = { skillEnabled: enabled, skillVisible: visible, reasoning: payload.reasoning?.effort };
      reports.push(report);
      console.log(JSON.stringify(report));
      if (visible !== enabled || report.reasoning !== 'low') throw new Error('Native Prime settings did not reach the provider');
    } finally { await adapter.dispose(); }
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ reports, reportPath: join(root, 'report.json') }));
} finally { server.closeAllConnections(); server.close(); }
