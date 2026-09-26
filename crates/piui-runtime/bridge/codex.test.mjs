import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { isAbsolute, toNamespacedPath } from "node:path";
import test from "node:test";
import { createCodexAdapter } from "./codex.mjs";

const fixture = fileURLToPath(new URL("./codex.test-fixture.mjs", import.meta.url));
const config = {
  harness: "codex",
  cwd: process.cwd(),
  sessionDir: process.cwd(),
  permissionMode: "native",
  runtimeProgram: process.execPath,
  runtimeArgs: [fixture],
  daemonSocket: "fixture-reserved-endpoint",
};

test("composer commands use native compaction and steer without inventing a queued native turn", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn"] }, () => {});
  try {
    assert.deepEqual(await adapter.composerCapabilities(), { steer: true, compact: true, images: true });
    await adapter.compact();
    await waitFor(() => adapter.snapshot().blocks.some(block => block.kind === "compaction") && adapter.snapshot().status === "idle");
    await adapter.prompt({ text: "first", mode: "prompt" });
    await assert.rejects(adapter.compact(), { bridgeCode: "turn-active" });
    await assert.rejects(adapter.prompt({ text: "queued by host only", mode: "follow-up" }), { bridgeCode: "turn-active" });
    assert.deepEqual(await adapter.prompt({ text: "clarify this turn", mode: "steer" }), { accepted: true });
  } finally { await adapter.dispose(); }
});

test("accepts the Windows canonical project path returned by the host", { skip: process.platform !== "win32" }, async () => {
  const adapter = await createCodexAdapter({ ...config, cwd: toNamespacedPath(process.cwd()), runtimeArgs: [fixture, "--plain-cwd"] }, () => {});
  try { assert.equal(adapter.snapshot().status, "idle"); assert.equal((await adapter.catalogModels())[0].supportsFast, true); }
  finally { await adapter.dispose(); }
});

test("still rejects a native thread opened in another workspace", async () => {
  await assert.rejects(createCodexAdapter({ ...config, runtimeArgs: [fixture, "--wrong-cwd"] }, () => {}), { bridgeCode: "native-cwd-mismatch" });
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture condition timed out");
}

test("handshakes, streams blocks, lists models, and keeps native auth storage", async () => {
  const events = [];
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "native-user-home-fixture";
  const adapter = await createCodexAdapter(config, (event) => events.push(event));
  try {
    const initial = adapter.snapshot();
    assert.equal(initial.nativeId, "thread-fixture");
    assert.equal(initial.status, "idle");
    assert.equal(initial.capabilities.toolPolicy.supported, false);
    assert.equal(process.env.CODEX_HOME, "native-user-home-fixture");
    assert.equal(initial.materialized, false, "zero-turn start must remain an unpersisted draft");
    assert.ok(events.some((event) => event.type === "binding" && event.nativeId === "thread-fixture"));

    const models = await adapter.models();
    assert.deepEqual(models, [{ id: "fixture-model", provider: "openai", name: "Fixture Model", thinkingLevels: ["low"] }]);
    const resources = await adapter.resources();
    assert.deepEqual(resources.items, [
      { kind: "skill", id: "/skills/review/SKILL.md", name: "Review", enabled: false, configurable: true },
      { kind: "mcp", id: "docs", name: "docs", enabled: true, configurable: true },
      { kind: "tool", id: "search_docs", name: "Search docs", enabled: true, configurable: false },
    ]);
    assert.deepEqual(resources.warnings, []);
    assert.ok(!JSON.stringify(resources).includes("SECRET-MUST-NOT-LEAK"));
    assert.deepEqual(await adapter.prompt({ text: "fixture prompt", mode: "prompt" }), { accepted: true });
    assert.equal(adapter.snapshot().materialized, true);
    await waitFor(() => adapter.snapshot().status === "idle" && adapter.snapshot().blocks.some((block) => block.text === "hello"));
    assert.ok(events.some((event) => event.type === "textDelta" && event.text === "hello"));
    assert.deepEqual(events.find(event => event.type === "usage")?.usage, {id:"codex-session-total",inputTokens:10,outputTokens:4,cacheReadTokens:2,totalTokens:14});
    assert.ok(events.some((event) => event.type === "binding" && event.nativeId === "thread-fixture"));
    assert.deepEqual(await adapter.prompt({ text: "second fixture prompt", mode: "follow-up" }), { accepted: true });
  } finally {
    await adapter.dispose();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }
});

test("round-trips current approvals once and rejects unsupported mandatory requests", async () => {
  const events = [];
  const adapter = await createCodexAdapter(config, (event) => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().approvals.length === 2);
    const approvals = adapter.snapshot().approvals;
    const command = approvals.find((approval) => approval.kind === "command");
    const file = approvals.find((approval) => approval.kind === "file-change");
    assert.ok(command);
    assert.ok(file);
    assert.match(command.description, /Command: fixture command/);
    assert.match(command.description, /Network destination: https:\/\/example\.invalid/);
    assert.match(command.description, /Filesystem write: \/workspace\/out/);
    assert.match(file.description, /\/workspace\/file\.txt/);
    assert.match(file.description, /\+updated/);
    assert.doesNotMatch(file.description, /\+fixture/);
    const duplicateResults = await Promise.allSettled([
      adapter.respond({ requestId: command.id, decision: "approve-once" }),
      adapter.respond({ requestId: command.id, decision: "approve-once" }),
    ]);
    assert.deepEqual(duplicateResults.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(duplicateResults.find((result) => result.status === "rejected").reason.bridgeCode, "stale-approval");
    await waitFor(() => adapter.snapshot().title === "command:accept");
    await adapter.respond({ requestId: file.id, decision: "cancel" });
    await waitFor(() => adapter.snapshot().title === "file:cancel");
    assert.equal(adapter.snapshot().approvals.length, 0);
    assert.ok(events.some((event) => event.type === "error" && /unsupported host operation/.test(event.message)));
  } finally {
    await adapter.dispose();
  }
});

test("keeps descendant events out of the root transcript and cancels child approvals", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--child-events"] }, (event) => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().title === "child:cancelled");
    assert.equal(adapter.snapshot().nativeId, "thread-fixture");
    assert.equal(adapter.snapshot().blocks.some((block) => block.id === "child-item"), false);
    assert.equal(events.some((event) => event.type === "binding" && event.nativeId === "child-thread"), false);
    assert.equal(events.some((event) => event.type === "turnCompleted"), false);
    assert.equal(adapter.snapshot().approvals.some((approval) => /child/i.test(approval.description)), false);
  } finally {
    await adapter.dispose();
  }
});

