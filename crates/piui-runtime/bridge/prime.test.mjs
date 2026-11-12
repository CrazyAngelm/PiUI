import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrimeAdapter } from "./prime.mjs";
import { getModelLookupCounts, resetModelLookupCounts, lastConfiguredSkills } from "./fixtures/prime-sdk-fixture/index.mjs";

const fixtureRoot = fileURLToPath(new URL("./fixtures/prime-sdk-fixture", import.meta.url));
// Native package layout is generated from the tracked fixture source.
await mkdir(join(fixtureRoot, "dist"), { recursive: true });
await writeFile(join(fixtureRoot, "dist", "index.js"), 'export * from "../index.mjs";\n');
async function config(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "piui-prime-adapter-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentDir)]);
  return { harness: "prime-agent", cwd, sessionDir, packageRoot: fixtureRoot, agentDir,
    daemonSocket: `piui-prime-sdk-${Date.now()}`, permissionMode: "native", nativeSubagents: true, ...overrides };
}
function nextEvent(events, predicate) {
  const existing = events.values.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => events.waiters.push({ predicate, resolve }));
}
function eventCollector() {
  const state = { values: [], waiters: [] };
  state.emit = (event) => {
    state.values.push(event);
    for (const waiter of [...state.waiters]) if (waiter.predicate(event)) {
      state.waiters.splice(state.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };
  return state;
}

test("Prime catalog reads native definitions without starting a model session or refreshing credentials", async () => {
  resetModelLookupCounts();
  const adapter = await createPrimeAdapter(await config({ catalogOnly: true }), () => {});
  try {
    assert.equal((await adapter.models()).length, 1);
    assert.equal((await adapter.catalogModels())[0].supportsFast, false);
    assert.ok((await adapter.resources()).items.some(item => item.id === 'ipython'));
    assert.equal(getModelLookupCounts().refreshed, 0);
    assert.equal(adapter.prompt, undefined);
  } finally { await adapter.dispose(); }
});

test("Prime catalog keeps CLI credentials available without creating auth.json", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piui-native-cli-catalog-"));
  const adapter = await createPrimeAdapter(await config({ catalogOnly: true, agentDir }), () => {});
  try {
    assert.ok((await adapter.catalogModels()).some(model => model.id === "prime-cli-model"));
  } finally { await adapter.dispose(); }
});

test("Prime SDK adapter snapshots history and returns prompt admission", async () => {
  const events = eventCollector();
  const adapter = await createPrimeAdapter(await config(), events.emit);
  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.title, "Fixture Prime");
  assert.equal(snapshot.materialized, false, "a reserved native path is not persisted state");
  assert.equal(snapshot.blocks[0].text, "history");
  assert.equal(snapshot.capabilities.nativeSubagents.supported, true);
  assert.match(snapshot.capabilities.nativeSubagents.reason, /cross-harness/);
  assert.equal(snapshot.capabilities.approvals.supported, false);
  const resources = await adapter.resources();
  assert.ok(resources.items.some(item => item.kind === 'skill' && item.id === 'alpha' && item.configurable));
  assert.ok(resources.items.some(item => item.kind === 'tool' && item.id === 'ipython' && item.configurable));
  assert.ok(resources.items.some(item => item.id === 'external_tool' && !item.configurable));
  assert.deepEqual(resources.warnings, []);
  const result = await adapter.prompt({ text: "test", mode: "prompt" });
  assert.deepEqual(result, { accepted: true });
  const delta = await nextEvent(events, (event) => event.type === "textDelta");
  assert.equal(delta.text, "answer");
  assert.equal((await adapter.snapshot()).materialized, true, "the persisted native JSONL materializes the session");
  const completionIndex = events.values.findIndex((event) => event.type === "turnCompleted");
  const terminalIdleIndex = events.values.findIndex((event, index) => index > completionIndex && event.type === "status" && event.status === "idle");
  assert.equal(events.values[completionIndex].outcome, "succeeded");
  assert.ok(terminalIdleIndex > completionIndex, "turn outcome must precede terminal idle");
  const receipt = events.values.find(event => event.type === "usage")?.usage;
  assert.deepEqual({...receipt,id:"receipt"}, {id:"receipt",inputTokens:10,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:0,totalTokens:14});
  await adapter.dispose();
  assert.ok(events.values.some((event) => event.type === "status" && event.status === "closed"));
});

