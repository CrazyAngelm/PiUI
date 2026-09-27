import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiAdapter } from "./pi.mjs";

const fixture = fileURLToPath(new URL("./fixtures/pi-rpc-fixture.mjs", import.meta.url));
function config(overrides = {}) {
  return { harness: "pi", cwd: process.cwd(), sessionDir: process.cwd(), permissionMode: "native", runtimeProgram: process.execPath, runtimeArgs: [fixture], ...overrides };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture condition timed out");
}

// Runs one fixture scenario and waits until its native run settles to idle.
async function runScenario(adapter, events, text) {
  const start = events.length;
  await adapter.prompt({ text, mode: "prompt" });
  await waitFor(() => events.slice(start).some((event) => event.type === "status" && event.status === "idle"));
}

test("Pi rejects per-session resource filtering before starting the native process", async () => {
  for (const kind of ["skill", "mcp"]) {
    await assert.rejects(createPiAdapter(config({ runtimeProgram: "must-not-launch", resourceRules: [{ kind, id: "canary", enabled: false }] }), () => {}), { bridgeCode: "unsupported-resource-policy" });
  }
  // Plugins v2: Pi cannot take a plugin MCP server for one chat.
  await assert.rejects(createPiAdapter(config({ runtimeProgram: "must-not-launch", pluginMcpServers: [{ name: "example-tool-cards-issues", command: process.execPath, args: ["server.mjs"] }] }), () => {}), { bridgeCode: "unsupported-settings" });
});

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
  await adapter.prompt({ text: "test", mode: "prompt" });
  assert.ok(!events.some(event => event.type === "turnCompleted"), "prompt returns before the fixture completes its turn");
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


test("Pi composer exposes typed compact and rejects idle steer", async () => {
  const events = [];
  let settled;
  const completed = new Promise(resolve => settled = resolve);
  const adapter = await createPiAdapter(config(), event => { events.push(event); if (event.type === "status" && event.status === "idle") settled(); });
  try {
    assert.deepEqual(await adapter.composerCapabilities(), {steer:true, compact:true, images:true});
    await assert.rejects(adapter.prompt({text:"cannot start a turn",mode:"steer"}), {bridgeCode:"no-active-turn"});
    await adapter.compact();
    await completed;
    assert.ok(!events.some(event => event.type === "textDelta"), "compaction never becomes a literal prompt");
  } finally { await adapter.dispose(); }
});

test("Pi tool blocks show a one-line title and bounded output, never raw payloads", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "tools");
    const tools = (await adapter.snapshot()).blocks.filter((block) => block.kind === "tool");
    assert.equal(tools.length, 5);
    const [bash, read, emoji, custom, untyped] = tools;

    assert.equal(bash.title, "bash: npm test --silent");
    assert.equal(bash.status, "complete");
    assert.ok(events.some((event) => event.type === "block" && event.block.id === bash.id
      && event.block.status === "streaming" && event.block.text === "partial output"));
    assert.equal(bash.truncated, true);
    assert.ok(bash.text.startsWith("head line\n"));
    assert.ok(bash.text.endsWith("tail line\n"));
    assert.ok(bash.text.includes(`\n… ${24000 - 16 * 1024} characters omitted …\n`));
    assert.ok(bash.text.length <= 16 * 1024 + 64);

    assert.equal(read.title, "read: src/main.rs");
    assert.equal(read.text, "fn main() {}\n[image]");
    assert.equal(read.truncated, false);

    assert.equal(emoji.truncated, true);
    assert.ok(emoji.text.isWellFormed(), "cuts never split a surrogate pair");

    assert.equal(custom.title, "deploy: target: staging, retries: 2, options: {…}");
    assert.equal(custom.status, "failed");
    assert.equal(custom.text, "deploy failed");
    assert.equal(custom.safeSummary, "The tool failed.");

    assert.equal(untyped.title, "extension_tool");
    assert.equal(untyped.text, "");
    assert.equal(untyped.status, "complete");

    assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK|fullOutputPath|call-bash/);
  } finally { await adapter.dispose(); }
});

