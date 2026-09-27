// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) with one
// tool, `create_issue`, that only drafts text: no files, no network, no
// programs. PiUI offers it to a chat only after you turn it on in Settings →
// Plugins, and the harness (Claude Code, Hermes or an ACP agent) starts it
// with Node's permission model: `node --permission … server.mjs --stdio`.
import { createInterface } from 'node:readline';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL = {
  name: 'create_issue',
  description: 'Drafts an issue for the tracker. It sends nothing: the draft comes back as text for you to file.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 5, maxLength: 120 },
      priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

export function draftIssue(input) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (title.length < 5 || title.length > 120) throw new Error('The title needs 5-120 characters.');
  const priority = ['urgent', 'normal', 'low'].includes(input?.priority) ? input.priority : 'normal';
  return `Arguments: title: ${title}, priority: ${priority}`;
}

export function answer(message) {
  const { id, method, params } = message;
  if (id === undefined) return undefined; // notifications, including notifications/initialized
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return { id, result: { protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'tool-cards-issues', version: '1.0.0' } } };
    }
    case 'ping':
      return { id, result: {} };
    case 'tools/list':
      return { id, result: { tools: [TOOL] } };
    case 'tools/call': {
      if (params?.name !== TOOL.name) return { id, error: { code: -32602, message: 'Unknown tool.' } };
      try {
        return { id, result: { content: [{ type: 'text', text: draftIssue(params.arguments) }] } };
      } catch (error) {
        return { id, result: { isError: true, content: [{ type: 'text', text: error.message }] } };
      }
    }
    default:
      return { id, error: { code: -32601, message: 'Method not found.' } };
  }
}

if (process.argv.includes('--stdio')) {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error.' } });
      continue;
    }
    const reply = answer(message);
    if (reply) send(reply);
  }
}