test("Prime initialize reuses the native model refresh and explicit models refreshes again", async () => {
  resetModelLookupCounts();
  const adapter = await createPrimeAdapter(await config(), () => {});
  assert.deepEqual(getModelLookupCounts(), { fast: 1, refreshed: 1 });
  assert.deepEqual((await adapter.snapshot()).models, [
    { id: "fixture-model", provider: "fixture-provider", name: "Fixture model" },
  ]);

  assert.deepEqual(await adapter.models(), [
    { id: "fixture-model", provider: "fixture-provider", name: "Fixture model" },
  ]);
  assert.deepEqual(getModelLookupCounts(), { fast: 1, refreshed: 2 });
  await adapter.dispose();
});

test("Prime omits an absent native model and rejects an invalid explicit model", async () => {
  const emptyAgentDir = await mkdtemp(join(tmpdir(), "piui-prime-empty-model-"));
  const adapter = await createPrimeAdapter(await config({ agentDir: emptyAgentDir }), () => {});
  const snapshot = await adapter.snapshot();
  assert.equal(Object.hasOwn(snapshot, "model"), false, "native undefined stays absent instead of becoming an unknown placeholder");
  assert.deepEqual(snapshot.models, []);
  await adapter.dispose();

  await assert.rejects(
    createPrimeAdapter(await config({ model: { id: "missing", provider: "fixture-provider", name: "Missing" } }), () => {}),
    (error) => error.bridgeCode === "model-unavailable",
  );
});

test("Prime model selection, rename, and native saved-id resume stay typed", async () => {
  const adapter = await createPrimeAdapter(await config({ nativeId: "saved" }), () => {});
  assert.equal((await adapter.snapshot()).nativeId, "saved");
  assert.deepEqual(await adapter.models(), [{ id: "fixture-model", provider: "fixture-provider", name: "Fixture model" }]);
  await adapter.setModel({ model: { id: "fixture-model", provider: "fixture-provider", name: "Fixture model" }, thinkingLevel: "off" });
  await adapter.rename({ title: "Renamed" });
  assert.equal((await adapter.snapshot()).title, "Renamed");
  await assert.rejects(adapter.respond({}), (error) => error.bridgeCode === "unsupported-method");
  await adapter.dispose();
});



test("Prime reports a failed native stop reason before idle exactly once", async () => {
  const events = eventCollector();
  const adapter = await createPrimeAdapter(await config(), events.emit);
  const start = events.values.length;
  await adapter.prompt({ text: "fail-turn", mode: "prompt" });
  await nextEvent(events, (event) => event.type === "turnCompleted" && event.outcome === "failed");
  const terminal = events.values.slice(start).filter((event) => event.type === "turnCompleted");
  assert.deepEqual(terminal, [{ type: "turnCompleted", outcome: "failed" }]);
  const completedIndex = events.values.findIndex((event, index) => index >= start && event.type === "turnCompleted");
  const idleIndex = events.values.findIndex((event, index) => index > completedIndex && event.type === "status" && event.status === "idle");
  assert.ok(idleIndex > completedIndex);
  await adapter.dispose();
});

test("Prime reports an aborted admitted turn as interrupted before idle", async () => {
  const events = eventCollector();
  const adapter = await createPrimeAdapter(await config(), events.emit);
  const start = events.values.length;
  await adapter.prompt({ text: "wait-for-abort", mode: "prompt" });
  await nextEvent(events, (event) => event.type === "status" && event.status === "running");
  await adapter.interrupt();
  const terminal = events.values.slice(start).filter((event) => event.type === "turnCompleted");
  assert.deepEqual(terminal, [{ type: "turnCompleted", outcome: "interrupted" }]);
  const completedIndex = events.values.findIndex((event, index) => index >= start && event.type === "turnCompleted");
  const idleIndex = events.values.findIndex((event, index) => index > completedIndex && event.type === "status" && event.status === "idle");
  assert.ok(idleIndex > completedIndex);
  await adapter.dispose();
});


test("Prime leaves toolUse and unknown terminal reasons uncertain", async () => {
  const events = eventCollector();
  const adapter = await createPrimeAdapter(await config(), events.emit);
  for (const text of ["tool-use-terminal", "unknown-terminal"]) {
    const start = events.values.length;
    await adapter.prompt({ text, mode: "prompt" });
    await nextEvent(events, (event) => event.type === "status" && event.status === "idle" && events.values.indexOf(event) >= start);
    assert.deepEqual(events.values.slice(start).filter((event) => event.type === "turnCompleted"), []);
  }
  await adapter.dispose();
});