test("Pi compaction blocks complete on native end events with turn and response fallbacks", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  const compactions = async () => (await adapter.snapshot()).blocks.filter((block) => block.kind === "compaction");
  try {
    await runScenario(adapter, events, "compaction");
    assert.deepEqual((await compactions()).map((block) => [block.status, block.safeSummary]), [
      ["complete", "Context was compacted."],
      ["failed", "Context compaction failed."],
      ["interrupted", "Context compaction was cancelled."],
      ["failed", "Context compaction failed."],
      ["complete", "Context compaction ended."],
    ]);

    const start = events.length;
    await adapter.compact();
    await waitFor(() => events.slice(start).some((event) => event.type === "status" && event.status === "idle"));
    const manual = (await compactions()).at(-1);
    assert.deepEqual([manual.status, manual.safeSummary], ["complete", "Context was compacted."]);
    assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK/);
  } finally { await adapter.dispose(); }
});

test("Pi select dialogs expose opaque options and reply with the exact native value", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await adapter.prompt({ text: "select", mode: "prompt" });
    const [first, second, empty] = await waitFor(() => {
      const approvals = events.filter((event) => event.type === "approval").map((event) => event.approval);
      return approvals.length === 3 && approvals;
    });
    assert.deepEqual(first.options, [
      { id: "option-1", label: "Allow" },
      { id: "option-2", label: "Block" },
      { id: "option-3", label: "Line one line two" },
    ]);
    assert.deepEqual(first.decisions, ["approve-once", "cancel"]);
    assert.equal(first.inputLabel, undefined);
    assert.deepEqual(empty.options, []);
    assert.deepEqual(empty.decisions, ["cancel"]);
    assert.doesNotMatch(JSON.stringify(events), /native-select/);

    for (const text of ["Maybe", undefined, "option-9"]) {
      await assert.rejects(
        adapter.respond({ requestId: first.id, decision: "approve-once", text }),
        { bridgeCode: "invalid-response" },
      );
    }
    const pending = (await adapter.snapshot()).approvals.map((approval) => approval.id);
    assert.ok(pending.includes(first.id), "an invalid answer keeps the dialog pending");

    await adapter.respond({ requestId: first.id, decision: "approve-once", text: "option-2" });
    assert.equal((await adapter.snapshot()).title, "ui:Block");
    await assert.rejects(
      adapter.respond({ requestId: first.id, decision: "approve-once", text: "option-1" }),
      { bridgeCode: "stale-approval" },
    );

    await adapter.respond({ requestId: second.id, decision: "approve-once", text: "Line one line two" });
    assert.equal((await adapter.snapshot()).title, "ui:Line one\nline two");

    await assert.rejects(
      adapter.respond({ requestId: empty.id, decision: "approve-once", text: "option-1" }),
      { bridgeCode: "stale-approval" },
    );
    await adapter.respond({ requestId: empty.id, decision: "cancel" });
    assert.equal((await adapter.snapshot()).title, "ui:cancelled");
  } finally { await adapter.dispose(); }
});

test("Pi forwards fire-and-forget extension UI as bounded surface requests without replying", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "surfaces");
    const surfaces = events.filter((event) => event.type === "extensionUi").map((event) => event.request);
    assert.deepEqual(surfaces.map((request) => request.method), ["notify", "setStatus", "setWidget", "setWidget", "setTitle", "set_editor_text"]);
    assert.deepEqual(surfaces[0], { method: "notify", id: "native-notify", message: "Deployed to /srv/app", notifyType: "warning" });
    assert.deepEqual(surfaces[2], { method: "setWidget", id: "native-widget", widgetKey: "todo", widgetPlacement: "belowEditor", widgetLines: ["a", "b"] });
    assert.equal(surfaces[3].widgetLines, undefined, "an oversized widget is dropped for the host to report");
    assert.doesNotMatch(JSON.stringify(surfaces), /SECRET-MUST-NOT-LEAK|extension_ui_request/);
    assert.equal((await adapter.snapshot()).title, "Fixture", "fire-and-forget requests get no native reply");
  } finally { await adapter.dispose(); }
});

