import { createInterface } from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const notify = update => send({ method: 'session/update', params: { sessionId: 'saved', update } });
const models = { currentModelId: 'fixture:model', availableModels: [{ modelId: 'fixture:model', name: 'Fixture' }] };
const flag = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sessionModels = process.argv.includes('--models-not-array') ? { currentModelId: 'fixture:model', availableModels: 'not-a-list' } : models;
let promptId;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const m = JSON.parse(line); let result = {};
  if (!m.method) { if (promptId && m.error) notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `client-error:${m.error.code}` } }); if (promptId) send({ id: promptId, result: { stopReason: m.result?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' } }); continue; }
  if (m.method === 'initialize') {
    if (process.argv.includes('--exit-before-init')) process.exit(1);
    if (process.argv.includes('--initialize-error')) { send({ id: m.id, error: { code: -32601, message: 'Method not found PRIVATE_PAYLOAD' } }); continue; }
    result = { protocolVersion: Number(flag('protocol-version') ?? 1), ...(process.argv.includes('--no-agent-info') ? {} : { agentInfo: { version: flag('hermes-version') ?? '0.21.0' } }), agentCapabilities: { loadSession: true, promptCapabilities: { image: !process.argv.includes('--no-image') } } };
  }
  else if (m.method === 'session/list') result = process.argv.includes('--sessions-not-array') ? { sessions: 'not-a-list' } : { sessions: [{ sessionId: 'saved', cwd: process.argv.includes('--wrong-cwd') ? '/' : process.cwd() }] };
  else if (m.method === 'session/new' || m.method === 'session/load') {
    if (m.method === 'session/load') notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native history' } });
    const stdio = m.params.mcpServers.filter(server => server.type === undefined);
    if (stdio.length) notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `stdio:${JSON.stringify(stdio)}` } });
    const http = m.params.mcpServers.filter(server => server.type === 'http');
    if (http.length) {
      const server = http[0];
      const headers = Object.fromEntries(server.headers.map(h => [h.name, h.value]));
      const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace', arguments: { type: 'roster' } } }) });
      if (!response.ok || !(await response.json()).result.content.length) throw Error('coordinator transport failed');
    }
    send({ id: m.id, result: { sessionId: 'saved', models: sessionModels } });
    // Hermes advertises its headless slash commands right after the session starts.
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [
      { name: 'help', description: 'List available commands', input: null },
      { name: 'model', description: 'Show current model and provider, or switch models', input: { hint: 'model name to switch to' } },
    ] });
    continue;
  } else if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text;
    const images = m.params.prompt.filter(block => block.type === 'image');
    if (images.length) {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `images:${images.map(image => `${image.mimeType}/${image.data}`).join(',')}` } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'approve') {
      promptId = m.id;
      send({ id: 'permission', method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'no' }], toolCall: { title: 'Fixture command' } } });
      continue;
    }
    if (text === 'wait') { promptId = m.id; continue; }
    if (text === 'unknown') {
      // Event kinds and content types this adapter has never seen, repeated and hostile.
      for (let index = 0; index < 3; index++) notify({ sessionUpdate: 'future_event', secret: 'PRIVATE_PAYLOAD' });
      notify({ sessionUpdate: 'other_event' });
      notify({ sessionUpdate: '<script>PRIVATE_PAYLOAD</script>' });
      for (let index = 0; index < 2; index++) notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'audio', data: 'PRIVATE_PAYLOAD' } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'malformed') {
      // Well-formed JSON-RPC whose update fields this adapter cannot process.
      for (let index = 0; index < 2; index++) notify({ sessionUpdate: 'tool_call', toolCallId: 'broken', content: {} });
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after malformed' } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (text === 'bad-permission') {
      promptId = m.id;
      send({ id: 'bad-permission', method: 'session/request_permission' });
      continue;
    }
    const providerError = { code: -32603, message: 'provider exploded SECRET-MUST-NOT-LEAK' };
    if (text === 'reject') { send({ id: m.id, error: providerError }); continue; }
    if (text === 'slow' || text === 'slow-reject') {
      // Keeps the turn running long enough for the test to queue follow-ups.
      setTimeout(() => {
        if (text === 'slow-reject') { send({ id: m.id, error: providerError }); return; }
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ack slow' } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }, 80);
      continue;
    }
    if (text.startsWith('follow:')) {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ack ${text}` } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello\u2028' } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    notify({ sessionUpdate: 'future_event' });
    notify({ sessionUpdate: 'usage_update', used: 9000, size: 32000 });
    result = { stopReason: 'end_turn', usage: {inputTokens:10,outputTokens:4,cachedReadTokens:2,totalTokens:14}, ...(text === 'fail' ? { _meta: { piuiOutcome: 'failed' } } : {}) };
  } else if (m.method === 'session/cancel') { send({ id: promptId, result: { stopReason: 'cancelled' } }); continue; }
  else if (m.method !== 'session/set_model') throw Error('unexpected method');
  send({ id: m.id, result });
}