test("Prime registers the strict authenticated workspace tool only for managed runs", async () => {
  const events = eventCollector();
  let received;
  let receivedMetadata;
  const adapter = await createPrimeAdapter(
    await config({ coordination: true, nativeSubagents: false, allowedTools: ["workspace"] }),
    events.emit,
    async (operation, metadata) => {
      received = operation;
      receivedMetadata = metadata;
      return { members: [{ memberId: "allowed-member" }] };
    },
  );
  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.capabilities.nativeSubagents.supported, false);
  await adapter.prompt({ text: "workspace-roster", mode: "prompt" });
  await nextEvent(events, (event) => event.type === "textDelta");
  assert.deepEqual(received, { type: "roster" });
  assert.equal(receivedMetadata.toolCallId, "private-tool-call");
  assert.equal(Object.hasOwn(received, "actor"), false);
  assert.ok(events.values.some((event) => event.type === "block" && event.block.toolName === "workspace"));
  await adapter.dispose();
});

test("Prime rejects unproved mandatory policy and unsafe paths before SDK start", async () => {
  await assert.rejects(createPrimeAdapter(await config({ permissionMode: "read-only" }), () => {}), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ permissionMode: "workspace-write" }), () => {}), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ permissionMode: "full-access" }), () => {}), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ nativeSubagents: false }), () => {}), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ nativeSubagents: true, allowedTools: [] }), () => {}), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ coordination: true, nativeSubagents: false, allowedTools: ["workspace"] }), () => {}), (error) => error.bridgeCode === "coordinator-unavailable");
  await assert.rejects(createPrimeAdapter(await config({ coordination: true, nativeSubagents: false, allowedTools: ["ipython"] }), () => {}, async () => ({})), (error) => error.bridgeCode === "unsupported-policy");
  await assert.rejects(createPrimeAdapter(await config({ nativePath: join(tmpdir(), "outside.jsonl") }), () => {}), (error) => error.bridgeCode === "invalid-session");
  await assert.rejects(createPrimeAdapter(await config({ daemonSocket: "default" }), () => {}), (error) => error.bridgeCode === "unsafe-daemon-endpoint");
});

const FIXTURE_EXPORTS = ["SessionManager", "AuthStorage", "ModelRegistry", "SettingsManager", "defineTool", "createIpythonTool",
  "createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime", "InProcessAgentConnection",
  "createBashToolDefinition", "createEditToolDefinition"];
// An installed-package layout whose entry re-exports the fixture SDK, minus the named exports.
async function installedPackage(version, { name = "prime-agent", omit = [], typebox = false } = {}) {
  const packageRoot = await mkdtemp(join(tmpdir(), "piui-prime-version-"));
  await mkdir(join(packageRoot, "dist"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version, exports: { ".": { import: "./dist/index.js" } },
    ...(typebox ? { dependencies: { typebox: "file:./typebox" } } : {}) }));
  if (typebox) {
    await mkdir(join(packageRoot, "typebox", "build"), { recursive: true });
    await writeFile(join(packageRoot, "typebox", "build", "index.mjs"), `export * from ${JSON.stringify(pathToFileURL(join(fixtureRoot, "typebox", "build", "index.mjs")).href)};
`);
  }
  const source = pathToFileURL(join(fixtureRoot, "index.mjs")).href;
  await writeFile(join(packageRoot, "dist", "index.js"), `export { ${FIXTURE_EXPORTS.filter((export_) => !omit.includes(export_)).join(", ")} } from ${JSON.stringify(source)};
`);
  return packageRoot;
}

