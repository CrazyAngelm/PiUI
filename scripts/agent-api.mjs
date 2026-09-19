// Direct local operator client. No UI automation, global harness edits or history writes.
import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

function compatibleParams(method, params) {
  if (method !== 'saveGraph' || !Array.isArray(params?.profiles)) return params;
  return { ...params, profiles: params.profiles.map(entry => {
    if (entry?.value?.networkAccess !== false) return entry;
    const value = { ...entry.value };
    delete value.networkAccess;
    return { ...entry, value };
  }) };
}

export function callApi(connection, method, params = {}, { signal } = {}) {
  if (!Number.isInteger(connection.port) || connection.port <= 0 || connection.port > 65535 || !/^[a-fA-F0-9]{64}$/.test(connection.token)) {
    return Promise.reject(new Error('Invalid local API connection configuration.'));
  }
  return new Promise((resolveResult, reject) => {
    const protocol = ['listSchedules', 'saveSchedule', 'setScheduleEnabled', 'deleteSchedule'].includes(method) ? 2 : 1;
    const socket = net.createConnection({ host: '127.0.0.1', port: connection.port, signal });
    let data = '';
    let completed = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${connection.token}\n${JSON.stringify({ protocol, method, params: compatibleParams(method, params) })}\n`));
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      completed = true;
      socket.destroy();
      try {
        const response = JSON.parse(data.slice(0, end));
        if (response.protocol !== protocol || typeof response.ok !== 'boolean') throw new Error('Invalid API response.');
        if (!response.ok) {
          const error = new Error(`PiUI: ${response.error?.code ?? 'unknown'}`);
          error.code = response.error?.code;
          throw error;
        }
        resolveResult(response.result);
      } catch (error) { reject(error); }
    });
    socket.on('error', error => {
      if (error.code === 'ECONNREFUSED') {
        error.message = 'PiUI operator API is offline (ECONNREFUSED). The saved connection may belong to a previous launch. No request was sent. Do not start a second host: close PiUI normally when its work is finished, then use the PiUI (Operator API) shortcut or scripts/start-agent-api.ps1. After closing, -ClearStaleConnection safely removes the old connection file.';
      }
      reject(error);
    });
    socket.on('close', () => { if (!completed) reject(new Error('Connection closed without a response. Outcome unknown; inspect the saved IDs before retrying.')); });
  });
}

export async function prepareSystem(text, workspaceId) {
  if (!workspaceId?.trim()) throw new Error('workspaceId is required.');
  // The exact parser/compiler used for UI import and system:check.
  const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
  const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
  const server = await createServer({ root: fileURLToPath(new URL('../apps/desktop', import.meta.url)), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
  try {
    const { parseSystemFile, systemFileToGraph } = await server.ssrLoadModule('/src/features/orchestration/systemFile.ts');
    const { compileGraph } = await server.ssrLoadModule('/src/features/orchestration/agentGraph.ts');
    const definition = compileGraph(systemFileToGraph(parseSystemFile(text)));
    const wrap = value => ({ workspaceId, value });
    return {
      protocol: 1,
      save: { workspaceId, profiles: definition.profiles.map(wrap), team: wrap(definition.team), pipeline: wrap(definition.pipeline), command: wrap(definition.command) },
      start: { workspaceId, runId: randomUUID(), teamId: definition.team.id, pipelineId: definition.pipeline.id, launchCommandId: definition.command.id },
    };
  } finally { await server.close(); }
}

async function main(args) {
  const [command, ...values] = args;
  if (command === 'prepare') {
    const [system, workspaceId, output] = values;
    if (!system || !workspaceId || !output || values.length !== 3) throw new Error('Usage: prepare <system.piui.json> <workspaceId> <new-plan.json>');
    const plan = await prepareSystem(await readFile(system, 'utf8'), workspaceId);
    // Persist stable request identity BEFORE any network side effect; never overwrite a plan.
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    return { plan: resolve(output), runId: plan.start.runId, saved: false, started: false };
  }
  const connectionFile = process.env.PIUI_AGENT_API_CONNECTION ??
    (!process.env.PIUI_AGENT_API_PORT && process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'PiUI-agent-api', 'connection.json') : undefined);
  const connection = connectionFile ? JSON.parse(await readFile(connectionFile, 'utf8'))
    : { port: Number(process.env.PIUI_AGENT_API_PORT), token: process.env.PIUI_AGENT_API_TOKEN };
  if (command === 'call') {
    const [method, file] = values;
    if (!method || values.length > 2) throw new Error('Usage: call <method> [params.json|-]');
    let input = '{}';
    if (file === '-') { input = ''; for await (const chunk of process.stdin) input += chunk; }
    else if (file) input = await readFile(file, 'utf8');
    return callApi(connection, method, JSON.parse(input));
  }
  if (command === 'save' || command === 'run') {
    if (values.length !== 1) throw new Error('Usage: save|run <plan.json>');
    const plan = JSON.parse(await readFile(values[0], 'utf8'));
    if (plan.protocol !== 1) throw new Error('Unsupported plan protocol.');
    // run is explicitly separate: preparing/importing/saving never starts agents.
    return callApi(connection, command === 'save' ? 'saveGraph' : 'startRun', command === 'save' ? plan.save : plan.start);
  }
  throw new Error('Usage: node scripts/agent-api.mjs prepare|call|save|run ...; see docs/AGENT_API.md');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
