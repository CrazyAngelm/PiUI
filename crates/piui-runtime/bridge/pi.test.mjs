import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("Pi catalog uses one model request and skips state and history even if skills fail", async () => {
  for (const failCommands of [false, true]) {
    const events = [];
    const runtimeArgs = [fixture, "--catalog-only-fixture", ...(failCommands ? ["--fail-commands"] : [])];
    const adapter = await createPiAdapter(config({ catalogOnly: true, nativeId: "saved", runtimeArgs }), event => events.push(event));
    try {
      assert.deepEqual(await adapter.catalogModels(), [{ id: "model", provider: "fixture", name: "Fixture Model", supportsFast: false }]);
      const resources = await adapter.resources();
      assert.deepEqual(resources.warnings, failCommands ? ["Skills could not be loaded from Pi."] : []);
      assert.equal(resources.items.some(item => item.kind === "skill"), !failCommands);
      assert.equal(adapter.prompt, undefined);
      assert.ok(!events.some(event => event.type === "binding"));
    } finally { await adapter.dispose(); }
  }
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

test("Pi local commands complete without an agent event and leave the next prompt independent", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), event => events.push(event));
  try {
    const completed = () => events.filter(event => event.type === "turnCompleted");
    await adapter.prompt({ text: "/skill-paths", mode: "prompt" });
    assert.deepEqual(completed(), [{ type: "turnCompleted", outcome: "succeeded" }]);
    assert.equal((await adapter.snapshot()).status, "idle");
    await adapter.prompt({ text: "test", mode: "prompt" });
    assert.equal(completed().length, 1);
    await waitFor(() => completed().length === 2);
    assert.deepEqual(completed().map(event => event.outcome), ["succeeded", "succeeded"]);
  } finally { await adapter.dispose(); }
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

// One admitted turn must yield exactly one completion, after the retried run
// answered, and Pi must not read as idle before then.
async function assertSingleRetryCompletion(adapter, events, scenario) {
  const start = events.length;
  await runScenario(adapter, events, scenario);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const turn = events.slice(start);
  const completions = turn.filter((event) => event.type === "turnCompleted");
  assert.equal(completions.length, 1, "the retried run is part of the same turn");
  assert.equal(completions[0].outcome, "succeeded");
  const statuses = turn.filter((event) => event.type === "status").map((event) => event.status);
  assert.deepEqual(statuses, ["running", "idle"]);
  assert.ok(turn.findIndex((event) => event.type === "turnCompleted") < turn.findIndex((event) => event.type === "status" && event.status === "idle"));
  assert.ok(turn.some((event) => event.type === "textDelta" && event.text === "recovered answer"));
}

test("Pi completes a retried turn once, on agent_settled, with the successful answer", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    // The first agent_settled teaches an unversioned runtime to wait for it.
    await runScenario(adapter, events, "ok");
    await assertSingleRetryCompletion(adapter, events, "retry");
  } finally { await adapter.dispose(); }
});

test("Pi waits for agent_settled across queued continuations once it is known", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "ok");
    const start = events.length;
    await runScenario(adapter, events, "continued");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const turn = events.slice(start);
    assert.equal(turn.filter((event) => event.type === "turnCompleted").length, 1);
    assert.deepEqual(turn.filter((event) => event.type === "status").map((event) => event.status), ["running", "idle"]);
  } finally { await adapter.dispose(); }
});

test("Pi without agent_settled still defers a willRetry agent_end and completes on the final one", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try { await assertSingleRetryCompletion(adapter, events, "retry-legacy"); }
  finally { await adapter.dispose(); }
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

test("Pi shows one safe fallback per unknown native event type and survives a frame it cannot process", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "futureevents");
    const fallbacks = (await adapter.snapshot()).blocks.filter((block) => block.fallback === true);
    assert.deepEqual(fallbacks.map((block) => block.safeSummary).sort(), [
      "Unsupported Pi event: future_event",
      "Unsupported Pi event: unknown",
    ], "repeats report once; a hostile or missing type is shown as unknown; known housekeeping stays silent");
    assert.ok(fallbacks.every((block) => block.kind === "unknown" && block.status === "complete"));
    assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK|<script>/);
    assert.ok(!events.some((event) => event.type === "status" && event.status === "failed"), "the runtime keeps running");
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