test("renders one safe user-input question and declines unsupported structured input", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--user-input"] }, (event) => events.push(event));
  try {
    const inputApproval = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.kind === "input"));
    assert.match(inputApproval.description, /Question: Choose mode/);
    assert.match(inputApproval.description, /Which mode should Codex use\?/);
    assert.match(inputApproval.description, /Option: Safe — Use safe mode/);
    assert.equal(adapter.snapshot().approvals.filter((approval) => approval.kind === "input").length, 1);
    await waitFor(() => events.some((event) => event.type === "error" && /unsupported structured or secret input/.test(event.message)));
    assert.equal(events.some((event) => event.type === "warning"), false);
    await assert.rejects(
      adapter.respond({ requestId: inputApproval.id, decision: "approve-once" }),
      (error) => error.bridgeCode === "input-required",
    );
    assert.ok(adapter.snapshot().approvals.some((approval) => approval.id === inputApproval.id));
    await adapter.respond({ requestId: inputApproval.id, decision: "approve-once", text: "Safe" });
    assert.equal(adapter.snapshot().approvals.some((approval) => approval.id === inputApproval.id), false);
  } finally {
    await adapter.dispose();
  }
});

test("renders web search items as safe tool activity and keeps other unknown types on fallback", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--unknown-items"] }, () => {});
  try {
    await waitFor(() => adapter.snapshot().blocks.some((block) => block.id === "web-search-item"));
    const command = adapter.snapshot().blocks.find((block) => block.id === "command-display");
    assert.match(command.text, /Command: display command/);
    assert.match(command.text, /Working directory:/);
    const webSearch = adapter.snapshot().blocks.find((block) => block.id === "web-search-item");
    assert.equal(webSearch.kind, "tool");
    assert.equal(webSearch.label, "Web search");
    assert.equal(webSearch.toolName, "web-search");
    assert.equal(webSearch.fallback, undefined);
    assert.match(webSearch.text, /Query: latest fixture news/);
    assert.match(webSearch.text, /Action: search/);
    assert.match(webSearch.text, /Results: 1/);
    assert.doesNotMatch(webSearch.text, /SECRET-MUST-NOT-LEAK/);
    // Item types without a dedicated projection (including 0.153's
    // functionCallOutput) stay readable through the generic fallback.
    for (const type of ["collabAgentToolCall", "imageView", "imageGeneration", "sleep", "subAgentActivity", "hookPrompt", "functionCallOutput"]) {
      const block = adapter.snapshot().blocks.find((value) => value.id === `unsupported-${type}`);
      assert.equal(block.kind, "unknown");
      assert.equal(block.fallback, true);
      assert.match(block.safeSummary, new RegExp(type));
    }
  } finally {
    await adapter.dispose();
  }
});

test("maps MCP and dynamic tool calls to bounded tool blocks", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--tool-items"] }, (event) => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().blocks.some((block) => block.id === "dynamic-denied"));
    const block = (id) => adapter.snapshot().blocks.find((value) => value.id === id);
    const started = (id) => events.find((event) => event.type === "block" && event.block.id === id).block;

    assert.equal(started("mcp-item").status, "streaming");
    assert.ok(events.some((event) => event.type === "textDelta" && event.blockId === "mcp-item" && event.text === "\nSearching"));
    const mcp = block("mcp-item");
    assert.deepEqual(
      [mcp.kind, mcp.label, mcp.title, mcp.toolName, mcp.status, mcp.fallback],
      ["tool", "MCP tool", "docs.search_docs", "search_docs", "complete", undefined],
    );
    assert.equal(mcp.text, "Arguments: query: fixture, limit: 3, filters: {…}\nfound 3 docs\n[image]");
    assert.equal(mcp.truncated, false);

    const failed = block("mcp-failed");
    assert.equal(failed.status, "failed");
    assert.match(failed.text, /\nError: docs server unavailable$/);

    assert.equal(started("dynamic-item").status, "streaming");
    const dynamic = block("dynamic-item");
    assert.deepEqual([dynamic.kind, dynamic.label, dynamic.title, dynamic.status], ["tool", "Tool", "workspace.spawn_agent", "complete"]);
    assert.ok(dynamic.text.startsWith("Arguments: profileId: reviewer, name: Helper, instructions: Review the change\n"));
    assert.equal(dynamic.truncated, true);
    assert.match(dynamic.text, /\n… \d+ characters omitted …\n/);
    assert.ok(dynamic.text.endsWith("\n[image]"));
    assert.ok(dynamic.text.length <= 16 * 1024 + 64);

    const denied = block("dynamic-denied");
    assert.deepEqual([denied.title, denied.status], ["send", "failed"]);
    assert.doesNotMatch(JSON.stringify(events), /SECRET-MUST-NOT-LEAK/);
  } finally {
    await adapter.dispose();
  }
});

test("fails and settles startup on malformed native protocol envelopes", async () => {
  for (const kind of ["syntax", "null", "missing-envelope"]) {
    const events = [];
    await assert.rejects(
      createCodexAdapter({ ...config, runtimeArgs: [fixture, `--bad-frame=${kind}`] }, (event) => events.push(event)),
      (error) => error.bridgeCode === "native-operation-failed",
    );
    assert.ok(events.some((event) => event.type === "error" && /protocol/.test(event.message)));
  }
});

