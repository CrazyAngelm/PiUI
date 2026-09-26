// PiUI plugin backend helper v1 (@piui/plugin-sdk). Copy this file into your
// plugin (create-plugin does) and import it from your backend entry.
//
// PiUI starts your backend with `node <backend.entry>` on first use and
// speaks JSON-RPC 2.0 over stdio: one JSON object per line, delimited only by
// LF. stdout is the protocol, so this helper sends console.log/info/debug to
// stderr. The backend answers `initialize`, `command/execute`, `node/run` and
// `shutdown`, and receives the `settings/changed` notification. A thrown
// error becomes a JSON-RPC error whose message PiUI shows to the person.
// See docs/PLUGINS.md and contracts/plugin-backend-v1.ts.

const PROTOCOL = 1;

/** An error whose message PiUI shows as the command's or the node's failure. */
export class PluginError extends Error {
  constructor(message, code = -32000) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2000) || 'The plugin failed.';
}

/**
 * Starts the backend loop.
 *
 * @param {object} handlers
 * @param {Record<string, (request: { context: object, settings: object, plugin: object }) => unknown>} [handlers.commands]
 *   By command id; return `{ text?, notice? }` (text is prepared in the message box for review).
 * @param {Record<string, (request: object) => unknown>} [handlers.nodes]
 *   By node type id; receive `{ config, inputs, dependencies, step, run, project?, settings }` and
 *   return a string or one JSON object (the step's result).
 * @param {(settings: object) => void} [handlers.onSettingsChanged]
 * @param {(init: object) => void} [handlers.onInitialize]
 */
export function startPluginBackend(handlers = {}) {
  const commands = handlers.commands ?? {};
  const nodes = handlers.nodes ?? {};
  let init = null;
  let settings = {};

  // stdout carries the protocol only.
  for (const name of ['log', 'info', 'debug']) console[name] = (...values) => console.error(...values);

  async function handle(method, params) {
    switch (method) {
      case 'initialize': {
        if (params?.protocol !== PROTOCOL) throw new PluginError(`Unsupported PiUI plugin protocol ${params?.protocol}.`);
        init = params;
        settings = { ...(params.settings ?? {}) };
        await handlers.onInitialize?.(params);
        return { protocol: PROTOCOL };
      }
      case 'command/execute': {
        const command = commands[params?.commandId];
        if (typeof command !== 'function') throw new PluginError(`Unknown command ${params?.commandId}.`, -32601);
        const result = (await command({ context: params.context ?? {}, settings, plugin: init?.plugin })) ?? {};
        return { ...(typeof result.text === 'string' ? { text: result.text } : {}), ...(typeof result.notice === 'string' ? { notice: result.notice } : {}) };
      }
      case 'node/run': {
        const node = nodes[params?.nodeType];
        if (typeof node !== 'function') throw new PluginError(`Unknown node type ${params?.nodeType}.`, -32601);
        const output = await node({ ...params, settings });
        if (typeof output === 'string') return { output };
        if (output && typeof output === 'object' && !Array.isArray(output)) return { output };
        throw new PluginError('A node must return a string or one JSON object.');
      }
      case 'shutdown':
        setTimeout(() => process.exit(0), 20);
        return {};
      default:
        throw new PluginError(`Unknown method ${method}.`, -32601);
    }
  }

  async function dispatch(message) {
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'settings/changed') {
        settings = { ...(params?.settings ?? {}) };
        handlers.onSettingsChanged?.(settings);
      }
      return;
    }
    try {
      send({ jsonrpc: '2.0', id, result: await handle(method, params) });
    } catch (error) {
      const code = error instanceof PluginError ? error.code : -32000;
      send({ jsonrpc: '2.0', id, error: { code, message: errorMessage(error) } });
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        console.error('PiUI sent a frame that is not JSON; ignoring it.');
        continue;
      }
      void dispatch(message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