test("Prime Nano source consumes its environment and exposes only entitled modes and isolated tools", async () => {
  const provider = "nano-desktop-subscription";
  const native = await config({
    packageRoot: await installedPackage("0.9.5"), nativeSubagents: undefined,
    model: { id: "auto", provider, name: "Auto" }, allowedTools: ["bash"],
  });
  const launch = (overrides = {}, source = {}) => {
    process.env.PIUI_PRIME_NANO_SOURCE = JSON.stringify({
      baseUrl: "http://127.0.0.1:3219/c/1/v1", key: "z".repeat(43),
      modes: [{ id: "auto", name: "Auto" }, { id: "fast", name: "Fast" }], ...source,
    });
    return createPrimeAdapter({ ...native, ...overrides }, () => {});
  };
  const adapter = await launch();
  try {
    assert.equal(process.env.PIUI_PRIME_NANO_SOURCE, undefined);
    assert.deepEqual((await adapter.models()).map(model => [model.provider, model.id]), [[provider, "auto"], [provider, "fast"]]);
    assert.deepEqual((await adapter.resources()).items.map(({ id }) => id), ["bash"]);
    assert.equal((await adapter.snapshot()).capabilities.nativeSubagents.supported, false);
    await adapter.setModel({ model: { provider, id: "fast" } });
    assert.equal((await adapter.snapshot()).model.id, "fast");
    await assert.rejects(adapter.setModel({ model: { provider: "fixture-provider", id: "fixture-model" } }), { bridgeCode: "model-unavailable" });
  } finally { await adapter.dispose(); }
  await assert.rejects(launch({ model: { provider, id: "smart" } }), { bridgeCode: "invalid-request" });
  await assert.rejects(launch({}, { baseUrl: "https://example.test/v1" }), { bridgeCode: "invalid-request" });
  await assert.rejects(launch({ allowedTools: ["ipython"] }), { bridgeCode: "unsupported-policy" });
  await assert.rejects(launch({ nativeSubagents: true }), { bridgeCode: "unsupported-policy" });
  await assert.rejects(launch({ resourceRules: [{ kind: "skill", id: "alpha", enabled: true }] }), { bridgeCode: "unsupported-policy" });
  await assert.rejects(launch({ packageRoot: await installedPackage("0.9.6") }), { bridgeCode: "unsupported-version" });
  assert.equal(process.env.PIUI_PRIME_NANO_SOURCE, undefined);
});

test("Prime retains and reversibly encodes native provider IDs that collide with the Nano source", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piui-prime-provider-collision-"));
  const native = await config({ agentDir });
  const catalog = await createPrimeAdapter({ ...native, catalogOnly: true }, () => {});
  const providers = (await catalog.catalogModels()).filter(model => model.id === "auto").map(model => model.provider);
  assert.deepEqual(providers, ["nano", "piui-prime-native:piui-prime-native:nano", "piui-prime-native:nano-desktop-subscription"]);
  await catalog.dispose();
  const adapter = await createPrimeAdapter({ ...native, model: { id: "auto", provider: providers[0] } }, () => {});
  try {
    await adapter.setModel({ model: { id: "auto", provider: providers[2] } });
    assert.equal((await adapter.snapshot()).model.provider, providers[2]);
  } finally { await adapter.dispose(); }
});

test("Prime admits the minimum and every newer installed package version", async () => {
  for (const version of ["0.9.2", "0.9.4", "0.9.5", "0.10.0", "1.0.0", "v1.2.3+build.7"]) {
    const adapter = await createPrimeAdapter(await config({ packageRoot: await installedPackage(version) }), () => {});
    try { assert.equal((await adapter.snapshot()).title, "Fixture Prime", version); } finally { await adapter.dispose(); }
  }
});

test("Prime refuses an older, pre-release, unparseable or foreign package", async () => {
  for (const version of ["0.9.1", "0.8.99", "0.9.2-rc.1", "not-a-version", "0.9", "", null]) {
    await assert.rejects(createPrimeAdapter(await config({ packageRoot: await installedPackage(version) }), () => {}),
      (error) => error.bridgeCode === "unsupported-version", `version ${JSON.stringify(version)}`);
  }
  await assert.rejects(createPrimeAdapter(await config({ packageRoot: await installedPackage("0.9.5", { name: "other-agent" }) }), () => {}),
    (error) => error.bridgeCode === "unsupported-version");
});