test("registers strict workspace tools only for managed runs and origin-binds calls", async () => {
  const operations = [];
  const adapter = await createCodexAdapter({
    ...config,
    coordination: true,
    runtimeArgs: [fixture, "--coordinator"],
  }, () => {}, async (operation, context) => {
    operations.push({ operation, toolCallId: context.toolCallId, hasSignal: context.signal instanceof AbortSignal });
    return { members: ["member-fixture"] };
  });
  try {
    await waitFor(() => adapter.snapshot().title === "coordinator:ok");
    assert.deepEqual(operations, [{ operation: { type: "roster" }, toolCallId: "call-roster", hasSignal: true }]);
    assert.equal(adapter.snapshot().capabilities.nativeSubagents.enforcement, "coordinator");
  } finally {
    await adapter.dispose();
  }
  await assert.rejects(
    createCodexAdapter({ ...config, coordination: true, nativeId: "resume-managed" }, () => {}, async () => ({})),
    (error) => error.bridgeCode === "unsupported-coordinator-resume",
  );
  await assert.rejects(
    createCodexAdapter({ ...config, coordination: true, nativeSubagents: true }, () => {}, async () => ({})),
    (error) => error.bridgeCode === "unsupported-managed-native-subagents",
  );
});

test("maps each explicit permission mode and resumes without start-only fields", async () => {
  for (const permissionMode of ["native", "read-only", "workspace-write", "full-access"]) {
    const adapter = await createCodexAdapter({
      ...config,
      permissionMode,
      runtimeArgs: [fixture, "--expect-permission", permissionMode],
      ...(permissionMode === "read-only" ? { nativeId: "resume-fixture" } : {}),
    }, () => {});
    try {
      assert.equal(adapter.snapshot().nativeId, permissionMode === "read-only" ? "resume-fixture" : "thread-fixture");
      assert.equal(adapter.snapshot().materialized, permissionMode === "read-only");
      if (permissionMode === "read-only" || permissionMode === "workspace-write") {
        for (const approval of adapter.snapshot().approvals) assert.deepEqual(approval.decisions, ["deny", "cancel"]);
      }
    } finally {
      await adapter.dispose();
    }
  }
  const resumed = await createCodexAdapter({
    ...config,
    nativeId: "active-thread",
    runtimeArgs: [fixture, "--active-resume"],
  }, () => {});
  try {
    assert.equal(resumed.snapshot().status, "running");
    assert.deepEqual(await resumed.interrupt(), { interrupted: true });
    await assert.rejects(
      resumed.setModel({ model: { id: "other-model", provider: "other", name: "Other" } }),
      (error) => error.bridgeCode === "unsupported-provider-change",
    );
  } finally {
    await resumed.dispose();
  }
  await assert.rejects(
    createCodexAdapter({ ...config, permissionMode: "workspace-write", runtimeArgs: [fixture, "--expect-permission", "workspace-write", "--effective-permission-mismatch"] }, () => {}),
    (error) => error.bridgeCode === "unsupported-permission-mode",
  );
  const systemError = await createCodexAdapter({ ...config, nativeId: "failed-thread", runtimeArgs: [fixture, "--system-error"] }, () => {});
  try {
    assert.equal(systemError.snapshot().status, "failed");
    await assert.rejects(
      systemError.prompt({ text: "must not run", mode: "prompt" }),
      (error) => error.bridgeCode === "native-not-ready",
    );
  } finally {
    await systemError.dispose();
  }
});

test("reserves prompt admission before awaiting native turn start", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn"] }, () => {});
  try {
    const results = await Promise.allSettled([
      adapter.prompt({ text: "first", mode: "prompt" }),
      adapter.prompt({ text: "second", mode: "prompt" }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(results.find((result) => result.status === "rejected").reason.bridgeCode, "turn-active");
  } finally {
    await adapter.dispose();
  }
});

test("queues interrupt while native turn admission is pending", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn"] }, (event) => events.push(event));
  try {
    const admission = adapter.prompt({ text: "interrupt admission", mode: "prompt" });
    assert.deepEqual(await adapter.interrupt(), { interrupted: true });
    await admission;
    await waitFor(() => events.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "interrupted" }]);
  } finally {
    await adapter.dispose();
  }
});

test("emits explicit terminal outcomes and never treats failed or interrupted turns as success", async () => {
  const failedEvents = [];
  const failed = await createCodexAdapter(config, (event) => failedEvents.push(event));
  try {
    await failed.prompt({ text: "fail fixture", mode: "prompt" });
    await waitFor(() => failedEvents.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(failedEvents.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "failed" }]);
    assert.ok(failedEvents.some((event) => event.type === "error" && event.message === "Codex authentication is unavailable."));
    assert.equal(JSON.stringify(failedEvents).includes("raw fixture"), false);
    assert.equal(failed.snapshot().status, "idle");
  } finally {
    await failed.dispose();
  }

  const interruptedEvents = [];
  const interrupted = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn"] }, (event) => interruptedEvents.push(event));
  try {
    await interrupted.prompt({ text: "hold fixture", mode: "prompt" });
    await interrupted.interrupt();
    await waitFor(() => interruptedEvents.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(interruptedEvents.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "interrupted" }]);
  } finally {
    await interrupted.dispose();
  }
});

test("dispose rejects pending native calls and clears unresolved approvals", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-model"] }, () => {});
  const pendingModels = adapter.models();
  await adapter.dispose();
  await assert.rejects(pendingModels, (error) => error.bridgeCode === "native-operation-failed");
  assert.equal(adapter.snapshot().approvals.length, 0);
  assert.equal(adapter.snapshot().status, "closed");
});

