// Fake ACP v1 agent for bridge tests. It speaks LF-framed JSON-RPC 2.0 on
// stdio and never contacts a model. Flags: --protocol=N, --no-load, --no-http,
// --auth-required, --config-options, --noise. Stdio MCP servers it receives
// are answered back as the first agent message of the next prompt.
import { createInterface } from 'node:readline';

const flag = name => process.argv.includes(name);
if (flag('--version')) { process.stdout.write('fixture-agent 1.2.3\n'); process.exit(0); }
const protocol = Number(process.argv.find(arg => arg.startsWith('--protocol='))?.split('=')[1] ?? 1);
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const configMode = flag('--config-options');
let currentModel = 'fixture-fast', currentMode = 'default', currentThought = 'medium';
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel, options: [
    { group: 'Fixture', name: 'Fixture', options: [{ value: 'fixture-fast', name: 'Fixture Fast' }, { value: 'fixture-deep', name: 'Fixture Deep', description: 'Slow' }] },
  ] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: currentMode, options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan', description: 'Read-only' }] },
  { id: 'effort', name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: currentThought, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  { id: 'brave', name: 'Brave', type: 'boolean', currentValue: false },
];
const sessionState = () => configMode
  ? { configOptions: configOptions() }
  : {
    models: { currentModelId: currentModel, availableModels: [{ modelId: 'fixture-fast', name: 'Fixture Fast' }, { modelId: 'fixture-deep', name: 'Fixture Deep' }] },
    modes: { currentModeId: currentMode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read-only' }] },
  };

let promptId, permissionReply, clientReply, stdioServers = [];
async function callCoordinator(server) {
  const headers = { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) };
  const post = async (id, method, params) => (await (await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json()).result;
  const init = await post(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  const listed = await post(2, 'tools/list', {});
  const called = await post(3, 'tools/call', { name: 'workspace', arguments: { type: 'roster' } });
  if (init.protocolVersion !== '2025-06-18' || listed.tools[0].name !== 'workspace' || !called.content.length || called.isError) throw Error('coordinator transport failed');
  const unauthorized = await fetch(server.url, { method: 'POST', body: '{}' });
  if (unauthorized.status !== 403) throw Error('coordinator accepted an unauthenticated call');
}

async function prompt(message) {
  if (message.params.prompt?.[0]?.text === 'mcp') {
    notify(message.params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'mcp', content: { type: 'text', text: JSON.stringify(stdioServers) } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  const { sessionId } = message.params;
  const text = message.params.prompt[0].text;
  const say = (value, messageId) => notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value }, ...(messageId ? { messageId } : {}) });
  const end = (stopReason = 'end_turn', extra = {}) => send({ id: message.id, result: { stopReason, ...extra } });
  if (text === 'hello') {
    notify(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    say('hello ', 'reply-1');
    say('world', 'reply-1');
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', nested: { secret: 'never shown' } } });
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [
      { type: 'content', content: { type: 'text', text: '3 passed' } },
      { type: 'diff', path: 'src/app.ts', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
    ] });
    notify(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }, { content: 'Write', priority: 'low', status: 'pending' }] });
    notify(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }, { name: 'init', description: 'Create notes', input: { hint: 'topic' } }] });
    notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    currentMode = 'plan';
    notify(sessionId, { sessionUpdate: 'future_event', payload: { secret: 'SECRET-MUST-NOT-LEAK' } });
    notify(sessionId, { sessionUpdate: 'usage_update', used: 9000, size: 32000 });
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } });
    end('end_turn', { usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, cachedWriteTokens: 1, thoughtTokens: 3, totalTokens: 14 } });
  } else if (text === 'approve') {
    promptId = message.id;
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'Delete build output', kind: 'delete', status: 'pending', locations: [{ path: 'dist' }] });
    permissionReply = response => {
      const outcome = response.result?.outcome;
      if (outcome?.outcome === 'cancelled') { send({ id: promptId, result: { stopReason: 'cancelled' } }); return; }
      say(`outcome ${outcome?.optionId}`);
      send({ id: promptId, result: { stopReason: 'end_turn' } });
    };
    send({ id: 'perm-1', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-2' }, options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ] } });
  } else if (text === 'wait') {
    promptId = message.id;
  } else if (text === 'crash') {
    say('partial');
    setTimeout(() => process.exit(9), 20);
  } else if (text === 'refuse') {
    end('refusal');
  } else if (text === 'reject') {
    send({ id: message.id, error: { code: -32603, message: 'provider exploded SECRET-MUST-NOT-LEAK' } });
  } else if (text === 'auth-expired') {
    send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
  } else if (text === 'slow' || text === 'slow-reject') {
    setTimeout(() => {
      if (text === 'slow-reject') { send({ id: message.id, error: { code: -32603, message: 'provider failed' } }); return; }
      say('ack slow');
      end();
    }, 80);
  } else if (text.startsWith('follow:')) {
    say(`ack ${text}`);
    end();
  } else if (text === 'fs') {
    clientReply = response => { say(`fs ${response.error?.code}`); end(); };
    send({ id: 'fs-1', method: 'fs/read_text_file', params: { sessionId, path: '/etc/passwd' } });
  } else if (text.startsWith('env ')) {
    const name = text.slice(4);
    say(`${name}=${process.env[name] === undefined ? 'absent' : 'visible'}`);
    end();
  } else if (text === 'settings?') {
    say(`model=${currentModel} mode=${currentMode} thought=${currentThought}`);
    end();
  } else if (text === 'flood') {
    process.stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"text":"');
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 33; index += 1) process.stdout.write(chunk);
  } else if (text === 'garbage') {
    process.stdout.write('{not json}\n');
  } else {
    // Echo: lets tests see exactly what the bridge sent, instructions included.
    say(text);
    end();
  }
}