test("Pi cancels and reports an unknown extension UI method", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "unknownui");
    const [surface] = events.filter((event) => event.type === "extensionUi");
    assert.deepEqual(surface.request, { method: "custom", id: "native-custom" });
    assert.equal((await adapter.snapshot()).title, "ui:cancelled");
    assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK/);
  } finally { await adapter.dispose(); }
});

test("Pi editor dialogs carry their prefill and retire when Pi's timeout ends them", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await adapter.prompt({ text: "surfaces", mode: "prompt" });
    const approval = await waitFor(() => events.find((event) => event.type === "approval")?.approval);
    assert.equal(approval.prefill, "feat: draft");
    assert.equal(approval.timeoutMs, 40);
    assert.equal(approval.inputLabel, "Response");
    await waitFor(() => events.some((event) => event.type === "approvalResolved" && event.requestId === approval.id));
    await assert.rejects(adapter.respond({ requestId: approval.id, decision: "approve-once", text: "late" }), { bridgeCode: "stale-approval" });
    assert.equal((await adapter.snapshot()).approvals.length, 0);
  } finally { await adapter.dispose(); }
});

const PNG = { mimeType: "image/png", data: "iVBORw0KGgo=" };

test("Pi sends images as native ImageContent and lists them in the user block", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    assert.equal((await adapter.composerCapabilities()).images, true);
    await adapter.prompt({ text: "look", mode: "prompt", images: [PNG, { mimeType: "image/webp", data: "UklGRg==" }] });
    const snapshot = await waitFor(async () => {
      const current = await adapter.snapshot();
      return current.title.startsWith("images:") ? current : undefined;
    });
    assert.equal(snapshot.title, "images:prompt:image/image/png/iVBORw0KGgo=,image/image/webp/UklGRg==");
    const user = await waitFor(() => events.find((event) => event.type === "block" && event.block.kind === "user")?.block);
    assert.equal(user.text, "look\n\n[image]\n[image]");
    assert.ok(!JSON.stringify(events).includes("iVBORw0KGgo="), "image bytes never reach a block");
  } finally { await adapter.dispose(); }
});

test("Pi refuses images a text-only model cannot take and malformed images", async () => {
  const adapter = await createPiAdapter(config({ runtimeArgs: [fixture, "--text-only-model"] }), () => {});
  try {
    assert.equal((await adapter.composerCapabilities()).images, false);
    await assert.rejects(adapter.prompt({ text: "look", mode: "prompt", images: [PNG] }), { bridgeCode: "unsupported-input" });
    assert.equal((await adapter.snapshot()).title, "Fixture", "nothing reached Pi");
  } finally { await adapter.dispose(); }
  const images = await createPiAdapter(config(), () => {});
  try {
    for (const invalid of [[{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }], [{ mimeType: "image/png" }], "not-a-list", Array.from({ length: 7 }, () => PNG)]) {
      await assert.rejects(images.prompt({ text: "look", mode: "prompt", images: invalid }), { bridgeCode: "invalid-request" });
    }
  } finally { await images.dispose(); }
});

test("Pi lists its own slash commands without native paths", async () => {
  const adapter = await createPiAdapter(config(), () => {});
  try {
    const catalog = await adapter.composerCatalog();
    assert.deepEqual(catalog, {
      commands: [
        { name: "skill:review", description: "Review a diff", source: "skill" },
        { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
        { name: "session-name", description: "Set or clear session name", source: "extension" },
      ],
      skills: [],
    });
    assert.ok(!JSON.stringify(catalog).includes("SECRET"));
  } finally { await adapter.dispose(); }
});