test("fails closed for unsupported mandatory policy", async () => {
  await assert.rejects(
    createCodexAdapter({ ...config, allowedTools: ["read"] }, () => {}),
    (error) => error.bridgeCode === "unsupported-tool-policy",
  );
  await assert.rejects(
    createCodexAdapter({ ...config, allowedTools: [] }, () => {}),
    (error) => error.bridgeCode === "unsupported-tool-policy",
  );
  await assert.rejects(
    createCodexAdapter({ ...config, nativeSubagents: true }, () => {}),
    (error) => error.bridgeCode === "unsupported-native-subagent-policy",
  );
  await assert.rejects(
    createCodexAdapter({ ...config, permissionMode: "strict-magic" }, () => {}),
    (error) => error.bridgeCode === "unsupported-permission-mode",
  );
  await assert.rejects(
    createCodexAdapter({ ...config, runtimeProgram: "piui-definitely-missing-codex" }, () => {}),
    (error) => error.bridgeCode === "native-unavailable",
  );
});

test("admits app-server versions only inside the verified range", async () => {
  // Audited protocols (0.147.0, 0.153.4, 0.157.1) and releases between them.
  for (const version of ["0.147.0", "0.148.0", "0.153.4", "0.157.1", "0.157.1-alpha", "0.157.9"]) {
    const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, `--codex-version=${version}`] }, () => {});
    try { assert.equal(adapter.snapshot().status, "idle", version); }
    finally { await adapter.dispose(); }
  }
  const rejected = [
    // Older than the minimum; a pre-release precedes its release.
    ["0.146.9", /requires a verified Codex/],
    ["0.147.0-alpha.1", /requires a verified Codex/],
    // Newer than tested, including previews of the untested release line.
    ["0.158.0", /newer than the versions tested/],
    ["0.158.0-alpha.2", /newer than the versions tested/],
    ["0.159.0-alpha.4", /newer than the versions tested/],
    ["1.0.0", /newer than the versions tested/],
    // Only the leading product token names Codex: the trailing client version
    // `(piui; 0.2.0)` never stands in for an unrecognized Codex version.
    ["latest", /requires a verified Codex/],
  ];
  for (const [version, message] of rejected) {
    const events = [];
    await assert.rejects(
      createCodexAdapter({ ...config, runtimeArgs: [fixture, `--codex-version=${version}`] }, (event) => events.push(event)),
      (error) => error.bridgeCode === "unsupported-native-version" && message.test(error.safeMessage),
      version,
    );
    assert.equal(events.some((event) => event.type === "binding"), false, version);
  }
  await assert.rejects(
    createCodexAdapter({ ...config, runtimeArgs: [fixture, "--raw-user-agent"] }, () => {}),
    (error) => error.bridgeCode === "unsupported-native-version",
  );
});

for (const [mode, tier] of [["standard", "default"], ["fast", "fast"]]) {
  test(`forwards ${mode}, reasoning and per-thread resources without global changes`, async () => {
    const adapter = await createCodexAdapter({ ...config, serviceTier: mode, thinkingLevel: "low", resourceRules: [
      { kind: "mcp", id: "example", enabled: false },
      { kind: "skill", id: fileURLToPath(new URL("./SKILL.md", import.meta.url)), enabled: false },
    ], runtimeArgs: [fixture, "--expect-settings", JSON.stringify({ tier })] }, () => {});
    try { assert.deepEqual(await adapter.prompt({ text: "fixture", mode: "prompt" }), { accepted: true }); }
    finally { await adapter.dispose(); }
  });
}

test("MCP startup failures stay with resource status instead of becoming session errors", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-startup"] }, event => events.push(event));
  try {
    assert.equal(adapter.snapshot().blocks.some(block => block.safeSummary?.includes("startupStatus")), false);
    assert.equal(events.filter(event => event.type === "error" && event.message.includes("MCP")).length, 0);
    const resources = await adapter.resources();
    assert.deepEqual(resources.warnings, ["MCP server fixture could not start."]);
    assert.equal(JSON.stringify(events).includes("PRIVATE_MCP_DETAIL"), false);
  } finally { await adapter.dispose(); }
});

test("forwards explicit network access through the Codex workspace sandbox", async () => {
  const adapter = await createCodexAdapter({
    ...config,
    permissionMode: "workspace-write",
    networkAccess: true,
    runtimeArgs: [fixture, "--expect-permission", "workspace-write", "--expect-network"],
  }, () => {});
  try {
    assert.deepEqual(await adapter.prompt({ text: "network prefilter", mode: "prompt" }), { accepted: true });
  } finally {
    await adapter.dispose();
  }
});

test("MCP recovery clears its resource warning", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-recovery"] }, event => events.push(event));
  try {
    // Only MCP errors matter here: the fixture's unsupported attestation request
    // may or may not have produced its own error by this point.
    assert.equal(events.some(event => event.type === "error" && /MCP/.test(event.message)), false);
    assert.equal((await adapter.resources()).warnings.some(warning => warning.includes("fixture")), false);
  } finally { await adapter.dispose(); }
});
test("ordinary Codex settings change Fast and reasoning without transcript noise", async () => {
  const adapter = await createCodexAdapter(config, () => {});
  try {
    const [model] = await adapter.models();
    await adapter.setModel({ model, thinkingLevel: "low", serviceTier: "fast" });
    assert.equal(adapter.snapshot().thinkingLevel, "low");
    assert.equal(adapter.snapshot().serviceTier, "fast");
    await adapter.setModel({ model, thinkingLevel: "low", serviceTier: "standard" });
    assert.equal(adapter.snapshot().serviceTier, "standard");
    await assert.rejects(adapter.setModel({ model, thinkingLevel: "invented", serviceTier: "fast" }));
    assert.equal(adapter.snapshot().serviceTier, "standard");
    assert.equal(adapter.snapshot().blocks.some(block => block.safeSummary?.includes("settings/updated")), false);
  } finally { await adapter.dispose(); }
});