test("Prime reports a missing or reshaped SDK export as a typed protocol mismatch", async () => {
  for (const omit of [["createAgentSessionRuntime"], ["InProcessAgentConnection"], ["SessionManager"], ["createAgentSessionServices"], ["SettingsManager"]]) {
    await assert.rejects(createPrimeAdapter(await config({ packageRoot: await installedPackage("0.9.5", { omit }) }), () => {}),
      (error) => error.bridgeCode === "native-protocol-mismatch" && !/createAgentSession|SessionManager|Connection/.test(error.safeMessage ?? error.message), omit.join());
  }
  // A catalog-only run never builds a session, so it does not need the session exports.
  const catalog = await createPrimeAdapter(await config({ catalogOnly: true, packageRoot: await installedPackage("0.9.5", { omit: ["createAgentSessionRuntime", "InProcessAgentConnection"] }) }), () => {});
  try { assert.equal((await catalog.models()).length, 1); } finally { await catalog.dispose(); }
  await assert.rejects(createPrimeAdapter(await config({ catalogOnly: true, packageRoot: await installedPackage("0.9.5", { omit: ["ModelRegistry"] }) }), () => {}),
    (error) => error.bridgeCode === "native-protocol-mismatch");
  // A coordinated run needs the SDK's tool builder: without it the missing tool is refused, not silently skipped.
  await assert.rejects(createPrimeAdapter(await config({ coordination: true, nativeSubagents: false, allowedTools: ["workspace"], packageRoot: await installedPackage("0.9.5", { omit: ["defineTool"], typebox: true }) }), () => {}, async () => ({})),
    (error) => error.bridgeCode === "native-protocol-mismatch");
  // ...while the optional board tool is skipped with a notice and the chat still starts.
  const events = eventCollector();
  const board = await createPrimeAdapter(await config({ hostTools: ["board"], packageRoot: await installedPackage("0.9.5", { omit: ["defineTool"], typebox: true }) }), events.emit, undefined, async () => ({}));
  try { assert.ok(events.values.some((event) => event.type === "notice" && event.code === "unsupported-board-tool")); } finally { await board.dispose(); }
});

test("Prime shows one safe fallback per unknown SDK event type and survives a throwing event", async () => {
  const events = eventCollector();
  const adapter = await createPrimeAdapter(await config(), events.emit);
  const start = events.values.length;
  await adapter.prompt({ text: "unknown-events", mode: "prompt" });
  await nextEvent(events, (event) => event.type === "turnCompleted" && events.values.indexOf(event) >= start);
  const fallbacks = events.values.slice(start).filter((event) => event.type === "block" && event.block.fallback === true);
  assert.deepEqual(fallbacks.map((event) => event.block.safeSummary).sort(), [
    "Unsupported Prime event: connection_future",
    "Unsupported Prime event: future_event",
    "Unsupported Prime event: message_end",
  ], "each unknown type reports once, the throwing event is named by type only and housekeeping events stay silent");
  assert.ok(fallbacks.every((event) => event.block.kind === "unknown" && event.block.status === "complete"));
  assert.doesNotMatch(JSON.stringify(events.values), /PRIVATE_PAYLOAD|circular/, "the raw event payload never reaches the transcript");
  assert.ok(events.values.slice(start).some((event) => event.type === "status" && event.status === "idle"), "the turn still finishes");
  await adapter.dispose();
});

test("Prime filters one skill per session and rejects unsupported MCP isolation", async () => {
  const adapter = await createPrimeAdapter(await config({ resourceRules: [{ kind: "skill", id: "alpha", enabled: false }] }), () => {});
  try { assert.deepEqual(lastConfiguredSkills(), ["beta"]); } finally { await adapter.dispose(); }
  await assert.rejects(createPrimeAdapter(await config({ resourceRules: [{ kind: "mcp", id: "example", enabled: false }] }), () => {}), { bridgeCode: "unsupported-resource-policy" });
  // Plugins v2: Prime cannot take a plugin MCP server for one chat.
  await assert.rejects(createPrimeAdapter(await config({ pluginMcpServers: [{ name: "example-tool-cards-issues", command: process.execPath, args: ["server.mjs"] }] }), () => {}), { bridgeCode: "unsupported-settings" });
});


test("Prime composer reflects SDK capability and refuses idle steer", async () => {
  const adapter = await createPrimeAdapter(await config(), () => {});
  try {
    assert.deepEqual(await adapter.composerCapabilities(), {steer:true, compact:false, images:false});
    await assert.rejects(adapter.prompt({text:"cannot start a turn",mode:"steer"}), {bridgeCode:"no-active-turn"});
    await assert.rejects(adapter.compact(), {bridgeCode:"unsupported-method"});
  } finally { await adapter.dispose(); }
});

test("Prime refuses images before anything reaches the SDK and has no native catalog", async () => {
  const adapter = await createPrimeAdapter(await config(), () => {});
  try {
    const before = (await adapter.snapshot()).blocks.length;
    await assert.rejects(adapter.prompt({text:"look",mode:"prompt",images:[{mimeType:"image/png",data:"iVBORw0KGgo="}]}), {bridgeCode:"unsupported-input"});
    assert.equal((await adapter.snapshot()).blocks.length, before, "no prompt was admitted");
    assert.deepEqual(await adapter.composerCatalog(), {commands:[], skills:[]});
  } finally { await adapter.dispose(); }
});
