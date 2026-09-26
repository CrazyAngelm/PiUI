// Codex app-server protocol audit for the PiUI bridge. Part of raising the
// verified Codex range (crates/piui-runtime/bridge/CONTRACT.md, Codex section).
//
//   codex app-server generate-json-schema --experimental --out <schema-dir>
//   node apps/desktop/scripts/codex-protocol-audit.mjs <schema-dir>
//
// Drives the real bridge (`codex.mjs`) against its test fixture through the
// scripted flows below, records every frame the bridge writes and validates it
// against the generated JSON Schema: client requests, client notifications and
// responses to server requests. The generated schemas allow undeclared
// properties and the app-server silently ignores them, so undeclared fields are
// reported as findings too. No real Codex process is started and no model
// request is made. Exit code 1 on any finding.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const schemaDir = process.argv[2];
if (!schemaDir || !existsSync(join(schemaDir, 'ClientRequest.json'))) {
  console.error('usage: node codex-protocol-audit.mjs <dir from `codex app-server generate-json-schema --experimental --out <dir>`>');
  process.exit(2);
}
const bridgeDir = fileURLToPath(new URL('../../../crates/piui-runtime/bridge/', import.meta.url));
const { createCodexAdapter } = await import(new URL('../../../crates/piui-runtime/bridge/codex.mjs', import.meta.url));
const fixture = join(bridgeDir, 'codex.test-fixture.mjs');

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const load = (name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));
const loadOptional = (name) => [join('v2', name), name].map((candidate) => join(schemaDir, candidate)).find(existsSync);
const clientRequests = load('ClientRequest.json');
const clientNotifications = load('ClientNotification.json');
const serverRequests = load('ServerRequest.json');
const validators = new Map();
const validator = (schema) => {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema);
};
const serverParamsType = Object.fromEntries(serverRequests.oneOf.map((entry) => [
  entry.properties.method.enum[0],
  entry.properties.params?.$ref?.split('/').pop(),
]));
const responseSchemas = new Map();
const responseSchema = (method) => {
  const type = serverParamsType[method]?.replace(/Params$/, 'Response');
  if (!type) return undefined;
  if (!responseSchemas.has(type)) {
    const file = loadOptional(`${type}.json`);
    responseSchemas.set(type, file ? { definitions: {}, ...JSON.parse(readFileSync(file, 'utf8')) } : undefined);
  }
  return responseSchemas.get(type);
};

// Undeclared-field walk. A union branch is chosen by its `method`/`type` tag,
// else by validation; `allOf` parts contribute their declared properties.
const resolve = (schema, root) => {
  let current = schema;
  while (current?.$ref) current = root.definitions[current.$ref.split('/').pop()];
  return current;
};
const branchMatches = (branch, root, value) => validator({ ...branch, definitions: root.definitions })(value);
function undeclared(schemaIn, value, path, root, out) {
  const schema = resolve(schemaIn, root);
  if (!schema || value === null || typeof value !== 'object') return out;
  const branches = schema.oneOf || schema.anyOf;
  if (branches) {
    const tagged = (key) => typeof value[key] === 'string'
      ? branches.find((candidate) => {
        const tag = resolve(candidate, root)?.properties?.[key];
        return tag?.enum?.length === 1 && tag.enum[0] === value[key];
      })
      : undefined;
    const branch = tagged('method') ?? tagged('type') ?? branches.find((candidate) => branchMatches(candidate, root, value));
    if (branch) undeclared(branch, value, path, root, out);
    return out;
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => undeclared(schema.items, item, `${path}[${index}]`, root, out));
    return out;
  }
  let properties = schema.properties || {};
  let additional = schema.additionalProperties;
  for (const part of (schema.allOf || []).map((entry) => resolve(entry, root))) {
    const partBranches = part?.oneOf || part?.anyOf;
    const chosen = partBranches ? resolve(partBranches.find((candidate) => branchMatches(candidate, root, value)), root) : part;
    properties = { ...properties, ...(chosen?.properties || {}) };
    if (chosen?.additionalProperties !== undefined) additional = chosen.additionalProperties;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key in properties) undeclared(properties[key], entry, `${path}.${key}`, root, out);
    else if (additional === undefined && Object.keys(properties).length) out.push(`${path}.${key}`);
    else if (additional && typeof additional === 'object') undeclared(additional, entry, `${path}.${key}`, root, out);
  }
  return out;
}
const selfTest = undeclared(clientRequests, {
  method: 'turn/start', id: 'self', params: {
    threadId: 't', bogusTop: true, input: [{ type: 'text', text: 'x', text_elements: [], bogusInput: 1 }],
  },
}, '', clientRequests, []);
if (selfTest.sort().join(',') !== '.params.bogusTop,.params.input[0].bogusInput') {
  throw new Error(`undeclared-field self test failed: ${selfTest.join(',')}`);
}

const findings = [];
const checked = new Map();
const check = (flow, label, valid, errors, extra = []) => {
  checked.set(label, (checked.get(label) || 0) + 1);
  const problems = [
    ...(valid ? [] : (errors || []).slice(0, 4).map((error) => `${error.instancePath || '/'} ${error.message}`)),
    ...extra.map((field) => `${field} is not declared by the schema`),
  ];
  if (problems.length) findings.push({ flow, label, problems });
};