test("retains the native current model and reasoning metadata when hidden from discovery", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, '--codex-version=0.153.4', '--hidden-current-model'] }, () => {});
  try { assert.deepEqual(await adapter.models(), [{ id: 'fixture-model', provider: 'openai', name: 'Hidden current', thinkingLevels: ['low', 'ultra'] }]); }
  finally { await adapter.dispose(); }
});

test("keeps an absent native current model visible without inventing reasoning support", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, '--missing-current-model'] }, () => {});
  try { assert.deepEqual(await adapter.models(), [{ id: 'fixture-model', provider: 'openai', name: 'fixture-model', thinkingLevels: [] }]); }
  finally { await adapter.dispose(); }
});

test('account quota updates stay out of the transcript without hiding unknown conversation events', async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, '--rate-limits'] }, event => events.push(event));
  try {
    await adapter.models();
    assert.ok(!JSON.stringify(events).includes('account/rateLimits/updated'));
    assert.ok(!JSON.stringify(adapter.snapshot().blocks).includes('account/rateLimits/updated'));
    assert.ok(adapter.snapshot().blocks.some(block => block.safeSummary === 'Unsupported Codex event: future/conversation/event'));
  } finally { await adapter.dispose(); }
});

for (const version of ["0.147.0", "0.153.4", "0.157.1"]) {
  test(`keeps the session flow and settings in sync on the ${version} protocol`, async () => {
    const events = [];
    const adapter = await createCodexAdapter({
      ...config,
      runtimeArgs: [fixture, `--codex-version=${version}`, "--external-settings", "--mcp-startup"],
    }, (event) => events.push(event));
    try {
      await waitFor(() => adapter.snapshot().approvals.length === 2);
      const command = adapter.snapshot().approvals.find((approval) => approval.kind === "command");
      assert.equal(command.title, "Run command");
      await adapter.respond({ requestId: command.id, decision: "approve-once" });
      await waitFor(() => adapter.snapshot().title === "command:accept");
      assert.deepEqual((await adapter.resources()).warnings, ["MCP server fixture could not start."]);
      assert.deepEqual(await adapter.prompt({ text: "fixture prompt", mode: "prompt" }), { accepted: true });
      await waitFor(() => events.some((event) => event.type === "turnCompleted"));
      // Another client changed the thread settings; the snapshot follows the
      // nested `threadSettings` (with `effort`) that every version sends.
      const snapshot = adapter.snapshot();
      assert.deepEqual(snapshot.model, { id: "fixture-model-2", provider: "openai", name: "fixture-model-2" });
      assert.equal(snapshot.thinkingLevel, "high");
      assert.equal(snapshot.serviceTier, "fast");
      // Only the fixture's generic `warning` stays on the fallback path.
      assert.deepEqual(snapshot.blocks.filter((block) => block.fallback).map((block) => block.safeSummary), ["Unsupported Codex event: warning"]);
      assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
    } finally { await adapter.dispose(); }
  });
}

test("configuration and deprecation warnings become fixed resource warnings", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--config-warning", "--deprecation-notice"] }, (event) => events.push(event));
  try {
    assert.equal(adapter.snapshot().blocks.some((block) => /configWarning|deprecationNotice/.test(block.safeSummary ?? "")), false);
    assert.deepEqual((await adapter.resources()).warnings, [
      "Codex reported a configuration warning. Review your Codex config.toml.",
      "Codex reported a deprecated setting or feature. Review your Codex configuration.",
    ]);
    const visible = JSON.stringify({ events, snapshot: adapter.snapshot(), resources: await adapter.resources() });
    assert.doesNotMatch(visible, /PRIVATE_CONFIG|PRIVATE_DEPRECATION/);
    // The fixture's unsupported attestation request is the only session error.
    assert.deepEqual(events.filter((event) => event.type === "error").map((event) => event.message), ["Codex requested an unsupported host operation."]);
  } finally { await adapter.dispose(); }
});

test("presents a write-stdin approval as terminal input, not a new command", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--write-stdin"] }, () => {});
  try {
    const stdin = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.title === "Send input to a running command"));
    assert.equal(stdin.kind, "command");
    assert.match(stdin.description, /^Terminal input: write_stdin --session-id 7 'y'$/m);
    assert.doesNotMatch(stdin.description, /^Command:/m);
    assert.deepEqual(stdin.decisions, ["approve-once", "cancel"]);
    await adapter.respond({ requestId: stdin.id, decision: "approve-once" });
    await waitFor(() => adapter.snapshot().title === "stdin:accept");
    assert.equal(adapter.snapshot().approvals.find((approval) => approval.kind === "command").title, "Run command");
  } finally { await adapter.dispose(); }
});

test("grants a requested permission profile for the session only when approved", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--permissions-request"] }, () => {});
  try {
    const request = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.kind === "permission"));
    assert.equal(request.title, "Grant permissions");
    assert.match(request.description, /Additional network access requested/);
    await adapter.respond({ requestId: request.id, decision: "approve-session" });
    await waitFor(() => adapter.snapshot().title === "permissions:session");
  } finally { await adapter.dispose(); }
});

test("answers the current-time request for the thread and its descendants", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--current-time"] }, (event) => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().title.startsWith("time:"));
    assert.equal(adapter.snapshot().title, "time:ok,ok");
    assert.equal(events.some((event) => event.type === "error" && /unsupported host operation/.test(event.message)), true, "attestation stays unsupported");
    assert.equal(events.filter((event) => event.type === "error").length, 1);
  } finally { await adapter.dispose(); }
});