test("Pi starts a native run for an idle follow-up instead of only queueing it", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    assert.equal((await adapter.snapshot()).status, "idle");
    await adapter.prompt({ text: "later", mode: "follow-up", images: [PNG] });
    const outcome = await waitFor(() => events.find((event) => event.type === "turnCompleted")?.outcome);
    assert.equal(outcome, "succeeded");
    assert.ok(events.some((event) => event.type === "textDelta" && event.text === "answer"));
    // The fixture records the native command that carried the images.
    assert.equal((await adapter.snapshot()).title, "images:prompt:image/image/png/iVBORw0KGgo=");
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

// A Pi entry script inside a package of the given version, which the adapter
// reads to learn whether the runtime reports `agent_settled` (Pi >= 0.80.4).
async function versionedConfig(version) {
  const directory = await mkdtemp(join(tmpdir(), "piui-pi-version-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  const entry = join(directory, "cli.js");
  await writeFile(entry, `import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
  return { directory, config: (overrides = {}) => config({ runtimeArgs: [entry], ...overrides }) };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turnStatuses = (events) => events.filter((event) => event.type === "status").map((event) => event.status);

test("the same Pi answer has the same block id live and in resumed history", async () => {
  const events = [];
  const live = await createPiAdapter(config(), (event) => events.push(event));
  let liveAnswer;
  try {
    await runScenario(live, events, "ok");
    liveAnswer = (await live.snapshot()).blocks.find((block) => block.kind === "assistant");
    assert.match(liveAnswer.id, /^pi-assistant-[0-9a-f]{24}$/, "derived from the message identity, not a live counter");
    assert.ok(events.some((event) => event.type === "textDelta" && event.blockId === liveAnswer.id && event.text === "answer"));
  } finally { await live.dispose(); }

  // A later process reads the same answer back from the session entries of Pi.
  const resumed = await createPiAdapter(config({ runtimeArgs: [fixture, "--history-answer"] }), () => {});
  try {
    const blocks = (await resumed.snapshot()).blocks;
    const answer = blocks.find((block) => block.kind === "assistant");
    assert.equal(answer.id, liveAnswer.id, "same answer, same id after a restart");
    assert.equal(answer.text, "answer");
    assert.equal(new Set(blocks.map((block) => block.id)).size, blocks.length, "ids stay unique");
    assert.doesNotMatch(JSON.stringify(blocks), /entry-answer-private/);
  } finally { await resumed.dispose(); }
});

test("a Pi assistant block without a message timestamp keeps a unique live id", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "retry");
    const answers = (await adapter.snapshot()).blocks.filter((block) => block.kind === "assistant");
    assert.equal(answers.length, 1);
    assert.match(answers[0].id, /^pi-stream-\d+$/);
  } finally { await adapter.dispose(); }
});

test("an unidentified Pi build waits for a quiet runtime before the first turn completes", async () => {
  for (const scenario of ["late-continuation", "compaction-recovery"]) {
    const events = [];
    const adapter = await createPiAdapter(config(), (event) => events.push(event));
    try {
      // The very first turn: no warm-up turn has taught the adapter anything.
      const start = events.length;
      await runScenario(adapter, events, scenario);
      await pause(60);
      const turn = events.slice(start);
      const completions = turn.filter((event) => event.type === "turnCompleted");
      assert.equal(completions.length, 1, `${scenario}: the continued run is part of the same turn`);
      assert.equal(completions[0].outcome, "succeeded");
      assert.deepEqual(turnStatuses(turn), ["running", "idle"], scenario);
      const lastDelta = turn.findLastIndex((event) => event.type === "textDelta");
      assert.ok(lastDelta >= 0 && lastDelta < turn.findIndex((event) => event.type === "turnCompleted"), `${scenario}: completion follows the continuation`);
    } finally { await adapter.dispose(); }
  }
});

test("an unidentified Pi build stays running while get_state reports a busy run", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    const started = Date.now();
    await runScenario(adapter, events, "quiet-busy");
    assert.ok(Date.now() - started >= 600, "two busy probes each postponed the completion by a grace period");
    assert.equal(events.filter((event) => event.type === "turnCompleted").length, 1);
  } finally { await adapter.dispose(); }
});

test("a Pi runtime positively older than 0.80.4 completes on the first quiet agent_end", async () => {
  const legacy = await versionedConfig("0.80.3");
  const events = [];
  const adapter = await createPiAdapter(legacy.config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "late-continuation");
    await pause(200);
    const completed = events.findIndex((event) => event.type === "turnCompleted");
    const secondAnswer = events.findIndex((event) => event.type === "textDelta" && event.text === "second");
    assert.ok(completed >= 0 && completed < secondAnswer, "the legacy fallback ends the turn at agent_end");
  } finally { await adapter.dispose(); await rm(legacy.directory, { recursive: true, force: true }); }
});

test("Pi 0.80.4 and newer complete only on agent_settled, from the very first turn", async () => {
  const cases = [
    ["0.80.3", ["running", "idle", "running", "idle"]],
    ["0.80.4", ["running", "idle"]],
    ["0.85.1", ["running", "idle"]],
    ["1.0.0", ["running", "idle"]],
  ];
  for (const [version, expected] of cases) {
    const versioned = await versionedConfig(version);
    const events = [];
    const adapter = await createPiAdapter(versioned.config(), (event) => events.push(event));
    try {
      const start = events.length;
      await runScenario(adapter, events, "continued");
      await pause(150);
      const turn = events.slice(start);
      assert.deepEqual(turnStatuses(turn), expected, version);
      assert.equal(turn.filter((event) => event.type === "turnCompleted").length, 1, version);
    } finally { await adapter.dispose(); await rm(versioned.directory, { recursive: true, force: true }); }
  }
});

test("a transient Pi error that a retry recovers never pauses the host with an error event", async () => {
  const versioned = await versionedConfig("0.85.1");
  const legacy = await versionedConfig("0.79.0");
  try {
    for (const adapterConfig of [config(), versioned.config()]) {
      const events = [];
      const adapter = await createPiAdapter(adapterConfig, (event) => events.push(event));
      try {
        await adapter.prompt({ text: "retry-slow", mode: "prompt" });
        await pause(120);
        assert.equal(events.filter((event) => event.type === "error").length, 0, "no error while Pi is about to retry");
        assert.equal(events.filter((event) => event.type === "turnCompleted").length, 0);
        // The adapter already reported idle at start, so wait for the completion itself.
        await waitFor(() => events.some((event) => event.type === "turnCompleted"));
        assert.deepEqual(events.filter((event) => event.type === "error"), []);
        assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
      } finally { await adapter.dispose(); }
    }
    // The legacy path defers the same way.
    const events = [];
    const adapter = await createPiAdapter(legacy.config(), (event) => events.push(event));
    try {
      await runScenario(adapter, events, "retry-legacy");
      assert.deepEqual(events.filter((event) => event.type === "error"), []);
    } finally { await adapter.dispose(); }
  } finally {
    await rm(versioned.directory, { recursive: true, force: true });
    await rm(legacy.directory, { recursive: true, force: true });
  }
});

test("when the retries of Pi fail, one error is reported with the failed turn", async () => {
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "retry-exhausted");
    const errors = events.filter((event) => event.type === "error");
    assert.deepEqual(errors, [{ type: "error", message: "The Pi model provider is temporarily unavailable." }]);
    const completed = events.findIndex((event) => event.type === "turnCompleted");
    assert.equal(events[completed].outcome, "failed");
    assert.equal(events.indexOf(errors[0]), completed - 1, "the error comes with the terminal outcome, not at the first attempt");
  } finally { await adapter.dispose(); }
});

// --- Nano lane (harness "nano"): the same bridge, a private agent directory and a cleared environment ---

const RELAY_KEY = "relay-key-canary-0123456789abcdef";
const AGENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const GUARD = join(AGENT_DIR, "nano-guard.ts");
const SKILL_PATHS = join(AGENT_DIR, "bundled", "skill-paths.ts");
const BES_SKILL = join(AGENT_DIR, "bundled", "bes-deep-mode", "SKILL.md");
const BUNDLED_FLAGS = ["--no-skills", "--skill", BES_SKILL, "--no-extensions", "-e", SKILL_PATHS];
const WINDOWS_POWERSHELL = join(AGENT_DIR, "bundled", "windows-powershell.ts");
const WINDOWS_NATIVE_TOOLS = process.platform === "win32" ? ["--tools", "read,edit,write,nano_powershell"] : [];
const WINDOWS_SHELL_FLAGS = process.platform === "win32" ? ["-e", WINDOWS_POWERSHELL] : [];
const NANO_OVERRIDES = { nano: { agentDir: AGENT_DIR, guardExtension: GUARD }, model: { provider: "nano", id: "smart", name: "Smart" } };
// Like the host, which starts each Nano bridge with the key in its process
// environment, every Nano config puts the key there for the next adapter.
function nanoConfig(overrides = {}) {
  process.env.PIUI_NANO_RELAY_KEY = RELAY_KEY;
  return config({ harness: "nano", ...NANO_OVERRIDES, ...overrides });
}

// An entry script that records what Pi was started with, then runs the fixture.
async function recordingConfig(version) {
  const directory = await mkdtemp(join(tmpdir(), "piui-pi-launch-"));
  const record = join(directory, "launch.json");
  if (version) await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  const entry = join(directory, "cli.js");
  await writeFile(entry, `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));\nimport(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
  return {
    directory,
    entry,
    config: (overrides = {}) => config({ runtimeArgs: [entry], ...overrides }),
    nanoConfig: (overrides = {}) => nanoConfig({ runtimeArgs: [entry], ...overrides }),
    launch: async () => JSON.parse(await readFile(record, "utf8")),
  };
}
async function launchOf(overrides) {
  const recording = await recordingConfig();
  const events = [];
  try {
    const adapter = await createPiAdapter(recording.nanoConfig(overrides), (event) => events.push(event));
    try { return { launch: await recording.launch(), events, snapshot: await adapter.snapshot() }; }
    finally { await adapter.dispose(); }
  } finally { await rm(recording.directory, { recursive: true, force: true }); }
}

// Mirrors the adapter's allowlist for the platform the test runs on.
const NANO_OS_ENVIRONMENT = process.platform === "win32" ? new Set([
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "ALLUSERSPROFILE", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PSMODULEPATH", "LANG", "TZ", "TERM",
]) : new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ", "TERM", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
]);
// Windows adds a few non-secret names to any child it starts, whatever the environment block holds.
const WINDOWS_ADDED = new Set(["LOGONSERVER", "SESSIONNAME"]);
const NANO_VARIABLES = new Set(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"]);
const canonical = (name) => (process.platform === "win32" ? name.toUpperCase() : name);

test("the Nano lane starts upstream Pi with its own flags, no approval trust and no relay key in the arguments", async () => {
  const { launch, events, snapshot } = await launchOf({});
  assert.deepEqual(launch.args, [
    "--mode", "rpc", "--no-approve", "--offline", "--session-dir", process.cwd(),
    "--provider", "nano", "--model", "smart", ...WINDOWS_NATIVE_TOOLS, ...BUNDLED_FLAGS, "-e", GUARD, ...WINDOWS_SHELL_FLAGS,
  ]);
  assert.ok(!launch.args.includes("--approve"));
  assert.ok(!launch.args.includes("--thinking"));
  assert.ok(!JSON.stringify(launch.args).includes(RELAY_KEY), "the key never reaches the command line");
  assert.ok(!JSON.stringify(events).includes(RELAY_KEY));
  assert.ok(!JSON.stringify(snapshot).includes(RELAY_KEY));
  assert.equal(launch.env.PIUI_NANO_RELAY_KEY, undefined, "the bridge variable never reaches Pi");
  assert.equal(process.env.PIUI_NANO_RELAY_KEY, undefined, "the bridge removes the key from its own environment");
});

test("a host-configured external source stays selected in the private Nano Pi lane", async () => {
  const model = { provider: `nano-external-${"f".repeat(32)}`, id: "vendor/model", name: "External model" };
  const { launch, snapshot } = await launchOf({ model });
  assert.deepEqual(launch.args.slice(6, 10), ["--provider", model.provider, "--model", model.id]);
  assert.equal(snapshot.model.provider, model.provider);
  assert.equal(snapshot.model.id, model.id);
});

test("the Nano relay key comes only from the bridge environment, never from the initialize frame", async () => {
  // A key in the frame is refused even with a key in the environment.
  await assert.rejects(
    createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", nano: { agentDir: AGENT_DIR, guardExtension: GUARD, relayKey: RELAY_KEY } }), () => {}),
    (error) => error.bridgeCode === "invalid-request" && !JSON.stringify([error.message, error.safeMessage]).includes(RELAY_KEY),
  );
  assert.equal(process.env.PIUI_NANO_RELAY_KEY, undefined, "a refused start removes the key too");
  for (const value of [undefined, ""]) {
    const candidate = nanoConfig({ runtimeProgram: "must-not-launch" });
    if (value === undefined) delete process.env.PIUI_NANO_RELAY_KEY; else process.env.PIUI_NANO_RELAY_KEY = value;
    await assert.rejects(createPiAdapter(candidate, () => {}), { bridgeCode: "invalid-request" }, JSON.stringify(value));
  }
  // The Pi lane neither reads nor removes the variable.
  process.env.PIUI_NANO_RELAY_KEY = "pi-lane-ignores-it";
  try {
    const adapter = await createPiAdapter(config(), () => {});
    await adapter.dispose();
    assert.equal(process.env.PIUI_NANO_RELAY_KEY, "pi-lane-ignores-it");
  } finally { delete process.env.PIUI_NANO_RELAY_KEY; }
});

test("Nano refuses to run the CLI without the relay key preload", async () => {
  const recording = await recordingConfig();
  const events = [];
  try {
    await assert.rejects(
      createPiAdapter(recording.nanoConfig({ nano: { agentDir: recording.directory, guardExtension: GUARD } }),
        (event) => events.push(event)),
      { bridgeCode: "runtime-exited" },
    );
    await assert.rejects(recording.launch(), { code: "ENOENT" });
    assert.ok(!JSON.stringify(events).includes(RELAY_KEY));
  } finally { await rm(recording.directory, { recursive: true, force: true }); }
});

test("the Nano lane passes session and name flags like the Pi lane", async () => {
  const { launch } = await launchOf({ nativeId: "session-7", title: "Nano chat" });
  assert.deepEqual(launch.args.slice(0, 9), ["--mode", "rpc", "--no-approve", "--offline", "--session-dir", process.cwd(), "--session-id", "session-7", "--name"]);
  assert.equal(launch.args[9], "Nano chat");
  const resumed = await launchOf({ nativePath: join(tmpdir(), "native.jsonl") });
  assert.equal(resumed.launch.args[resumed.launch.args.indexOf("--session") + 1], join(tmpdir(), "native.jsonl"));
});

test("the Nano lane clears the environment to an OS allowlist plus the Nano variables", async () => {
  const canaries = {
    OPENAI_API_KEY: "sk-canary-openai", ANTHROPIC_API_KEY: "sk-canary-anthropic", OPENROUTER_API_KEY: "sk-canary-router",
    NANO_ACCESS_TOKEN: "canary-access-token", HTTPS_PROXY: "http://user:canary@example.com:8080", PIUI_CANARY: "canary",
    PI_CODING_AGENT_DIR: "C:/user/.pi/agent", NANO_RELAY_KEY: "stale-key",
  };
  const saved = Object.fromEntries(Object.keys(canaries).map((name) => [name, process.env[name]]));
  Object.assign(process.env, canaries);
  try {
    const { launch } = await launchOf({});
    const names = Object.keys(launch.env).filter((name) => !name.startsWith("="));
    for (const name of names) {
      assert.ok(NANO_OS_ENVIRONMENT.has(canonical(name)) || WINDOWS_ADDED.has(canonical(name)) || NANO_VARIABLES.has(canonical(name)) || canonical(name).startsWith("LC_"), `unexpected child variable ${name}`);
    }
    assert.equal(launch.env.PI_CODING_AGENT_DIR, AGENT_DIR, "the private agent directory wins over the user's");
    assert.equal(launch.env.PI_OFFLINE, "1");
    assert.equal(launch.env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(launch.env.PI_TELEMETRY, "0");
    assert.equal(launch.env.NANO_RELAY_KEY, undefined, "the Pi preload removes the key before the CLI runs");
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "NANO_ACCESS_TOKEN", "HTTPS_PROXY", "PIUI_CANARY", "NANO_RELAY_KEY"]) {
      assert.ok(!names.some((candidate) => canonical(candidate) === name), `${name} must not reach the child`);
    }
    assert.ok(!/sk-canary|canary-access|stale-key|user:canary/.test(JSON.stringify(launch.env)));
    // What a program the agent starts needs in order to run is kept.
    assert.ok(names.some((name) => canonical(name) === "PATH"), "PATH is kept");
    if (process.platform === "win32") assert.ok(names.some((name) => canonical(name) === "SYSTEMROOT"), "SystemRoot is kept");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("the Pi lane keeps its old arguments and inherited environment", async () => {
  const saved = process.env.PIUI_CANARY;
  process.env.PIUI_CANARY = "inherited";
  const recording = await recordingConfig();
  try {
    const adapter = await createPiAdapter(recording.config({ model: { provider: "fixture", id: "m", name: "M" }, thinkingLevel: "medium", permissionMode: "read-only", allowedTools: ["read", "grep"] }), () => {});
    try {
      const launch = await recording.launch();
      assert.deepEqual(launch.args, [
        "--mode", "rpc", "--approve", "--session-dir", process.cwd(), "--provider", "fixture", "--model", "m",
        "--thinking", "medium", "--tools", "read,grep", "--no-extensions",
      ]);
      assert.equal(launch.env.PIUI_CANARY, "inherited", "the Pi lane does not clear the environment");
      assert.equal(launch.env.NANO_RELAY_KEY, undefined);
    } finally { await adapter.dispose(); }
  } finally {
    if (saved === undefined) delete process.env.PIUI_CANARY; else process.env.PIUI_CANARY = saved;
    await rm(recording.directory, { recursive: true, force: true });
  }
});

test("the Nano read-only mode passes only Pi's read tools and keeps the guard loaded", async () => {
  const { launch } = await launchOf({ permissionMode: "read-only" });
  const tools = launch.args.indexOf("--tools");
  assert.equal(launch.args[tools + 1], "read,grep,find,ls");
  assert.ok(launch.args.indexOf("--no-extensions") > tools);
  assert.equal(launch.args[launch.args.lastIndexOf("-e") + 1], GUARD);
  assert.deepEqual(launch.args.slice(tools + 2, -2), BUNDLED_FLAGS);
  assert.ok(!launch.args.includes(WINDOWS_POWERSHELL));
  const narrowed = await launchOf({ permissionMode: "read-only", allowedTools: ["read", "write", "bash"] });
  assert.equal(narrowed.launch.args[narrowed.launch.args.indexOf("--tools") + 1], "read");
  const none = await launchOf({ permissionMode: "read-only", allowedTools: ["write"] });
  assert.ok(none.launch.args.includes("--no-tools"));
  assert.ok(!none.launch.args.includes("--tools"));
  assert.ok(none.launch.args.includes("--no-extensions"));
});

test("the Nano guard flag is present only when the host supplies the extension", async () => {
  const full = await launchOf({ permissionMode: "full-access", nano: { agentDir: AGENT_DIR, guardExtension: null } });
  const fullFlags = [...WINDOWS_NATIVE_TOOLS, ...BUNDLED_FLAGS, ...WINDOWS_SHELL_FLAGS];
  assert.deepEqual(full.launch.args.slice(-fullFlags.length), fullFlags);
  assert.ok(!full.launch.args.includes(GUARD));
  const native = await launchOf({ permissionMode: "native" });
  assert.equal(native.launch.args.filter((value) => value === "-e").length, 2 + WINDOWS_SHELL_FLAGS.length / 2);
  assert.equal(native.launch.args.at(-1 - WINDOWS_SHELL_FLAGS.length), GUARD);
  // Native approvals without the guard would run bash, write and edit unasked.
  await assert.rejects(
    createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", permissionMode: "native", nano: { agentDir: AGENT_DIR, guardExtension: null } }), () => {}),
    { bridgeCode: "unsupported-policy" },
  );
});

test("a narrowed Windows Nano tool allowlist controls registration of the trusted shell", { skip: process.platform !== "win32" }, async () => {
  const read = await launchOf({ allowedTools: ["read"] });
  assert.ok(!read.launch.args.includes(WINDOWS_POWERSHELL));
  const shell = await launchOf({ allowedTools: ["bash"] });
  assert.equal(shell.launch.args[shell.launch.args.indexOf("--tools") + 1], "nano_powershell");
  assert.ok(shell.launch.args.includes(WINDOWS_POWERSHELL));
});

test("the Nano lane refuses an incomplete or malformed configuration before starting Pi", async () => {
  const bad = [
    { nano: undefined },
    { nano: null },
    { nano: "agent" },
    { nano: [] },
    { nano: { guardExtension: GUARD } },
    { nano: { agentDir: AGENT_DIR, guardExtension: GUARD, relayKey: RELAY_KEY } },
    { nano: { agentDir: AGENT_DIR, guardExtension: GUARD, relayKey: "" } },
    { nano: { agentDir: 7, guardExtension: GUARD } },
    { nano: { agentDir: "relative/agent", guardExtension: GUARD } },
    { nano: { agentDir: AGENT_DIR } },
    { nano: { agentDir: AGENT_DIR, guardExtension: 5 } },
    { nano: { agentDir: AGENT_DIR, guardExtension: "nano-guard.ts" } },
  ];
  for (const overrides of bad) {
    await assert.rejects(
      createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", ...overrides }), () => {}),
      (error) => error.bridgeCode === "invalid-request" && !JSON.stringify([error.message, error.safeMessage]).includes(RELAY_KEY),
      JSON.stringify(overrides),
    );
  }
  await assert.rejects(createPiAdapter(config({ harness: "codex" }), () => {}), { bridgeCode: "wrong-harness" });
  await assert.rejects(createPiAdapter(config({ harness: "nano" }), () => {}), { bridgeCode: "invalid-request" });
});

test("the Nano lane refuses another provider, a model without an id and any thinking level", async () => {
  for (const model of [{ provider: "openai", id: "gpt-5", name: "GPT" }, { provider: "pi", id: "smart", name: "Smart" }, { id: "smart", name: "Smart" }, { provider: "nano", name: "No id" }, { provider: "nano", id: "", name: "Empty" }]) {
    await assert.rejects(
      createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", model }), () => {}),
      { bridgeCode: "unsupported-settings" },
      JSON.stringify(model),
    );
  }
  await assert.rejects(createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", thinkingLevel: "high" }), () => {}), { bridgeCode: "unsupported-settings" });
});

test("a Nano session reopened without a model keeps its recorded Nano model and refuses any other", async () => {
  for (const model of [undefined, null]) {
    const recording = await recordingConfig();
    try {
      // The fixture reports a restored Nano model.
      const adapter = await createPiAdapter(recording.nanoConfig({ model, runtimeArgs: [recording.entry, "--restored-nano-model"] }), () => {});
      try {
        const { args } = await recording.launch();
        // Neither flag: Pi exits on `--provider` without `--model`.
        assert.deepEqual(args, ["--restored-nano-model", "--mode", "rpc", "--no-approve", "--offline", "--session-dir", process.cwd(), ...WINDOWS_NATIVE_TOOLS, ...BUNDLED_FLAGS, "-e", GUARD, ...WINDOWS_SHELL_FLAGS]);
      } finally { await adapter.dispose(); }
    } finally { await rm(recording.directory, { recursive: true, force: true }); }
  }
  // The fixture's own (non-Nano) model is what Pi restored: refused, never used.
  const recording = await recordingConfig();
  const events = [];
  try {
    await assert.rejects(
      createPiAdapter(recording.nanoConfig({ model: undefined }), (event) => events.push(event)),
      { bridgeCode: "unsupported-settings" },
    );
    const { args } = await recording.launch();
    assert.ok(!args.includes("--provider"));
    assert.ok(!events.some((event) => event.type === "status" && event.status === "failed"), "a refused start is not a native failure");
  } finally { await rm(recording.directory, { recursive: true, force: true }); }
});

test("the Nano lane refuses what the Pi lane refuses, and starts without the board tool", async () => {
  const refused = [
    [{ permissionMode: "workspace-write" }, "unsupported-policy"],
    [{ coordination: true }, "unsupported-policy"],
    [{ nativeSubagents: true }, "unsupported-policy"],
    [{ allowedTools: ["workspace"] }, "unsupported-policy"],
    [{ resourceRules: [{ kind: "skill", id: "canary", enabled: false }] }, "unsupported-resource-policy"],
    [{ pluginMcpServers: [{ name: "example", command: process.execPath, args: ["server.mjs"] }] }, "unsupported-settings"],
  ];
  for (const [overrides, code] of refused) {
    await assert.rejects(createPiAdapter(nanoConfig({ runtimeProgram: "must-not-launch", ...overrides }), () => {}), { bridgeCode: code }, JSON.stringify(overrides));
  }
  const events = [];
  const adapter = await createPiAdapter(nanoConfig({ hostTools: ["board"] }), (event) => events.push(event));
  try { assert.deepEqual(events.filter((event) => event.type === "notice"), [{ type: "notice", code: "unsupported-board-tool" }]); }
  finally { await adapter.dispose(); }
});

test("a Nano session needs Pi 1.4.0 or newer when the version is known", async () => {
  for (const version of ["1.3.9", "0.85.1", "0.99.0"]) {
    const recording = await recordingConfig(version);
    try {
      await assert.rejects(createPiAdapter(recording.nanoConfig(), () => {}), { bridgeCode: "unsupported-native-version" }, version);
    } finally { await rm(recording.directory, { recursive: true, force: true }); }
  }
  for (const version of ["1.4.0", "1.5.2", "2.0.0"]) {
    const recording = await recordingConfig(version);
    try {
      const adapter = await createPiAdapter(recording.nanoConfig(), () => {});
      await adapter.dispose();
    } finally { await rm(recording.directory, { recursive: true, force: true }); }
  }
  // The Pi lane keeps working on an older Pi.
  const legacy = await versionedConfig("0.85.1");
  try {
    const adapter = await createPiAdapter(legacy.config(), () => {});
    await adapter.dispose();
  } finally { await rm(legacy.directory, { recursive: true, force: true }); }
});

test("Nano sessions list only Nano models and no thinking levels, and cannot switch provider", async () => {
  const adapter = await createPiAdapter(nanoConfig(), () => {});
  try {
    assert.deepEqual(await adapter.models(), [], "the fixture's non-Nano model is never offered");
    assert.deepEqual(await adapter.catalogModels(), []);
    assert.deepEqual((await adapter.snapshot()).models, []);
    await assert.rejects(adapter.setModel({ model: { provider: "fixture", id: "model" } }), { bridgeCode: "unsupported-settings" });
    await assert.rejects(adapter.setModel({ model: { provider: "nano", id: "fast" }, thinkingLevel: "high" }), { bridgeCode: "unsupported-settings" });
    await adapter.setModel({ model: { provider: "nano", id: "fast" } });
  } finally { await adapter.dispose(); }
  const pi = await createPiAdapter(config(), () => {});
  try { assert.equal((await pi.models()).length, 1, "the Pi lane still lists every native model"); }
  finally { await pi.dispose(); }
});

test("Nano relay errors become fixed summaries and the native text stays private", async () => {
  for (const [scenario, expected] of [
    ["nano-credits", "Your Nano credits are used up."],
    ["nano-plain", "The Pi turn failed."],
  ]) {
    const events = [];
    const adapter = await createPiAdapter(nanoConfig(), (event) => events.push(event));
    try {
      await runScenario(adapter, events, scenario);
      assert.deepEqual(events.filter((event) => event.type === "error"), [{ type: "error", message: expected }], scenario);
      assert.equal(events.find((event) => event.type === "turnCompleted").outcome, "failed");
      assert.ok(!/SECRET-MUST-NOT-LEAK|nano_credits_exhausted/.test(JSON.stringify(events)));
    } finally { await adapter.dispose(); }
  }
  // The Pi lane does not interpret relay codes.
  const events = [];
  const adapter = await createPiAdapter(config(), (event) => events.push(event));
  try {
    await runScenario(adapter, events, "nano-credits");
    assert.deepEqual(events.filter((event) => event.type === "error"), [{ type: "error", message: "The Pi turn failed." }]);
  } finally { await adapter.dispose(); }
});

// --- nano-guard.ts: the approval-prompt extension (not a sandbox) ---

async function loadGuard() {
  try { return (await import(pathToFileURL(fileURLToPath(new URL("./nano-guard.ts", import.meta.url))).href)).default; }
  catch (error) {
    if (error?.code === "ERR_UNKNOWN_FILE_EXTENSION") return undefined; // Node without type stripping
    throw error;
  }
}
async function guardHandler() {
  const guard = await loadGuard();
  if (!guard) return undefined;
  const handlers = {};
  guard({ on: (name, handler) => { handlers[name] = handler; } });
  assert.deepEqual(Object.keys(handlers), ["tool_call"]);
  return handlers.tool_call;
}
const uiContext = (answer, calls = []) => ({ hasUI: true, ui: { select: async (title, options) => { calls.push({ title, options }); return typeof answer === "function" ? answer(title, options) : answer; } } });

test("the Nano guard lets read tools through and asks before Bash, PowerShell, write and edit", async (t) => {
  const handler = await guardHandler();
  if (!handler) return t.skip("this Node cannot load TypeScript");
  for (const toolName of ["read", "grep", "find", "ls"]) {
    const calls = [];
    assert.equal(await handler({ toolName, input: { path: "a" } }, uiContext("Allow once", calls)), undefined);
    assert.equal(calls.length, 0, `${toolName} never asks`);
  }
  const cases = [
    [{ toolName: "bash", input: { command: "npm   test\r\n--silent" } }, "Run command: npm   test\n--silent"],
    [{ toolName: "write", input: { path: "src/main.rs" } }, "Write file: src/main.rs"],
    [{ toolName: "edit", input: { path: "src/lib.rs" } }, "Edit file: src/lib.rs"],
    [{ toolName: "powershell", input: { command: "Get-Item 'first file'\r\nGet-Item 'second file'" } }, "Run command: Get-Item 'first file'\nGet-Item 'second file'"],
    [{ toolName: "nano_powershell", input: { command: "Get-ChildItem" } }, "Run command: Get-ChildItem"],
    [{ toolName: "another-tool", input: { command: "ls" } }, "Run tool: another-tool"],
  ];
  for (const [event, title] of cases) {
    const calls = [];
    assert.equal(await handler(event, uiContext("Allow once", calls)), undefined);
    assert.deepEqual(calls, [{ title, options: ["Allow once", "Deny"] }]);
  }
});

test("the Nano guard blocks on Deny, a cancelled dialog, a failed dialog and a session without a UI", async (t) => {
  const handler = await guardHandler();
  if (!handler) return t.skip("this Node cannot load TypeScript");
  const bash = { toolName: "bash", input: { command: "rm -rf build" } };
  assert.deepEqual(await handler(bash, uiContext("Deny")), { block: true, reason: "Denied by the user." });
  for (const answer of [undefined, "", "allow once", "Allow"]) {
    const result = await handler(bash, uiContext(answer));
    assert.equal(result?.block, true, `answer ${JSON.stringify(answer)} blocks`);
  }
  assert.equal((await handler(bash, uiContext(() => { throw new Error("dialog failed"); })))?.block, true);
  assert.equal((await handler(bash, { hasUI: false, ui: { select: async () => "Allow once" } }))?.block, true);
  assert.equal((await handler(bash, { ui: { select: async () => "Allow once" } }))?.block, true);
});

test("the Nano guard shows the whole command, escapes hidden characters and blocks what it cannot show", async (t) => {
  const handler = await guardHandler();
  if (!handler) return t.skip("this Node cannot load TypeScript");
  // A line break after a comment stays a line break: the second command is visible.
  const calls = [];
  await handler({ toolName: "bash", input: { command: "echo safe # comment\nrm -rf important" } }, uiContext("Allow once", calls));
  assert.equal(calls[0].title, "Run command: echo safe # comment\nrm -rf important");
  // Bidi overrides, zero-width characters, separators and lone carriage returns are escaped.
  const hidden = [];
  await handler({ toolName: "bash", input: { command: "ls\u202Etxt.exe\u200B\u2028a\rb" } }, uiContext("Allow once", hidden));
  assert.equal(hidden[0].title, "Run command: ls\\u{202E}txt.exe\\u{200B}\\u{2028}a\\u{D}b");
  // Nothing is shortened: a call too long to show is blocked without asking.
  const long = [];
  const result = await handler({ toolName: "bash", input: { command: `${"x".repeat(3998)}\u{1F600}${"y".repeat(10)}` } }, uiContext("Allow once", long));
  assert.equal(result?.block, true);
  assert.match(result.reason, /too long to show/);
  assert.equal(long.length, 0);
  const fits = [];
  await handler({ toolName: "write", input: { path: "a".repeat(4000) } }, uiContext("Allow once", fits));
  assert.equal(fits[0].title, `Write file: ${"a".repeat(4000)}`);
  const empty = [];
  await handler({ toolName: "write", input: {} }, uiContext("Allow once", empty));
  assert.equal(empty[0].title, "Write file: (empty)");
});

test("a guard-style select dialog reaches the host as an approval card and a cancel answers Pi", async () => {
  // The fixture sends the kind of select request the guard makes.
  const events = [];
  const adapter = await createPiAdapter(nanoConfig(), (event) => events.push(event));
  try {
    await adapter.prompt({ text: "select", mode: "prompt" });
    const approval = await waitFor(() => events.find((event) => event.type === "approval")?.approval);
    assert.equal(approval.title, "Allow dangerous command?", "the command's native title reaches the approval card");
    assert.deepEqual(approval.options.map((option) => option.label), ["Allow", "Block", "Line one line two"]);
    assert.deepEqual(approval.decisions, ["approve-once", "cancel"]);
    await adapter.respond({ requestId: approval.id, decision: "cancel" });
    assert.equal((await adapter.snapshot()).title, "ui:cancelled", "a cancelled dialog is a refusal the guard blocks on");
  } finally { await adapter.dispose(); }
});