async function flow(name, fixtureArgs, drive, overrides = {}) {
  const frames = [];
  const openChild = (program, args, options) => {
    const child = spawn(program, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (frame, callback) => {
      for (const line of String(frame).split('\n').filter(Boolean)) frames.push({ from: 'bridge', message: JSON.parse(line) });
      return write(frame, callback);
    };
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        try { frames.push({ from: 'fixture', message: JSON.parse(line) }); } catch { /* malformed on purpose */ }
      }
    });
    return child;
  };
  let adapter;
  try {
    adapter = await createCodexAdapter({
      harness: 'codex', cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: 'native',
      runtimeProgram: process.execPath, runtimeArgs: [fixture, ...fixtureArgs], ...overrides,
    }, () => {}, overrides.coordination ? async () => ({ members: [] }) : undefined, openChild);
    await drive(adapter);
  } catch (error) {
    findings.push({ flow: name, label: 'flow', problems: [`failed: ${error?.bridgeCode || error?.message}`] });
  } finally {
    await adapter?.dispose().catch(() => {});
  }
  const serverRequestMethods = new Map();
  for (const { from, message } of frames) {
    if (from === 'fixture') {
      if (message.method !== undefined && message.id !== undefined) serverRequestMethods.set(String(message.id), message.method);
      continue;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const validate = validator(clientRequests);
      check(name, `request ${message.method}`, validate(message), validate.errors, undeclared(clientRequests, message, '', clientRequests, []));
    } else if (message.method !== undefined) {
      const validate = validator(clientNotifications);
      check(name, `notification ${message.method}`, validate(message), validate.errors);
    } else if ('result' in message) {
      const method = serverRequestMethods.get(String(message.id));
      const schema = responseSchema(method);
      if (!schema) {
        findings.push({ flow: name, label: `response to ${method}`, problems: ['no response schema'] });
        continue;
      }
      const validate = validator(schema);
      check(name, `response to ${method}`, validate(message.result), validate.errors, undeclared(schema, message.result, '', schema, []));
    } else {
      checked.set(`error reply to ${serverRequestMethods.get(String(message.id))}`, (checked.get(`error reply to ${serverRequestMethods.get(String(message.id))}`) || 0) + 1);
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const respondAll = async (adapter, choose) => {
  await settle();
  for (const approval of adapter.snapshot().approvals) await adapter.respond({ requestId: approval.id, ...choose(approval) });
  await settle();
};
await flow('session', [], async (adapter) => {
  await adapter.models();
  await adapter.resources();
  await adapter.prompt({ text: 'fixture prompt', mode: 'prompt' });
  await settle();
  const [model] = await adapter.models();
  await adapter.setModel({ model, thinkingLevel: 'low', serviceTier: 'fast' });
  await adapter.rename({ title: 'renamed' });
  await adapter.compact();
  await settle();
});
await flow('approve', ['--permissions-request', '--write-stdin'], (adapter) => respondAll(adapter, (approval) => ({ decision: approval.decisions[0] })));
await flow('approve-session', ['--permissions-request'], (adapter) => respondAll(adapter, (approval) => ({
  decision: approval.decisions.includes('approve-session') ? 'approve-session' : 'deny',
})));
await flow('deny', ['--permissions-request'], (adapter) => respondAll(adapter, (approval) => ({
  decision: approval.decisions.includes('deny') ? 'deny' : 'cancel',
})));
await flow('user-input', ['--user-input'], async (adapter) => {
  await settle();
  const input = adapter.snapshot().approvals.find((approval) => approval.kind === 'input');
  if (input) await adapter.respond({ requestId: input.id, decision: 'approve-once', text: 'Safe' });
  await settle();
});
await flow('steer-interrupt', ['--hold-turn'], async (adapter) => {
  await adapter.prompt({ text: 'first', mode: 'prompt' });
  await adapter.prompt({ text: 'steer', mode: 'steer' });
  await adapter.interrupt();
  await settle();
});
await flow('resume-read-only', ['--expect-permission', 'read-only'], settle, { permissionMode: 'read-only', nativeId: 'resume-fixture' });
for (const permissionMode of ['workspace-write', 'full-access']) {
  await flow(`start-${permissionMode}`, ['--expect-permission', permissionMode], settle, { permissionMode });
}
await flow('network', ['--expect-permission', 'workspace-write', '--expect-network'], async (adapter) => {
  await adapter.prompt({ text: 'network', mode: 'prompt' });
  await settle();
}, { permissionMode: 'workspace-write', networkAccess: true });
await flow('settings', ['--expect-settings', JSON.stringify({ tier: 'fast' })], async (adapter) => {
  await adapter.prompt({ text: 'fixture', mode: 'prompt' });
  await settle();
}, {
  serviceTier: 'fast', thinkingLevel: 'low', baseInstructions: 'base', instructions: 'developer',
  resourceRules: [{ kind: 'mcp', id: 'example', enabled: false }, { kind: 'skill', id: join(bridgeDir, 'SKILL.md'), enabled: false }],
});
await flow('coordinator', ['--coordinator'], settle, { coordination: true });
await flow('current-time', ['--current-time'], settle);

console.log(JSON.stringify({ checked: Object.fromEntries([...checked].sort()), findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