test("maps the 0.153+ rate-limit and policy turn errors to fixed summaries", async () => {
  for (const [text, message] of [
    ["rate limit fixture", "A Codex usage limit prevents this turn."],
    ["policy fixture", "Codex blocked this turn under provider policy."],
  ]) {
    const events = [];
    const adapter = await createCodexAdapter(config, (event) => events.push(event));
    try {
      await adapter.prompt({ text, mode: "prompt" });
      await waitFor(() => events.some((event) => event.type === "turnCompleted"));
      assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "failed" }]);
      assert.ok(events.some((event) => event.type === "error" && event.message === message), text);
      assert.equal(JSON.stringify(events).includes("raw fixture"), false);
    } finally { await adapter.dispose(); }
  }
});

test("a cancelled MCP startup clears its earlier failure warning", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-cancelled"] }, () => {});
  try { assert.deepEqual((await adapter.resources()).warnings, []); }
  finally { await adapter.dispose(); }
});

// MCP elicitations. The fixture echoes every client reply to request <id> as
// the text of agent message `reply-<id>`.
const elicitationReply = (adapter, id) => {
  const block = adapter.snapshot().blocks.find((value) => value.id === `reply-${id}`);
  return block ? JSON.parse(block.text) : undefined;
};
const formApproval = (adapter) => adapter.snapshot().approvals.find((approval) => approval.form && approval.title === "MCP server request");
const toolApproval = (adapter) => adapter.snapshot().approvals.find((approval) => approval.title === "Allow an MCP tool");

test("shows an MCP form request with typed opaque fields and accepts with the exact native content", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation"] }, () => {});
  try {
    const request = await waitFor(() => formApproval(adapter));
    assert.equal(request.kind, "input");
    assert.equal(request.description, "Create an issue in the docs tracker?");
    assert.deepEqual(request.decisions, ["approve-once", "deny", "cancel"]);
    assert.equal(request.form.server, "docs");
    assert.equal(request.form.limitation, undefined);
    assert.deepEqual(request.form.fields, [
      { type: "text", id: "field-1", label: "Title", required: true, minLength: 3, maxLength: 40 },
      { type: "choice", id: "field-2", label: "Priority", required: true, default: "choice-2", options: [{ id: "choice-1", label: "Urgent" }, { id: "choice-2", label: "Normal" }] },
      { type: "number", id: "field-3", label: "Copies", required: false, integer: true, minimum: 1, maximum: 5 },
      { type: "boolean", id: "field-4", label: "Notify the team", required: false, default: false },
      { type: "text", id: "field-5", label: "contact", description: "Who to ask", required: false, format: "email" },
      { type: "text", id: "field-6", label: "Prototype key", required: false },
    ]);
    // Native property names and choice values stay in the adapter.
    assert.doesNotMatch(JSON.stringify(request), /"p1"|"p2"|"priority"|"notify"/);

    const valid = { "field-1": "Broken link", "field-2": "choice-1", "field-3": 2, "field-4": true, "field-6": "kept as a key" };
    for (const [answer, why] of [
      [undefined, "no answer"],
      ["not json", "malformed JSON"],
      [JSON.stringify([valid]), "not an object"],
      [JSON.stringify({ ...valid, "field-1": undefined }), "missing required text"],
      [JSON.stringify({ ...valid, "field-1": "ab" }), "shorter than minLength"],
      [JSON.stringify({ ...valid, "field-1": "x".repeat(41) }), "longer than maxLength"],
      [JSON.stringify({ ...valid, "field-2": "p1" }), "a native value instead of an option id"],
      [JSON.stringify({ ...valid, "field-3": 7 }), "above maximum"],
      [JSON.stringify({ ...valid, "field-3": 1.5 }), "not an integer"],
      [JSON.stringify({ ...valid, "field-3": "2" }), "number as text"],
      [JSON.stringify({ ...valid, "field-4": "yes" }), "boolean as text"],
      [JSON.stringify({ ...valid, "field-5": "not-an-email" }), "invalid email"],
      [JSON.stringify({ ...valid, title: "Broken link" }), "a native name instead of a field id"],
    ]) {
      await assert.rejects(adapter.respond({ requestId: request.id, decision: "approve-once", text: answer }), { bridgeCode: "invalid-response" }, why);
      assert.ok(formApproval(adapter), `${why}: the request stays pending`);
    }
    await adapter.respond({ requestId: request.id, decision: "approve-once", text: JSON.stringify(valid) });
    assert.equal(formApproval(adapter), undefined);
    const reply = await waitFor(() => elicitationReply(adapter, 960));
    assert.deepEqual(reply, {
      action: "accept",
      content: { title: "Broken link", priority: "p1", count: 2, notify: true, ["__proto__"]: "kept as a key" },
    });
    assert.ok(Object.hasOwn(reply.content, "__proto__"));
    await assert.rejects(adapter.respond({ requestId: request.id, decision: "deny" }), { bridgeCode: "stale-approval" });
  } finally {
    await adapter.dispose();
  }
});

test("shows an MCP tool approval with its server, tool and bounded arguments", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation"] }, () => {});
  try {
    const request = await waitFor(() => toolApproval(adapter));
    assert.equal(request.kind, "permission");
    assert.deepEqual(request.form, { server: "docs", fields: [] });
    assert.equal(request.description, 'Allow the docs MCP server to run tool "search_docs"?\nTool: Search docs\nArguments: query: fixture, filters: {…}');
    assert.doesNotMatch(JSON.stringify(adapter.snapshot()), /SECRET-MUST-NOT-LEAK/);
    assert.deepEqual(request.decisions, ["approve-once", "deny", "cancel"]);
    await assert.rejects(adapter.respond({ requestId: request.id, decision: "approve-once", text: '{"field-1":"x"}' }), { bridgeCode: "invalid-response" });
    await adapter.respond({ requestId: request.id, decision: "approve-once" });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 961)), { action: "accept", content: {} });
  } finally {
    await adapter.dispose();
  }
});

