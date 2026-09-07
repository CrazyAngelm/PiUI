import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const notify = update => send({ method: 'session/update', params: { sessionId: 'saved', update } });
const models = { currentModelId: 'fixture:model', availableModels: [{ modelId: 'fixture:model', name: 'Fixture' }] };
let promptId;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const m = JSON.parse(line); let result = {};
  if (!m.method) { if (promptId) send({ id: promptId, result: { stopReason: m.result?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' } }); continue; }
  if (m.method === 'initialize') result = { protocolVersion: 1, agentInfo: { version: '0.21.0' } };
  else if (m.method === 'session/list') result = { sessions: [{ sessionId: 'saved', cwd: process.argv.includes('--wrong-cwd') ? '/' : process.cwd() }] };
  else if (m.method === 'session/new' || m.method === 'session/load') {
    if (m.method === 'session/load') notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native history' } });
    if (m.params.mcpServers.length) {
      const server = m.params.mcpServers[0];
      const headers = Object.fromEntries(server.headers.map(h => [h.name, h.value]));
      const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace', arguments: { type: 'roster' } } }) });
      if (!response.ok || !(await response.json()).result.content.length) throw Error('coordinator transport failed');
    }
    result = { sessionId: 'saved', models };
  } else if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text;
    if (text === 'approve') {
      promptId = m.id;
      send({ id: 'permission', method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'no' }], toolCall: { title: 'Fixture command' } } });
      continue;
    }
    if (text === 'wait') { promptId = m.id; continue; }
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello\u2028' } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    notify({ sessionUpdate: 'future_event' });
    notify({ sessionUpdate: 'usage_update', used: 9000, size: 32000 });
    result = { stopReason: 'end_turn', usage: {inputTokens:10,outputTokens:4,cachedReadTokens:2,totalTokens:14}, ...(text === 'fail' ? { _meta: { piuiOutcome: 'failed' } } : {}) };
  } else if (m.method === 'session/cancel') { send({ id: promptId, result: { stopReason: 'cancelled' } }); continue; }
  else if (m.method !== 'session/set_model') throw Error('unexpected method');
  send({ id: m.id, result });
}