if (flag('--noise')) process.stdout.write('fixture: starting up\n\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    if (message.id === 'perm-1' && permissionReply) { const reply = permissionReply; permissionReply = undefined; reply(message); }
    else if (message.id === 'fs-1' && clientReply) { const reply = clientReply; clientReply = undefined; reply(message); }
    continue;
  }
  const { method, params, id } = message;
  if (method === 'initialize') {
    if (params.clientCapabilities.fs.readTextFile !== false || params.clientCapabilities.terminal !== false) throw Error('client capabilities must stay off');
    send({ id, result: { protocolVersion: protocol, agentCapabilities: { loadSession: !flag('--no-load'), promptCapabilities: { image: false }, mcpCapabilities: { http: !flag('--no-http'), sse: false } }, authMethods: [{ id: 'agent-login', name: 'Agent login', description: 'Sign in using the agent' }, { id: 'api-key', name: 'API key\u0007' }], agentInfo: { name: 'fixture', version: '1.2.3' } } });
  } else if (method === 'session/new' || method === 'session/load') {
    if (flag('--auth-required')) { send({ id, error: { code: -32000, message: 'Authentication required' } }); continue; }
    // `saved` and the id this fixture hands out can be reopened; both replay
    // the same short conversation.
    if (method === 'session/load' && !['saved', 'fixture-session'].includes(params.sessionId)) { send({ id, error: { code: -32002, message: 'Resource not found' } }); continue; }
    if (params.cwd.startsWith('\\\\?\\')) throw Error('verbatim cwd');
    for (const server of params.mcpServers.filter(server => server.type === 'http')) await callCoordinator(server);
    stdioServers = params.mcpServers.filter(server => server.type === undefined);
    if (method === 'session/load') {
      const loaded = params.sessionId;
      notify(loaded, { sessionUpdate: 'user_message_chunk', messageId: 'm1', content: { type: 'text', text: 'earlier question' } });
      notify(loaded, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'earlier ' } });
      notify(loaded, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'answer' } });
      notify(loaded, { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'Read notes', kind: 'read', status: 'completed' });
      send({ id, result: configMode ? sessionState() : null });
    } else {
      send({ id, result: { sessionId: 'fixture-session', ...sessionState() } });
    }
  } else if (method === 'session/prompt') {
    await prompt(message);
  } else if (method === 'session/cancel') {
    if (promptId !== undefined) { send({ id: promptId, result: { stopReason: 'cancelled' } }); promptId = undefined; }
  } else if (method === 'session/set_model') {
    currentModel = params.modelId;
    send({ id, result: {} });
  } else if (method === 'session/set_mode') {
    currentMode = params.modeId;
    send({ id, result: {} });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') currentModel = params.value;
    else if (params.configId === 'mode') currentMode = params.value;
    else if (params.configId === 'effort') currentThought = params.value;
    send({ id, result: { configOptions: configOptions() } });
  } else {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
}