test("declines and dismisses MCP requests with the exact protocol actions", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation"] }, () => {});
  try {
    const form = await waitFor(() => formApproval(adapter));
    const tool = await waitFor(() => toolApproval(adapter));
    await adapter.respond({ requestId: form.id, decision: "deny" });
    await adapter.respond({ requestId: tool.id, decision: "cancel" });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 960)), { action: "decline", content: null });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 961)), { action: "cancel", content: null });
    assert.equal(adapter.snapshot().approvals.some((approval) => approval.form), false);
    await assert.rejects(adapter.respond({ requestId: form.id, decision: "approve-session" }), { bridgeCode: "stale-approval" });
  } finally {
    await adapter.dispose();
  }
});

test("restrictive permission modes can only decline an MCP tool approval", async () => {
  const adapter = await createCodexAdapter({
    ...config,
    permissionMode: "workspace-write",
    runtimeArgs: [fixture, "--expect-permission", "workspace-write", "--mcp-elicitation"],
  }, () => {});
  try {
    assert.deepEqual((await waitFor(() => toolApproval(adapter))).decisions, ["deny", "cancel"]);
    // Supplying requested values is not a permission grant.
    assert.deepEqual((await waitFor(() => formApproval(adapter))).decisions, ["approve-once", "deny", "cancel"]);
    await assert.rejects(adapter.respond({ requestId: toolApproval(adapter).id, decision: "approve-once" }), { bridgeCode: "unsupported-decision" });
  } finally {
    await adapter.dispose();
  }
});

test("declines MCP requests PiUI cannot show at once and never leaves them waiting", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation-edge"] }, (event) => events.push(event));
  try {
    for (const id of [962, 963, 964, 966, 971]) {
      assert.deepEqual(await waitFor(() => elicitationReply(adapter, id)), { action: "decline", content: null }, String(id));
    }
    // A descendant thread's request is dismissed like its approvals.
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 968)), { action: "cancel", content: null });
    const messages = events.filter((event) => event.type === "error").map((event) => event.message);
    assert.ok(messages.includes("An MCP server asked PiUI to open a web page. PiUI declined it; complete that step in Codex directly."));
    assert.ok(messages.includes("Codex asked for an approval that PiUI does not support, so it was declined."));
    assert.equal(messages.filter((message) => message === "Codex sent an MCP request that PiUI cannot show, so it was declined.").length, 3);
    // The requested web page and the descendant's request are never shown.
    assert.doesNotMatch(JSON.stringify(events), /example\.invalid\/oauth|Child request/);

    // A required value PiUI cannot show: only decline or dismiss.
    const unsupported = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.description === "Pick files"));
    assert.deepEqual(unsupported.decisions, ["deny", "cancel"]);
    assert.deepEqual(unsupported.form, { server: "docs", fields: [], limitation: "input-unsupported" });
    // A request without a mode is a form; an optional array stays empty.
    const legacy = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.description === "Which branch?"));
    assert.equal(legacy.form.limitation, "optional-fields-omitted");
    assert.deepEqual(legacy.form.fields, [
      { type: "choice", id: "field-1", label: "branch", required: false, options: [{ id: "choice-1", label: "Main line" }, { id: "choice-2", label: "Development" }] },
    ]);
    await adapter.respond({ requestId: legacy.id, decision: "approve-once", text: JSON.stringify({ "field-1": "choice-2" }) });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 967)), { action: "accept", content: { branch: "dev" } });
    assert.equal(elicitationReply(adapter, 965), undefined, "a pending request is not answered by itself");
    await adapter.respond({ requestId: unsupported.id, decision: "deny" });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 965)), { action: "decline", content: null });
  } finally {
    await adapter.dispose();
  }
});

test("a request resolved by Codex clears its card without a PiUI answer", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation-resolved"] }, (event) => events.push(event));
  try {
    const shown = await waitFor(() => events.find((event) => event.type === "approval" && event.approval.form)?.approval);
    await waitFor(() => events.some((event) => event.type === "approvalResolved" && event.requestId === shown.id));
    assert.equal(adapter.snapshot().approvals.some((approval) => approval.id === shown.id), false);
    await assert.rejects(adapter.respond({ requestId: shown.id, decision: "approve-once" }), { bridgeCode: "stale-approval" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(elicitationReply(adapter, 969), undefined);
  } finally {
    await adapter.dispose();
  }
});

test("interrupting a turn dismisses its pending MCP request", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn", "--mcp-elicitation-turn"] }, (event) => events.push(event));
  try {
    await adapter.prompt({ text: "search", mode: "prompt" });
    const request = await waitFor(() => adapter.snapshot().approvals.find((approval) => approval.form));
    assert.deepEqual(await adapter.interrupt(), { interrupted: true });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 970)), { action: "cancel", content: null });
    assert.ok(events.some((event) => event.type === "approvalResolved" && event.requestId === request.id));
    await waitFor(() => events.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "interrupted" }]);
    assert.equal(adapter.snapshot().approvals.length, 2, "only the fixture's command and file approvals remain");
  } finally {
    await adapter.dispose();
  }
});

test("a finished turn dismisses an MCP request that is still open", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--mcp-elicitation-turn"] }, () => {});
  try {
    await adapter.prompt({ text: "search", mode: "prompt" });
    assert.deepEqual(await waitFor(() => elicitationReply(adapter, 970)), { action: "cancel", content: null });
    assert.equal(adapter.snapshot().approvals.some((approval) => approval.form), false);
  } finally {
    await adapter.dispose();
  }
});

for (const version of ["0.147.0", "0.153.4", "0.157.1"]) {
  test(`answers MCP form requests on the ${version} protocol`, async () => {
    const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, `--codex-version=${version}`, "--mcp-elicitation"] }, () => {});
    try {
      const request = await waitFor(() => formApproval(adapter));
      await adapter.respond({ requestId: request.id, decision: "approve-once", text: JSON.stringify({ "field-1": "Fixture", "field-2": "choice-2" }) });
      assert.deepEqual(await waitFor(() => elicitationReply(adapter, 960)), { action: "accept", content: { title: "Fixture", priority: "p2" } });
    } finally {
      await adapter.dispose();
    }
  });
}

