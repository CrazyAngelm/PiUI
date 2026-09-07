import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiAdapter } from "./pi.mjs";

const fixture = fileURLToPath(new URL("./fixtures/pi-rpc-fixture.mjs", import.meta.url));
function config(overrides = {}) {
  return { harness: "pi", cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: "native", runtimeProgram: process.execPath, runtimeArgs: [fixture], ...overrides };
}

test("Pi RPC adapter snapshots history and returns prompt admission", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  const before = await adapter.snapshot();
  assert.equal(before.nativeId, "native-fixture");
  assert.equal(before.materialized, false);
  assert.equal(before.blocks[0].text, "hello");
  assert.notEqual(before.blocks[0].id, "entry-private");
  const resources = await adapter.resources();
  assert.ok(resources.items.some(item => item.kind === 'tool' && item.id === 'read' && item.configurable));
  assert.ok(resources.items.some(item => item.kind === 'skill' && item.name === 'review' && !item.configurable));
  assert.deepEqual(resources.warnings, []);
  const started = Date.now();
  await adapter.prompt({ text: "test", mode: "prompt" });
  assert.ok(Date.now() - started < 30, "prompt waits only for native admission");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(events.some((event) => event.type === "textDelta" && event.text === "answer"));
  assert.ok(events.some((event) => event.type === "approval"));
  const receipt = events.find(event => event.type === "usage")?.usage;
  assert.deepEqual({...receipt,id:"receipt"}, {id:"receipt",inputTokens:10,outputTokens:4,cacheReadTokens:2,cacheWriteTokens:0,totalTokens:14});
  await adapter.dispose();
});

test("approval responses are single-use and do not expose native origin", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  await adapter.prompt({ text: "test", mode: "prompt" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const approval = events.find((event) => event.type === "approval").approval;
  assert.notEqual(approval.id, "native-approval-secret");
  await adapter.respond({ requestId: approval.id, decision: "deny" });
  await assert.rejects(adapter.respond({ requestId: approval.id, decision: "deny" }), (error) => error.bridgeCode === "stale-approval");
  await adapter.dispose();
});

test("rejects unsupported mandatory policy before spawning", async () => {
  await assert.rejects(createPiAdapter(config({ permissionMode: "workspace-write" }), () => {}), (error) => error.bridgeCode === "unsupported-policy");

});

test("emits explicit native terminal outcome before idle", async () => {
  for (const [prompt, expected] of [["ok", "succeeded"], ["fail", "failed"], ["abort", "interrupted"]]) {
    const events = [];
    const adapter = await createPiAdapter(config(), (event) => events.push(event));
    await adapter.prompt({ text: prompt, mode: "prompt" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const terminal = events.findIndex((event) => event.type === "turnCompleted");
    const idle = events.findIndex((event, index) => index > terminal && event.type === "status" && event.status === "idle");
    assert.ok(terminal >= 0);
    assert.equal(events[terminal].outcome, expected);
    assert.ok(idle > terminal);
    await adapter.dispose();
  }
});

test("interrupt retires pending approvals", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  await adapter.prompt({ text: "test", mode: "prompt" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const approval = events.find((event) => event.type === "approval").approval;
  await adapter.interrupt();
  assert.ok(events.some((event) => event.type === "approvalResolved" && event.requestId === approval.id));
  await assert.rejects(adapter.respond({ requestId: approval.id, decision: "deny" }), (error) => error.bridgeCode === "stale-approval");
  await adapter.dispose();
});

test("classifies native turn failures without forwarding raw provider details", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  await adapter.prompt({ text: "authfail", mode: "prompt" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const failure = events.find((event) => event.type === "error");
  assert.equal(failure.message, "The Pi runtime could not authenticate the selected model.");
  assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK|missing API key/);
  await adapter.dispose();
});

test("accepts only exact Pi built-ins and gives read-only deny precedence", async () => {
  for (const invalid of [["read,bash"], ["read*"], ["workspace"], ["unknown"]]) {
    await assert.rejects(
      createPiAdapter(config({ allowedTools: invalid }), () => {}),
      (error) => error.bridgeCode === "unsupported-policy",
    );
  }
  const adapter = await createPiAdapter(
    config({ permissionMode: "read-only", allowedTools: ["read", "write", "grep"] }),
    () => {},
  );
  const snapshot = await adapter.snapshot();
  assert.equal(snapshot.title, "read,grep");
  await adapter.dispose();

  const denied = await createPiAdapter(config({ permissionMode: "read-only", allowedTools: ["write"] }), () => {});
  assert.equal((await denied.snapshot()).title, "no-tools");
  await denied.dispose();
});

test("Pi appends managed instructions through a native file argument", async () => {
  const adapter = await createPiAdapter(config({ instructions: "Follow the assigned graph task." }), () => {});
  try { assert.equal((await adapter.snapshot()).capabilities.instructions.supported, true); }
  finally { await adapter.dispose(); }
});
