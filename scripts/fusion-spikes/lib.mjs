// Fusion Ф0 spike helpers. Real installed harnesses through PiUI's own bridge
// adapters. Codex and Pi talk to a local deterministic Responses provider in an
// isolated home (no account, no remote inference); Claude Code runs only on the
// user's subscription through the adapter's own environment scrub.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const npm = join(process.env.APPDATA ?? '', 'npm/node_modules');
export const codexCli = join(npm, '@openai/codex/bin/codex.js');
export const piCli = join(npm, '@earendil-works/pi-coding-agent/dist/cli.js');
export const claudeExe = join(npm, '@anthropic-ai/claude-code/bin/claude.exe');

export const outRoot = resolve('target/fusion-spikes');
export const now = (() => { const start = Date.now(); return () => Date.now() - start; })();

export function recorder(name) {
  mkdirSync(outRoot, { recursive: true });
  const file = join(outRoot, `${name}.jsonl`);
  writeFileSync(file, '');
  const log = (record) => {
    const line = { t: now(), ...record };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return line;
  };
  return { file, log };
}

// One synthetic Responses provider. `reply(payload, index)` returns the output
// items of one response: `{text}` for an assistant message or
// `{call: {name, namespace?, args}}` for a function call.
export async function syntheticProvider(reply, log = () => {}) {
  const payloads = [];
  let callSeq = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const index = payloads.length;
    payloads.push(payload);
    log({ kind: 'provider-request', index, inputItems: payload.input?.length, userTexts: userTexts(payload), tools: summarizeTools(payload.tools) });
    const items = (await reply(payload, index)) ?? [{ text: 'OK' }];
    if (items.httpError) {
      response.writeHead(items.httpError, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic failure', type: 'invalid_request_error', code: 'synthetic' } }));
      return;
    }
    const output = items.map((item, i) => item.call
      ? { id: `fc_${index}_${i}`, type: 'function_call', status: 'completed', call_id: `call_${++callSeq}`, name: item.call.name, ...(item.call.namespace ? { namespace: item.call.namespace } : {}), arguments: JSON.stringify(item.call.args ?? {}) }
      : { id: `msg_${index}_${i}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: item.text, annotations: [] }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: `resp_${index}`, status: 'in_progress', output: [] } });
    output.forEach((item, outputIndex) => {
      send({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } });
      if (item.type === 'message') {
        const text = item.content[0].text;
        send({ type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        send({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: 0, delta: text });
        send({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: 0, text });
      }
      send({ type: 'response.output_item.done', output_index: outputIndex, item });
    });
    send({ type: 'response.completed', response: { id: `resp_${index}`, status: 'completed', output, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 12 } } });
    response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, payloads, close: () => { server.closeAllConnections(); server.close(); } };
}

// The user-authored texts in a request (last few), to see where steers land.
export function userTexts(payload) {
  const texts = [];
  for (const item of payload.input ?? []) {
    if (item.role !== 'user' && item.type !== 'message') continue;
    if (item.role !== 'user') continue;
    for (const part of item.content ?? []) if (typeof part.text === 'string') texts.push(part.text.slice(0, 80));
    if (typeof item.content === 'string') texts.push(item.content.slice(0, 80));
  }
  return texts.filter((text) => text.startsWith('S2'));
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => tool.type === 'namespace'
    ? `${tool.name}{${(tool.tools ?? []).map((inner) => inner.name).join(',')}}`
    : tool.name ?? tool.type);
}

// Isolated Codex home pointing at the synthetic provider.
export function codexHome(name, baseUrl) {
  const home = join(outRoot, 'homes', name);
  for (const folder of ['agent', 'sessions', 'project']) mkdirSync(join(home, folder), { recursive: true });
  writeFileSync(join(home, 'agent/config.toml'), `model = "gpt-5.5"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local synthetic provider"\nbase_url = "${baseUrl}"\nwire_api = "responses"\n`);
  return { home, agent: join(home, 'agent'), sessions: join(home, 'sessions'), project: join(home, 'project') };
}

// Emits go to the recorder; turn completions resolve waiters in order.
export function eventSink(log, label) {
  const completions = [];
  const waiters = [];
  const blocks = new Map();
  const emit = (event) => {
    if (event.type === 'textDelta') return;
    if (event.type === 'block') {
      blocks.set(event.block.id, event.block);
      log({ kind: 'block', who: label, id: event.block.id, blockKind: event.block.kind, status: event.block.status, title: event.block.title, text: event.block.text?.slice(0, 200) });
      return;
    }
    log({ kind: 'event', who: label, event: event.type === 'usage' ? event : { ...event, ...(event.approval ? { approval: { id: event.approval.id, kind: event.approval.kind, title: event.approval.title } } : {}) } });
    if (event.type === 'turnCompleted') {
      completions.push(event.outcome);
      const waiter = waiters.shift();
      if (waiter) waiter(event.outcome);
    }
  };
  const nextTurn = (timeoutMs = 600000) => new Promise((done, fail) => {
    const waiter = (outcome) => { clearTimeout(timer); done(outcome); };
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); fail(new Error(`${label}: turn timeout`)); }, timeoutMs);
    waiters.push(waiter);
  });
  // Resolves 'none' (and withdraws itself) when no turn completes in time.
  const maybeTurn = (timeoutMs) => nextTurn(timeoutMs).catch(() => 'none');
  const lastAssistant = () => [...blocks.values()].filter((block) => block.kind === 'assistant').at(-1)?.text;
  return { emit, nextTurn, maybeTurn, completions, blocks, lastAssistant };
}

// The installed Codex may be newer than the adapter's verified ceiling. Spikes
// import a copy of the adapter with only that ceiling lifted (never the repo file).
export async function unpinnedCodexFactory() {
  const { readFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const source = readFileSync(resolve('crates/piui-runtime/bridge/codex.mjs'), 'utf8')
    .replace('ceiling: "0.158.0"', 'ceiling: "9.0.0"');
  if (!source.includes('ceiling: "9.0.0"')) throw new Error('version ceiling not found');
  mkdirSync(outRoot, { recursive: true });
  const file = join(outRoot, 'codex-unpinned.mjs');
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).createCodexAdapter;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
