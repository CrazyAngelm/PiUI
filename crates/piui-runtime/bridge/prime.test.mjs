import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPrimeAdapter } from "./prime.mjs";
import { getModelLookupCounts, resetModelLookupCounts } from "./fixtures/prime-sdk-fixture/dist/index.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/prime-sdk-fixture", import.meta.url));
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
  const result = await adapter.prompt({ text: "test", mode: "prompt" });
  assert.deepEqual(result, { accepted: true });
  const delta = await nextEvent(events, (event) => event.type === "textDelta");
  assert.equal(delta.text, "answer");
  assert.equal((await adapter.snapshot()).materialized, true, "the persisted native JSONL materializes the session");
  const completionIndex = events.values.findIndex((event) => event.type === "turnCompleted");
  const terminalIdleIndex = events.values.findIndex((event, index) => index > completionIndex && event.type === "status" && event.status === "idle");
  assert.equal(events.values[completionIndex].outcome, "succeeded");
  assert.ok(terminalIdleIndex > completionIndex, "turn outcome must precede terminal idle");
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

test("Prime fails closed for another installed package version", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "piui-prime-version-"));
  await mkdir(join(packageRoot, "dist"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "prime-agent", version: "0.9.4", exports: { ".": { import: "./dist/index.js" } } }));
  await assert.rejects(createPrimeAdapter(await config({ packageRoot }), () => {}), (error) => error.bridgeCode === "unsupported-version");
});