// Real evidence, never part of the default run: set PIUI_CODEX_LIVE_HANDSHAKE
// to the absolute path of the installed `@openai/codex/bin/codex.js`. Only
// `initialize` reaches the real app-server. The bridge writes `initialized`
// only after its version check passed; the probe records that, closes the
// app-server and refuses to forward anything else, so no thread or turn starts.
const liveEntry = process.env.PIUI_CODEX_LIVE_HANDSHAKE;
test("live: the installed Codex app-server passes the bridge handshake (initialize only)", {
  skip: liveEntry ? false : "set PIUI_CODEX_LIVE_HANDSHAKE to the installed bin/codex.js",
}, async (t) => {
  assert.ok(isAbsolute(liveEntry), "PIUI_CODEX_LIVE_HANDSHAKE must be an absolute path");
  const forwarded = [];
  let accepted = false;
  let product;
  let real;
  const openChild = (program, args, options) => {
    real = spawn(program, args, options);
    let buffered = "";
    real.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const response = buffered.split("\n").map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
        .find((message) => message?.id === "piui-1" && message.result);
      if (response && typeof response.result.userAgent === "string") product ??= response.result.userAgent.split(/\s+/, 1)[0];
    });
    // Killing only the Node launcher could orphan the native app-server on
    // Windows, so every close path ends its stdin and `exited` bounds the wait.
    const closeReal = () => {
      if (!real.stdin.destroyed && !real.stdin.writableEnded) real.stdin.end();
    };
    const stdin = new EventEmitter();
    stdin.writable = true;
    stdin.write = (frame, callback) => {
      const message = JSON.parse(frame);
      forwarded.push(message.method);
      if (message.method === "initialize") return real.stdin.write(frame, callback);
      if (message.method === "initialized") {
        accepted = true;
        stdin.writable = false;
        closeReal();
        callback?.();
        return true;
      }
      callback?.(new Error("the live probe forwards only initialize"));
      return false;
    };
    stdin.end = () => { stdin.writable = false; closeReal(); };
    stdin.destroy = stdin.end;
    const proxy = new EventEmitter();
    Object.assign(proxy, { stdin, stdout: real.stdout, stderr: real.stderr, kill: closeReal });
    real.once("error", (error) => proxy.emit("error", error));
    real.once("close", (...values) => { stdin.emit("close"); proxy.emit("close", ...values); });
    return proxy;
  };
  const exited = () => new Promise((resolve) => {
    if (!real || real.exitCode !== null || real.signalCode !== null) return resolve();
    const timer = setTimeout(() => { real.kill(); resolve(); }, 10000);
    real.once("close", () => { clearTimeout(timer); resolve(); });
  });
  try {
    await assert.rejects(
      createCodexAdapter({ ...config, runtimeArgs: [liveEntry] }, () => {}, undefined, openChild),
      (error) => error.bridgeCode !== "unsupported-native-version",
    );
  } finally {
    await exited();
  }
  t.diagnostic(`installed app-server product token: ${product}`);
  assert.ok(accepted, "the bridge must accept the installed version before any thread request");
  assert.deepEqual(forwarded.slice(0, 2), ["initialize", "initialized"]);
});

const PNG = { mimeType: "image/png", data: "iVBORw0KGgo=" };

test("images reach Codex as data URL input items and show as markers", async () => {
  const events = [];
  const adapter = await createCodexAdapter(config, (event) => events.push(event));
  try {
    for (const invalid of [[{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }], [{ mimeType: "image/png", data: "not base64!" }], Array.from({ length: 7 }, () => PNG)]) {
      await assert.rejects(adapter.prompt({ text: "look", mode: "prompt", images: invalid }), { bridgeCode: "invalid-request" });
    }
    await adapter.prompt({ text: "look", mode: "prompt", images: [PNG] });
    await waitFor(() => adapter.snapshot().title.startsWith("turn/start:"));
    assert.equal(adapter.snapshot().title, "turn/start:text:look|image:data:image/png;base64,iVBORw0KGgo=");
    const user = await waitFor(() => adapter.snapshot().blocks.find((block) => block.kind === "user"));
    assert.equal(user.text, "look\n\n[image]");
    assert.doesNotMatch(JSON.stringify(adapter.snapshot().blocks), /iVBORw0KGgo/);
  } finally { await adapter.dispose(); }
});

test("a text-only Codex model refuses images before any turn starts", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--text-only-model"] }, () => {});
  try {
    assert.equal((await adapter.composerCapabilities()).images, false);
    const title = adapter.snapshot().title;
    await assert.rejects(adapter.prompt({ text: "look", mode: "prompt", images: [PNG] }), { bridgeCode: "unsupported-input" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(adapter.snapshot().title, title, "no turn was started");
    assert.equal(adapter.snapshot().status, "idle");
  } finally { await adapter.dispose(); }
});

test("$ mentions of an enabled skill carry the native skill input item", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--skills"] }, () => {});
  try {
    assert.deepEqual(await adapter.composerCatalog(), {
      commands: [],
      skills: [
        { name: "test-runner", description: "Run the tests", mention: "$test-runner" },
        { name: "twin", description: "One", mention: "$twin" },
        { name: "twin", description: "Two", mention: "$twin" },
      ],
    });
    await adapter.prompt({ text: "Please $test-runner, then $twin and $test-runner-extra", mode: "prompt" });
    await waitFor(() => adapter.snapshot().title.startsWith("turn/start:"));
    // The ambiguous `twin` and the unknown `test-runner-extra` stay plain text.
    assert.equal(adapter.snapshot().title, "turn/start:text:Please $test-runner, then $twin and $test-runner-extra|skill:test-runner@/skills/test-runner/SKILL.md");
  } finally { await adapter.dispose(); }
});
