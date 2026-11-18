import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, toNamespacedPath, win32 } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createCodexAdapter } from "./codex.mjs";
import { runBridge } from "./runner.mjs";

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

const branchTurns = [
  { id: "source-turn-1", status: "completed", items: [
    { type: "userMessage", id: "source-user-1", content: [{ type: "text", text: "ALPHA", text_elements: [] }] },
    { type: "agentMessage", id: "source-answer-1", text: "First answer", phase: null, memoryCitation: null },
  ] },
  { id: "source-turn-2", status: "completed", items: [
    { type: "userMessage", id: "source-user-2", content: [{ type: "text", text: "BETA", text_elements: [] }] },
    { type: "agentMessage", id: "source-answer-2", text: "Second answer", phase: null, memoryCitation: null },
  ] },
];

// Keep the existing app-server fake responsible for startup, permissions and
// cwd validation. Its transport seam supplies the native fork/list responses
// proven separately by the read-only spike, without changing the fake itself.
function forkTransport({ pages = [{ data: branchTurns, nextCursor: null }], childTurns = branchTurns, sourcePage, forkError, listError } = {}) {
  const calls = [];
  const openChild = (program, args, options) => {
    const child = spawn(program, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (frame, callback) => {
      const message = JSON.parse(frame);
      calls.push(message);
      const respond = value => {
        callback?.();
        queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: message.id, ...value })}\n`)));
        return true;
      };
      if (message.method === "thread/turns/list") {
        if (listError && message.params.threadId === "source-fixture") return respond({ error: { code: -32602, message: listError } });
        const index = message.params.cursor ? Number(message.params.cursor.slice("page-".length)) : 0;
        const page = message.params.threadId === "source-fixture"
          ? sourcePage?.(index) ?? pages[index] ?? { data: [], nextCursor: null }
          : { data: [...childTurns].reverse(), nextCursor: null, backwardsCursor: null };
        return respond({ result: page });
      }
      if (message.method === "thread/fork") {
        if (forkError) return respond({ error: { code: -32602, message: forkError } });
        const params = { ...message.params, threadId: "forked-fixture", initialTurnsPage: { sortDirection: "desc", itemsView: "full" } };
        delete params.lastTurnId;
        return write(`${JSON.stringify({ ...message, method: "thread/resume", params })}\n`, callback);
      }
      return write(frame, callback);
    };
    return child;
  };
  return { calls, openChild };
}

test("Codex native forks use only the fork schema's settings and read their own history and saved tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-fork-"));
  const sourcePath = join(directory, "source.jsonl");
  const ownPath = join(directory, "child.jsonl");
  const metadata = tools => `${JSON.stringify({ type: "session_meta", payload: { dynamic_tools: [{ type: "namespace", name: "piui", tools: tools.map(name => ({ type: "function", name })) }] } })}\n`;
  const tools = ["board", "sidekick", "sessions"];
  try {
    for (const savedTools of [[], tools]) {
      await writeFile(sourcePath, metadata(savedTools.length ? [] : tools));
      await writeFile(ownPath, metadata(savedTools));
      const sourceBefore = readFileSync(sourcePath, "utf8");
      const { calls, openChild } = forkTransport();
      const events = [];
      const adapter = await createCodexAdapter({
        ...config, fork: { nativeId: "source-fixture", nativePath: sourcePath },
        model: { id: "fixture-model", provider: "openai", name: "Fixture Model" },
        permissionMode: "workspace-write", thinkingLevel: "low", serviceTier: "fast",
        baseInstructions: "Base instructions", instructions: "Chat instructions", nativeSubagents: false,
        resourceRules: [{ kind: "skill", id: join(directory, "SKILL.md"), enabled: false }, { kind: "mcp", id: "example", enabled: false }],
        hostTools: tools,
        runtimeArgs: [fixture, "--expect-permission", "workspace-write", `--rollout=${ownPath}`],
      }, event => events.push(event), undefined, openChild, async () => ({ ok: true }), async () => ({ ok: true, text: "" }), {}, async () => ({ ok: true, chats: [] }));
      try {
        const opened = calls.find(call => call.method === "thread/fork");
        assert.deepEqual(opened.params, {
          threadId: "source-fixture", cwd: config.cwd, serviceTier: "fast", model: "fixture-model", modelProvider: "openai",
          baseInstructions: "Base instructions", developerInstructions: "Chat instructions",
          config: { "skills.config": [{ path: join(directory, "SKILL.md"), enabled: false }], "mcp_servers.example.enabled": false, "features.multi_agent": false, "features.multi_agent_v2": false },
          permissions: ":workspace", approvalPolicy: "never", excludeTurns: true,
        });
        assert.ok(!calls.some(call => call.method === "thread/start" || call.method === "thread/resume"));
        assert.deepEqual(calls.filter(call => call.method === "thread/turns/list").map(call => call.params), [
          { threadId: "forked-fixture", sortDirection: "desc", itemsView: "full" },
        ]);
        assert.equal(adapter.snapshot().nativeId, "forked-fixture");
        assert.equal(adapter.snapshot().nativePath, ownPath);
        assert.equal(adapter.snapshot().materialized, true);
        assert.deepEqual(adapter.snapshot().blocks.filter(block => ["user", "assistant"].includes(block.kind)).map(block => [block.id, block.text]), [
          ["source-user-1", "ALPHA"], ["source-answer-1", "First answer"], ["source-user-2", "BETA"], ["source-answer-2", "Second answer"],
        ]);
        assert.deepEqual(events.filter(event => event.type === "notice").map(event => event.code), savedTools.length ? [] : tools.map(name => `unsupported-${name}-tool-resume`));
        assert.deepEqual(events.find(event => event.type === "binding"), { type: "binding", nativeId: "forked-fixture", nativePath: ownPath });
        assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore, "the source rollout remains untouched");
      } finally { await adapter.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Codex branch cuts page the source ascending and pass the preceding turn as lastTurnId", async () => {
  const { calls, openChild } = forkTransport({
    pages: [{ data: [branchTurns[0]], nextCursor: "page-1" }, { data: [branchTurns[1]], nextCursor: null }],
    childTurns: [branchTurns[0]],
  });
  const adapter = await createCodexAdapter({ ...config, fork: { nativeId: "source-fixture", beforeBlockId: "source-user-2" } }, () => {}, undefined, openChild);
  try {
    assert.deepEqual(calls.filter(call => call.method === "thread/turns/list").map(call => call.params), [
      { threadId: "source-fixture", sortDirection: "asc", itemsView: "full" },
      { threadId: "source-fixture", sortDirection: "asc", itemsView: "full", cursor: "page-1" },
      { threadId: "forked-fixture", sortDirection: "desc", itemsView: "full" },
    ]);
    assert.deepEqual(calls.find(call => call.method === "thread/fork").params, {
      threadId: "source-fixture", lastTurnId: "source-turn-1", cwd: config.cwd, config: {}, excludeTurns: true,
    });
    assert.deepEqual(adapter.snapshot().blocks.filter(block => ["user", "assistant"].includes(block.kind)).map(block => block.text), ["ALPHA", "First answer"]);
  } finally { await adapter.dispose(); }
});

test("a Codex cut before the first user message starts a fresh thread without dynamic tools", async () => {
  const { calls, openChild } = forkTransport();
  const adapter = await createCodexAdapter({ ...config, fork: { nativeId: "source-fixture", beforeBlockId: "source-user-1" }, hostTools: ["board", "sidekick", "sessions"] }, () => {}, undefined, openChild, async () => ({ ok: true }), async () => ({ ok: true, text: "" }), {}, async () => ({ ok: true, chats: [] }));
  try {
    assert.ok(!calls.some(call => call.method === "thread/fork"));
    assert.deepEqual(calls.find(call => call.method === "thread/start").params, { config: {}, ephemeral: false });
    assert.equal(calls.filter(call => call.method === "thread/turns/list").length, 1);
    assert.equal(adapter.snapshot().materialized, false);
    assert.deepEqual(adapter.snapshot().blocks.filter(block => ["user", "assistant"].includes(block.kind)), []);
  } finally { await adapter.dispose(); }
});

test("Codex refuses invalid fork references before startup and bounds branch-point discovery", async () => {
  let launched = false;
  const neverLaunch = () => { launched = true; throw new Error("must not launch"); };
  for (const fork of [null, {}, { nativeId: "" }, { nativeId: "x".repeat(201) }, { nativeId: "source-fixture", nativePath: 1 }, { nativeId: "source-fixture", beforeBlockId: "" }, { nativeId: "source-fixture", beforeBlockId: "x".repeat(257) }, { nativeId: "source-fixture", extra: true }]) {
    await assert.rejects(createCodexAdapter({ ...config, fork }, () => {}, undefined, neverLaunch), { bridgeCode: "invalid-session" });
  }
  await assert.rejects(createCodexAdapter({ ...config, nativeId: "source-fixture", fork: { nativeId: "source-fixture" } }, () => {}, undefined, neverLaunch), { bridgeCode: "invalid-session" });
  await assert.rejects(createCodexAdapter({ ...config, coordination: true, fork: { nativeId: "source-fixture" } }, () => {}, async () => ({}), neverLaunch), { bridgeCode: "unsupported-coordinator-resume" });
  assert.equal(launched, false);
  for (const [options, expectedPages] of [[{}, 1], [{ sourcePage: () => ({ data: [], nextCursor: "page-1" }) }, 200]]) {
    const { calls, openChild } = forkTransport(options);
    await assert.rejects(createCodexAdapter({ ...config, fork: { nativeId: "source-fixture", beforeBlockId: "unknown-user" } }, () => {}, undefined, openChild), {
      bridgeCode: "branch-point-not-found", safeMessage: "That message is no longer in the chat this one branches from.",
    });
    assert.equal(calls.filter(call => call.method === "thread/turns/list").length, expectedPages);
    assert.ok(!calls.some(call => ["thread/start", "thread/fork"].includes(call.method)));
  }
});

test("Codex maps native fork failures safely and retains effective cwd and permission validation", async () => {
  for (const [forkError, code, safeMessage] of [
    ["turn not found: PRIVATE_TURN", "branch-point-not-found", "That message is no longer in the chat this one branches from."],
    ["PRIVATE_UNSUPPORTED_METHOD", "branch-unsupported", "This chat cannot be branched natively."],
  ]) {
    const { openChild } = forkTransport({ forkError });
    await assert.rejects(createCodexAdapter({ ...config, fork: { nativeId: "source-fixture" } }, () => {}, undefined, openChild), { bridgeCode: code, safeMessage });
  }
  for (const [args, code] of [
    [["--wrong-cwd"], "native-cwd-mismatch"],
    [["--effective-permission-mismatch"], "unsupported-permission-mode"],
  ]) {
    const { openChild } = forkTransport();
    await assert.rejects(createCodexAdapter({ ...config, fork: { nativeId: "source-fixture" }, permissionMode: "workspace-write", runtimeArgs: [fixture, "--expect-permission", "workspace-write", ...args] }, () => {}, undefined, openChild), { bridgeCode: code });
  }
});

test("Codex refuses a selected Nano model if its private source is absent", async () => {
  const model = { id: "free", provider: "nano-codex-subscription", name: "Free" };
  await assert.rejects(createCodexAdapter({ ...config, model }, () => {}), { bridgeCode: "invalid-config" });
});

test("a native Codex provider with Nano's name has a distinct catalog identity", async () => {
  const runtimeArgs = [fixture, "--nano-named-native-provider"];
  const probe = await createCodexAdapter({
    ...config, catalogOnly: true, runtimeArgs,
  }, () => {});
  let model;
  try {
    const models = await probe.catalogModels();
    assert.ok(models.length > 0);
    assert.ok(models.every(model => model.provider === "codex-native:nano-codex-subscription"));
    [model] = models;
  } finally { await probe.dispose(); }
  const adapter = await createCodexAdapter({ ...config, model, runtimeArgs }, () => {});
  try {
    assert.equal(adapter.snapshot().model.provider, "codex-native:nano-codex-subscription");
  } finally { await adapter.dispose(); }
});

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

test("catalog-only Codex reads models and resources without starting or binding a thread", async () => {
  for (const [reject, overrides] of [["thread/start", {}], ["thread/resume", { nativeId: "saved" }]]) {
    const events = [];
    const adapter = await createCodexAdapter({ ...config, ...overrides, catalogOnly: true, runtimeArgs: [fixture, `--reject-startup=${reject}`] }, event => events.push(event));
    try {
      assert.deepEqual(await adapter.catalogModels(), [{ id: "fixture-model", name: "Fixture Model", thinkingLevels: ["low"], supportsFast: true }]);
      assert.deepEqual((await adapter.resources()).items.map(item => item.kind), ["skill", "mcp", "tool"]);
      assert.equal(adapter.prompt, undefined);
      assert.ok(!events.some(event => event.type === "binding"));
    } finally { await adapter.dispose(); }
  }
});

test("catalog-only Codex preserves models and available resources when skill discovery fails", async () => {
  const adapter = await createCodexAdapter({ ...config, catalogOnly: true, runtimeArgs: [fixture, "--reject-startup=skills/list"] }, () => {});
  try {
    const resources = await adapter.resources();
    assert.deepEqual(resources.items.map(item => item.kind), ["mcp", "tool"]);
    assert.deepEqual(resources.warnings, ["Skills could not be loaded from Codex."]);
    assert.equal((await adapter.catalogModels())[0].id, "fixture-model");
  } finally { await adapter.dispose(); }
});

test("catalog-only Codex preserves skills and configured servers when MCP tools never answer", async (t) => {
  const methods = [];
  const openChild = (program, args, options) => {
    const child = spawn(program, args, options);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (frame, callback) => {
      const { method } = JSON.parse(frame);
      methods.push(method);
      if (method === "mcpServerStatus/list") {
        callback?.();
        return true;
      }
      return write(frame, callback);
    };
    return child;
  };
  const adapter = await createCodexAdapter({ ...config, catalogOnly: true }, () => {}, undefined, openChild);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = adapter.resources();
    assert.deepEqual(methods.slice(-3), ["skills/list", "config/read", "mcpServerStatus/list"], "all inventories start before any answer");
    t.mock.timers.tick(75_000);
    const resources = await pending;
    assert.deepEqual(resources.items, [
      { kind: "skill", id: "/skills/review/SKILL.md", name: "Review", enabled: false, configurable: true },
      { kind: "mcp", id: "docs", name: "docs", enabled: true, configurable: true },
    ]);
    assert.deepEqual(resources.warnings, ["MCP tools could not be loaded from Codex."]);
  } finally {
    t.mock.timers.reset();
    await adapter.dispose();
  }
});

test("catalog-only Codex labels models with the configured native provider when known", async () => {
  for (const [runtimeArgs, provider] of [
    [[fixture, "--custom-model-provider"], "fixture-gateway"],
    [[fixture, "--reject-startup=config/read"], undefined],
  ]) {
    const adapter = await createCodexAdapter({ ...config, catalogOnly: true, runtimeArgs }, () => {});
    try {
      const [model] = await adapter.catalogModels();
      assert.equal(model.id, "fixture-model");
      assert.equal(model.provider, provider);
    } finally { await adapter.dispose(); }
  }
});

test("catalog-only Codex keeps the configured or native default model even when hidden", async () => {
  for (const flag of ["--configured-hidden-model", "--hidden-model-is-default"]) {
    const adapter = await createCodexAdapter({
      ...config,
      catalogOnly: true,
      runtimeArgs: [fixture, "--hidden-current-model", flag],
    }, () => {});
    try {
      assert.deepEqual(await adapter.catalogModels(), [{
        id: "fixture-model", name: "Hidden current", thinkingLevels: ["low", "ultra"], supportsFast: true,
      }]);
    } finally { await adapter.dispose(); }
  }
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
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
    for (const type of ["sleep", "hookPrompt", "functionCallOutput"]) {
      const block = adapter.snapshot().blocks.find((value) => value.id === `unsupported-${type}`);
      assert.equal(block.kind, "unknown");
      assert.equal(block.fallback, true);
      assert.match(block.safeSummary, new RegExp(type));
    }
    // Image generation has its own projection now (a tool block, not a fallback).
    const generation = adapter.snapshot().blocks.find((value) => value.id === "unsupported-imageGeneration");
    assert.deepEqual([generation.kind, generation.label, generation.toolName, generation.status], ["tool", "Image generation", "image-generation", "streaming"]);
  } finally {
    await adapter.dispose();
  }
});

for (const history of [false, true]) test(`projects Codex agent and image items from ${history ? "history" : "live notifications"} without thread ids`, async () => {
  const events = [];
  const adapter = await createCodexAdapter({
    ...config, ...(history ? { nativeId: "resume-projected" } : {}), runtimeArgs: [fixture, "--projected-items"],
  }, event => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().blocks.some(block => block.id === "collab-bounded" && block.status === "complete"));
    const block = id => adapter.snapshot().blocks.find(value => value.id === id);
    const collab = block("collab-item");
    assert.deepEqual(
      [collab.kind, collab.label, collab.toolName, collab.title, collab.status, collab.truncated],
      ["tool", "Agent", "subagent", "Start agent: Review the parser and suggest a fix.", "streaming", false],
    );
    assert.equal(collab.text, [
      "Prompt: Review the parser\nand suggest a fix.", "Model: fixture-model", "Reasoning: high",
      "Agent 1: running (Inspecting the parser and its tests.)", `Agent 2: completed (${"m".repeat(199)}…)`,
      ...Array.from({ length: 6 }, (_, index) => `Agent ${index + 3}: completed`),
    ].join("\n"));
    assert.doesNotMatch(collab.text, /Agent 9:/);
    const bare = block("collab-empty");
    assert.deepEqual([bare.title, bare.text, bare.status], ["Wait for agents", "", "complete"]);
    assert.doesNotMatch(bare.text, /Prompt:/);
    const subagent = block("subagent-item");
    assert.deepEqual(
      [subagent.kind, subagent.label, subagent.toolName, subagent.title, subagent.text, subagent.status],
      ["tool", "Agent", "subagent", "Agent interrupted · reviewer/parser", "Agent: reviewer/parser\nModel: fixture-model\nReasoning: medium", "interrupted"],
    );
    assert.deepEqual(
      [block("subagent-complete").title, block("subagent-complete").text, block("subagent-complete").status],
      ["Agent finished · reviewer/parser", "Agent: reviewer/parser", "complete"],
    );
    const image = block("image-view-item");
    assert.deepEqual(
      [image.kind, image.label, image.toolName, image.title, image.text, image.status],
      ["tool", "Image", "read", "/workspace/diagram.png", "Path: /workspace/diagram.png", "complete"],
    );
    if (!history) assert.equal(events.find(event => event.type === "block" && event.block.id === image.id).block.status, "streaming", "event status overrides the projection");
    const bounded = block("collab-bounded");
    assert.equal(bounded.title, `Start agent: ${"x".repeat(99)}…`);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.text.length <= 16 * 1024 + 64);
    const projected = [collab, bare, subagent, block("subagent-complete"), image, bounded];
    for (const item of projected) {
      assert.equal(item.collapsible, true);
      assert.equal(item.fallback, undefined);
      assert.equal(item.safeSummary, undefined);
      assert.doesNotMatch(`${item.title}\n${item.text}`, /SECRET-THREAD-ID/);
      assert.ok(Object.keys(item).every(key => ["id", "kind", "label", "status", "text", "title", "toolName", "collapsible", "truncated", "createdAt"].includes(key)));
    }
    assert.doesNotMatch(JSON.stringify(projected), /SECRET-THREAD-ID/);
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

test("the board tool is optional: a resumed thread starts without it and a notice", async () => {
  const board = async () => ({ ok: true, op: "roster", teammates: [] });
  const resumedEvents = [];
  const resumed = await createCodexAdapter({ ...config, nativeId: "resume-fixture", hostTools: ["board"] }, (event) => resumedEvents.push(event), undefined, undefined, board);
  try {
    assert.equal(resumed.snapshot().nativeId, "resume-fixture");
    assert.deepEqual(resumedEvents.filter((event) => event.type === "notice"), [{ type: "notice", code: "unsupported-board-tool-resume" }]);
    assert.equal(resumed.snapshot().capabilities.nativeSubagents.enforcement, "native");
  } finally {
    await resumed.dispose();
  }
  const freshEvents = [];
  const fresh = await createCodexAdapter({ ...config, hostTools: ["board"] }, (event) => freshEvents.push(event), undefined, undefined, board);
  try {
    assert.equal(freshEvents.filter((event) => event.type === "notice").length, 0);
    assert.equal(fresh.snapshot().capabilities.nativeSubagents.enforcement, "native", "the board never disables native subagents");
  } finally {
    await fresh.dispose();
  }
});

test("a resumed thread started with the board keeps it; a thread without it gets the notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-rollout-"));
  // Codex 0.163 rollouts start with `session_meta` carrying the persisted dynamic tools.
  const rollout = async (name, tools) => {
    const file = join(directory, name);
    const meta = { type: "session_meta", payload: { id: "resume-fixture", base_instructions: { text: "x".repeat(30000) }, dynamic_tools: tools } };
    await writeFile(file, `${JSON.stringify(meta)}
{"type":"turn_context","payload":{}}
`);
    return file;
  };
  const piui = (...names) => [{ type: "namespace", name: "piui", description: "PiUI host tools for this chat.", tools: names.map((name) => ({ type: "function", name, inputSchema: { type: "object" } })) }];
  const withBoard = await rollout("board.jsonl", piui("board"));
  const resume = async (file, hostTools, calls) => {
    const events = [];
    const adapter = await createCodexAdapter({ ...config, nativeId: "resume-fixture", runtimeArgs: [fixture, `--rollout=${file}`, "--board-call"], ...(hostTools ? { hostTools } : {}) },
      (event) => events.push(event), undefined, undefined, async (operation) => { calls.push(operation); return { ok: true, op: operation.op }; });
    try {
      const title = await waitFor(() => adapter.snapshot().title.startsWith("board:") && adapter.snapshot().title);
      return { title, notices: events.filter((event) => event.type === "notice").map((event) => event.code) };
    } finally { await adapter.dispose(); }
  };
  try {
    const accepted = [];
    assert.deepEqual(await resume(withBoard, ["board"], accepted), { title: "board:true:roster", notices: [] });
    assert.deepEqual(accepted, [{ op: "roster" }]);

    // The board is off for this chat now: the persisted tool gets a clean refusal.
    const disabled = [];
    assert.deepEqual(await resume(withBoard, undefined, disabled), { title: "board:false:board-disabled", notices: [] });
    assert.deepEqual(disabled, []);

    // Started without the board (another piui tool, no tools, unreadable meta): notice.
    for (const file of [await rollout("sidekick.jsonl", piui("sidekick")), await rollout("none.jsonl", []), join(directory, "missing.jsonl")]) {
      const events = [];
      const adapter = await createCodexAdapter({ ...config, nativeId: "resume-fixture", runtimeArgs: [fixture, `--rollout=${file}`], hostTools: ["board"] },
        (event) => events.push(event), undefined, undefined, async () => ({ ok: true }));
      try {
        assert.deepEqual(events.filter((event) => event.type === "notice").map((event) => event.code), ["unsupported-board-tool-resume"]);
      } finally { await adapter.dispose(); }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  // Plugins v2: Codex cannot take a plugin MCP server for one thread.
  await assert.rejects(
    createCodexAdapter({ ...config, pluginMcpServers: [{ name: "example-tool-cards-issues", command: process.execPath, args: ["server.mjs"] }] }, () => {}),
    (error) => error.bridgeCode === "unsupported-settings",
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

test("refuses only app-server versions older than the minimum; newer than tested starts", async () => {
  // Audited protocols (0.147.0, 0.153.4, 0.157.1), releases between them and
  // every newer release: the tested ceiling (0.158.0) is advisory, so 0.158.0,
  // previews of untested lines, the installed 0.165.0 and a future major start.
  for (const version of [
    "0.147.0", "0.148.0", "0.153.4", "0.157.1", "0.157.1-alpha", "0.157.9",
    "0.158.0", "0.158.0-alpha.2", "0.159.0-alpha.4", "0.165.0", "1.0.0",
  ]) {
    const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, `--codex-version=${version}`] }, () => {});
    try { assert.equal(adapter.snapshot().status, "idle", version); }
    finally { await adapter.dispose(); }
  }
  const rejected = [
    // Older than the minimum; a pre-release precedes its release.
    ["0.146.9", /older than the oldest version/],
    ["0.147.0-alpha.1", /older than the oldest version/],
    // Only the leading product token names Codex: the trailing client version
    // `(piui; 0.2.0)` never stands in for an unrecognized Codex version.
    ["latest", /could not be recognized/],
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

test("an originator with spaces still names the Codex version", async () => {
  const adapter = await createCodexAdapter({ ...config, catalogOnly: true, runtimeArgs: [fixture, "--spaced-originator"] }, () => {});
  try { assert.ok((await adapter.catalogModels()).length > 0); }
  finally { await adapter.dispose(); }
});

test("Codex identifies an existing writer when resuming the same native thread", async () => {
  const events = [];
  await assert.rejects(
    createCodexAdapter({ ...config, nativeId: "thread-resumed", runtimeArgs: [fixture, "--active-writer"] }, event => events.push(event)),
    error => error.bridgeCode === "native-thread-busy" && !error.safeMessage.includes("thread-resumed"),
  );
  assert.equal(events.some(event => event.type === "binding"), false);
});

test("a newer app-server still has to pass the startup checks: protocol drift fails closed with a typed error", async () => {
  const newer = "--codex-version=0.165.0";
  const startup = [
    ["initialize", "--reject-startup=initialize"],
    ["initialize", "--malformed-startup=initialize"],
    ["thread/start", "--reject-startup=thread/start"],
    ["thread/start", "--malformed-startup=thread/start"],
  ];
  for (const [method, flag] of startup) {
    const events = [];
    await assert.rejects(
      createCodexAdapter({ ...config, runtimeArgs: [fixture, newer, flag] }, (event) => events.push(event)),
      (error) => error.bridgeCode === "native-protocol-mismatch"
        && !/PRIVATE_NATIVE_DETAIL/.test(error.safeMessage) && !/PRIVATE_NATIVE_DETAIL/.test(JSON.stringify(events)),
      `${method} ${flag}`,
    );
    assert.equal(events.some((event) => event.type === "binding"), false, flag);
  }
  // Resuming goes through thread/resume, a different required request.
  for (const flag of ["--reject-startup=thread/resume", "--malformed-startup=thread/resume"]) {
    await assert.rejects(
      createCodexAdapter({ ...config, nativeId: "thread-resumed", runtimeArgs: [fixture, newer, flag] }, () => {}),
      { bridgeCode: "native-protocol-mismatch" },
      flag,
    );
  }
  // model/list is read after the session is up; the session itself stays usable.
  for (const flag of ["--reject-startup=model/list", "--malformed-startup=model/list"]) {
    const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, newer, flag] }, () => {});
    try {
      await assert.rejects(adapter.models(), (error) => error.bridgeCode === "native-protocol-mismatch" && !/PRIVATE_NATIVE_DETAIL/.test(error.safeMessage), flag);
      assert.equal(adapter.snapshot().status, "idle");
    } finally { await adapter.dispose(); }
  }
});

test("known housekeeping notifications of 0.165 are ignored without a block or an error", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--codex-version=0.165.0", "--housekeeping"] }, (event) => events.push(event));
  try {
    // Wait for the final fixture notification before inspecting the transcript.
    await waitFor(() => adapter.snapshot().blocks.some((block) => block.safeSummary === "unsupported request rejected"));
    assert.deepEqual(adapter.snapshot().blocks.filter((block) => block.fallback).map((block) => block.safeSummary), []);
    assert.doesNotMatch(JSON.stringify({ events, snapshot: adapter.snapshot() }), /account\/updated|remoteControl|planType/);
    assert.deepEqual(events.filter((event) => event.type === "error").map((event) => event.message), ["Codex requested an unsupported host operation."]);
  } finally { await adapter.dispose(); }
});

test("an unknown notification becomes one fallback block per method however often it repeats", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--unknown-repeat"] }, (event) => events.push(event));
  try {
    await waitFor(() => adapter.snapshot().blocks.some((block) => block.safeSummary === "Unsupported Codex event: future/other"));
    const summaries = adapter.snapshot().blocks.filter((block) => block.fallback).map((block) => block.safeSummary);
    assert.equal(summaries.filter((summary) => summary === "Unsupported Codex event: future/stream/delta").length, 1);
    assert.equal(summaries.filter((summary) => summary === "Unsupported Codex event: future/other").length, 1);
    assert.equal(events.filter((event) => event.type === "block" && event.block.fallback && /future\//.test(event.block.safeSummary)).length, 2);
    assert.doesNotMatch(JSON.stringify({ events, snapshot: adapter.snapshot() }), /PRIVATE_PAYLOAD/);
    assert.equal(adapter.snapshot().status, "idle");
  } finally { await adapter.dispose(); }
});

test("a handler that throws on a well-formed frame becomes one fallback and does not end the session", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--throwing-handlers"] }, (event) => events.push(event));
  try {
    // The throwing request is answered with an error instead of left pending.
    await waitFor(() => adapter.snapshot().title === "throwing-request:error");
    const summaries = adapter.snapshot().blocks.filter((block) => block.fallback).map((block) => block.safeSummary);
    for (const method of ["item/fileChange/patchUpdated", "item/started", "item/tool/requestUserInput"]) {
      assert.equal(summaries.filter((summary) => summary === `Unsupported Codex event: ${method}`).length, 1, method);
    }
    assert.equal(adapter.snapshot().approvals.some((approval) => approval.title === "Codex needs input"), false);
    assert.notEqual(adapter.snapshot().status, "failed");
    assert.deepEqual(await adapter.prompt({ text: "after the failures", mode: "prompt" }), { accepted: true });
    await waitFor(() => events.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
    assert.equal(adapter.snapshot().status, "idle");
  } finally { await adapter.dispose(); }
});

const disabledNames = (adapter) => adapter.snapshot().title.replace(/^disable:/, "").split(",");
const BASE_DISABLES = ["apps", "plugins", "remote_plugin", "recommended_plugins", "shell_snapshot"];
const echoedDisables = async (overrides, flags = []) => {
  const adapter = await createCodexAdapter({ ...config, ...overrides, runtimeArgs: [fixture, "--echo-disables", ...flags] }, () => {});
  try {
    await waitFor(() => adapter.snapshot().title.startsWith("disable:"));
    return disabledNames(adapter);
  } finally { await adapter.dispose(); }
};

test("every restriction reaches the app server as --disable when the installed CLI lists its features", async () => {
  assert.deepEqual(await echoedDisables({}), BASE_DISABLES);
  assert.deepEqual(await echoedDisables({ nativeSubagents: false }), [...BASE_DISABLES, "multi_agent", "multi_agent_v2"]);
  // A feature that is registered but retired (stage `removed`) keeps its flag.
  assert.deepEqual(await echoedDisables({}, ["--features-list=removed:apps"]), BASE_DISABLES);
});

test("a --disable for a feature absent from a successful listing is dropped", async () => {
  assert.deepEqual(await echoedDisables({}, ["--features-list=without:plugins,shell_snapshot"]), ["apps", "remote_plugin", "recommended_plugins"]);
  // Not a requested policy here, so an absent subagent feature changes nothing.
  assert.deepEqual(await echoedDisables({}, ["--features-list=without:multi_agent_v2"]), BASE_DISABLES);
});

test("without a successful listing every --disable stays: a failed or unrecognized probe never retries with fewer restrictions", async () => {
  for (const mode of ["fail", "garbage", "empty"]) {
    assert.deepEqual(
      await echoedDisables({ nativeSubagents: false }, [`--features-list=${mode}`]),
      [...BASE_DISABLES, "multi_agent", "multi_agent_v2"],
      mode,
    );
  }
});

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

// The fixture probe mimics the Node wrapper of a native codex: it spawns a
// grandchild (the native executable) and never finishes. Killing only the
// wrapper would leave that grandchild alive, so both must be gone before the
// adapter starts the app server, and the start keeps every restriction.
// The flood probe is ended by the output limit, so its timeout is never the cause.
for (const [mode, cause, timeoutMs] of [["stall", "stalls past its timeout", 3000], ["flood", "overflows its output limit", 60000]]) {
  test(`a features probe that ${cause} is ended with its whole process tree before startup continues`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "piui-codex-probe-"));
    const pidFile = join(dir, "pids.json");
    let pids;
    try {
      const adapter = await createCodexAdapter(
        { ...config, runtimeArgs: [fixture, "--echo-disables", `--features-list=${mode}`, `--pid-file=${pidFile}`] },
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs },
      );
      try {
        await waitFor(() => adapter.snapshot().title.startsWith("disable:"), 15000);
        assert.deepEqual(disabledNames(adapter), BASE_DISABLES);
      } finally { await adapter.dispose(); }
      pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(pids.wrapper) && Number.isInteger(pids.grandchild));
      await waitFor(() => !processAlive(pids.wrapper) && !processAlive(pids.grandchild), 15000);
    } finally {
      for (const pid of Object.values(pids ?? {})) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Windows ends the tree with taskkill, never a shell. The injected spawn lets
// every platform assert that exact invocation and that startup waits for it.
const windowsProbeRun = async (taskkillBehavior) => {
  const order = [];
  const calls = [];
  let probe;
  const fakeSpawn = (program, args, options) => {
    calls.push({ program, args, options });
    const child = new EventEmitter();
    if (calls.length === 1) {
      probe = Object.assign(child, {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => { order.push("probe.kill"); exitProbe(); },
      });
      return probe;
    }
    if (taskkillBehavior === "throws") throw new Error("taskkill cannot start");
    setTimeout(() => {
      // A failing taskkill leaves the wrapper (and any descendants) unproven.
      if (taskkillBehavior !== "fails") exitProbe();
      order.push("taskkill-exit");
      child.emit("exit", taskkillBehavior === "fails" ? 128 : 0, null);
    }, 40);
    return Object.assign(child, { kill: () => {} });
  };
  const exitProbe = () => {
    if (probe.exitCode !== null) return;
    probe.exitCode = 1;
    probe.emit("exit", 1, null);
    probe.emit("close", 1, null);
  };
  const openChild = (program, args, options) => {
    order.push("app-server");
    return spawn(program, args, options);
  };
  // The adapter unrefs its probe timer because a real probe's pipes keep the
  // process alive. The fake probe has no handle, so without this the event
  // loop can drain before the timer fires and node:test cancels the file.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = createCodexAdapter(
      // Successful listings are cached per program and arguments; a distinct
      // argument keeps this case from reusing another test's listing.
      { ...config, runtimeArgs: [fixture, "--echo-disables", `--probe-case=${taskkillBehavior}`] },
      () => {},
      undefined,
      openChild,
      undefined,
      undefined,
      { timeoutMs: 30, platform: "win32", spawn: fakeSpawn },
    );
    if (taskkillBehavior !== "exits") {
      await assert.rejects(started, { bridgeCode: "native-unavailable" });
      return { calls, order };
    }
    const adapter = await started;
    try {
      await waitFor(() => adapter.snapshot().title.startsWith("disable:"));
      assert.deepEqual(disabledNames(adapter), BASE_DISABLES);
    } finally { await adapter.dispose(); }
    return { calls, order };
  } finally {
    clearInterval(keepAlive);
  }
};

test("on Windows a stalled features probe is ended by taskkill (absolute path, no shell) before startup continues", async () => {
  const { calls, order } = await windowsProbeRun("exits");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(win32.isAbsolute(calls[1].program) && /\\System32\\taskkill\.exe$/i.test(calls[1].program), calls[1].program);
  assert.deepEqual(calls[1].args, ["/PID", "4242", "/T", "/F"]);
  assert.deepEqual(calls[1].options, { shell: false, windowsHide: true, stdio: "ignore" });
  // The wrapper is killed too as a fallback, but only after taskkill finished,
  // and the app server starts only after that.
  assert.deepEqual(order, ["taskkill-exit", "probe.kill", "app-server"]);
});

test("on Windows a taskkill that cannot start refuses startup instead of running beside the probe", async () => {
  const { calls, order } = await windowsProbeRun("throws");
  assert.equal(calls.length, 2);
  assert.deepEqual(order, ["probe.kill"]);
});

test("on Windows a taskkill that fails refuses startup even if the wrapper exits", async () => {
  const { calls, order } = await windowsProbeRun("fails");
  assert.equal(calls.length, 2);
  assert.deepEqual(order, ["taskkill-exit", "probe.kill"]);
});

test("a sandboxed Fusion sidekick switches every configured MCP server off and refuses when the configuration is unreadable", async () => {
  const sidekick = { ...config, nativeSubagents: false, backgroundTasks: false, permissionMode: "read-only" };
  const adapter = await createCodexAdapter({ ...sidekick, runtimeArgs: [fixture, "--expect-permission", "read-only", "--expect-mcp-off"] }, () => {});
  await adapter.dispose();
  await assert.rejects(
    createCodexAdapter({ ...sidekick, runtimeArgs: [fixture, "--expect-permission", "read-only", "--config-read-fails"] }, () => {}),
    { bridgeCode: "unsupported-resource-policy" },
  );
});

test("a Fusion sidekick proves its subagent switches off, tolerates a CLI that keeps background terminals on, and fails closed otherwise", async () => {
  assert.deepEqual(
    await echoedDisables({ nativeSubagents: false, backgroundTasks: false }),
    [...BASE_DISABLES, "multi_agent", "multi_agent_v2", "unified_exec"],
  );
  // Codex 0.169.0 keeps unified_exec on after --disable; the sidekick still starts.
  assert.deepEqual(
    await echoedDisables({ nativeSubagents: false, backgroundTasks: false }, ["--sticky=unified_exec"]),
    [...BASE_DISABLES, "multi_agent", "multi_agent_v2", "unified_exec"],
  );
  // No unified_exec registered: no background terminals, nothing to switch off.
  assert.deepEqual(
    await echoedDisables({ nativeSubagents: false, backgroundTasks: false }, ["--features-list=without:unified_exec"]),
    [...BASE_DISABLES, "multi_agent", "multi_agent_v2"],
  );
  for (const [mode, code] of [["fail", "unsupported-native-subagent-policy"], ["garbage", "unsupported-native-subagent-policy"], ["removed:multi_agent", "unsupported-native-subagent-policy"], ["--sticky=multi_agent_v2", "unsupported-native-subagent-policy"]]) {
    await assert.rejects(
      createCodexAdapter({ ...config, nativeSubagents: false, backgroundTasks: false, runtimeArgs: [fixture, mode.startsWith("--") ? mode : `--features-list=${mode}`] }, () => {}),
      { bridgeCode: code },
      mode,
    );
  }
});

test("Fusion verifies the effective workspace sandbox reported by Codex 0.169.0", async () => {
  const sandbox = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const spawnFeatures = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.write("apps stable false\nplugins stable false\nmulti_agent deprecated false\nmulti_agent_v2 stable false\nunified_exec stable true\n");
      child.emit("close", 0);
    });
    return child;
  };
  const open = (effectiveSandbox) => {
    const openChild = () => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stdin = new Writable({
        write(frame, _encoding, done) {
          const request = JSON.parse(frame);
          const replies = {
            initialize: { codexHome: process.cwd(), userAgent: "piui/0.169.0" },
            "config/read": { config: {} },
            "thread/start": {
              thread: { id: "fixture", turns: [] }, cwd: process.cwd(), sandbox: effectiveSandbox,
              approvalPolicy: "never", activePermissionProfile: null,
            },
          };
          if (request.method === "thread/start") {
            assert.equal(request.params.sandbox, "workspace-write");
            assert.equal(request.params.permissions, undefined);
            assert.equal(request.params.approvalPolicy, "never");
            assert.deepEqual(request.params.config, {
              "features.multi_agent": false, "features.multi_agent_v2": false,
              "sandbox_workspace_write.writable_roots": [],
              "sandbox_workspace_write.network_access": false,
              "sandbox_workspace_write.exclude_tmpdir_env_var": true,
              "sandbox_workspace_write.exclude_slash_tmp": true,
            });
          }
          done();
          if (request.id) queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result: replies[request.method] }) + "\n"));
        },
      });
      const exited = () => queueMicrotask(() => child.emit("close", 0));
      stdin.once("finish", exited);
      return Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: exited });
    };
    return createCodexAdapter({
      ...config, permissionMode: "workspace-write", nativeSubagents: false, backgroundTasks: false,
      runtimeArgs: [fixture, "--in-process-fusion-sandbox-test"],
    }, () => {}, undefined, openChild, undefined, undefined, { spawn: spawnFeatures });
  };
  const adapter = await open(sandbox);
  await adapter.dispose();
  for (const unsafe of [
    { ...sandbox, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    { ...sandbox, networkAccess: true },
    { ...sandbox, writableRoots: [resolve(process.cwd(), "..")] },
    { ...sandbox, writableRoots: undefined },
  ]) {
    await assert.rejects(open(unsafe), { bridgeCode: "unsupported-permission-mode" });
  }
});

test("a workspace-write Fusion sidekick asks for and proves a folder-only sandbox, and refuses a wider one", async () => {
  const sidekick = { ...config, nativeSubagents: false, backgroundTasks: false, permissionMode: "workspace-write", runtimeArgs: [fixture, "--expect-permission", "workspace-write"] };
  const adapter = await createCodexAdapter(sidekick, () => {});
  try {
    await adapter.prompt({ text: "sandboxed", mode: "prompt" });
    await waitFor(() => adapter.snapshot().title?.startsWith("sandbox:"));
    assert.deepEqual(JSON.parse(adapter.snapshot().title.slice("sandbox:".length)), {
      type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    });
  } finally {
    await adapter.dispose();
  }
  await assert.rejects(
    createCodexAdapter({ ...sidekick, runtimeArgs: [...sidekick.runtimeArgs, "--ignore-sidekick-sandbox"] }, () => {}),
    { bridgeCode: "unsupported-permission-mode" },
  );
});

test("a Fusion sidekick turn stays running while background terminals run, and a stop terminates them", async () => {
  process.env.PIUI_TEST_BACKGROUND_POLL_MS = "20";
  const sidekick = { ...config, nativeSubagents: false, backgroundTasks: false, permissionMode: "read-only" };
  const events = [];
  const adapter = await createCodexAdapter({ ...sidekick, runtimeArgs: [fixture, "--expect-permission", "read-only", "--background-terminals=3"] }, (event) => events.push(event));
  try {
    await adapter.prompt({ text: "background", mode: "prompt" });
    await waitFor(() => events.some((event) => event.type === "turnCompleted"));
    // Three listings showed a running terminal before the turn was reported over.
    assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
    assert.equal(adapter.snapshot().status, "idle");
  } finally {
    await adapter.dispose();
  }
  const stopped = [];
  const held = await createCodexAdapter({ ...sidekick, runtimeArgs: [fixture, "--expect-permission", "read-only", "--background-terminals=100000"] }, (event) => stopped.push(event));
  try {
    await held.prompt({ text: "background", mode: "prompt" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stopped.some((event) => event.type === "turnCompleted"), false);
    assert.equal(held.snapshot().status, "running");
    await assert.rejects(held.prompt({ text: "next", mode: "prompt" }), { bridgeCode: "turn-active" });
    assert.deepEqual(await held.interrupt(), { interrupted: true });
    await waitFor(() => stopped.some((event) => event.type === "turnCompleted"));
    assert.equal(held.snapshot().title, "background:cleaned");
  } finally {
    await held.dispose();
    delete process.env.PIUI_TEST_BACKGROUND_POLL_MS;
  }
});

test("a turn still starting reports starting and an interrupt waits for the start before confirming", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--hold-turn", "--slow-turn-start"] }, (event) => events.push(event));
  try {
    const admission = adapter.prompt({ text: "slow", mode: "prompt" });
    await waitFor(() => adapter.snapshot().status === "starting");
    const interrupted = adapter.interrupt();
    let confirmed = false;
    void interrupted.then(() => { confirmed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(confirmed, false, "the interrupt waits for turn/start");
    assert.deepEqual(await interrupted, { interrupted: true });
    await admission;
    await waitFor(() => events.some((event) => event.type === "turnCompleted"));
    assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "interrupted" }]);
  } finally {
    await adapter.dispose();
  }
});

test("a turn/start answered without its turn is an unknown outcome, never a refusal", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--turn-start-no-id"] }, () => {});
  try {
    await assert.rejects(adapter.prompt({ text: "lost", mode: "prompt" }), { bridgeCode: "native-outcome-unknown" });
  } finally {
    await adapter.dispose();
  }
});

test("a native-subagent policy that cannot be proven fails closed before the app server starts", async () => {
  for (const mode of ["without:multi_agent", "without:multi_agent_v2", "removed:multi_agent_v2"]) {
    const flags = [fixture, `--features-list=${mode}`];
    await assert.rejects(
      createCodexAdapter({ ...config, nativeSubagents: false, runtimeArgs: flags }, () => {}),
      { bridgeCode: "unsupported-native-subagent-policy" },
      `nativeSubagents:false ${mode}`,
    );
    await assert.rejects(
      createCodexAdapter({ ...config, coordination: true, runtimeArgs: flags }, () => {}, async () => ({})),
      { bridgeCode: "unsupported-native-subagent-policy" },
      `coordination ${mode}`,
    );
  }
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
    assert.ok(!JSON.stringify(adapter.snapshot().blocks).includes('turn/moderationMetadata'));
    assert.ok(adapter.snapshot().blocks.some(block => block.safeSummary === 'Unsupported Codex event: future/conversation/event'));
  } finally { await adapter.dispose(); }
});

for (const version of ["0.147.0", "0.153.4", "0.157.1", "0.163.0", "0.165.0"]) {
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
      assert.deepEqual(snapshot.blocks.filter((block) => block.fallback).map((block) => block.safeSummary), []);
      assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
    } finally { await adapter.dispose(); }
  });
}

test("Codex presents bounded user-facing warning messages and keeps malformed warnings on the safe fallback", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--warning-events"] }, event => events.push(event));
  try {
    const { blocks } = adapter.snapshot();
    const warnings = blocks.filter(block => block.label === "Codex warning");
    assert.ok(warnings.some(block => block.kind === "custom" && !block.fallback && block.safeSummary === "Global native warning"));
    const long = warnings.find(block => block.safeSummary.startsWith("Thread warning "));
    assert.equal(long.safeSummary.length, 16 * 1024);
    assert.ok(long.safeSummary.endsWith("…"));
    assert.ok(blocks.some(block => block.fallback && block.safeSummary === "Unsupported Codex event: warning"));
    assert.doesNotMatch(JSON.stringify({ events, blocks }), /PRIVATE_(WARNING|OTHER_THREAD)/);
  } finally { await adapter.dispose(); }
});

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

test("maps the 0.153+ and 0.163+ turn errors to fixed summaries", async () => {
  for (const [text, message, outcome] of [
    ["rate limit fixture", "A Codex usage limit prevents this turn.", "failed"],
    ["policy fixture", "Codex blocked this turn under provider policy.", "failed"],
    ["flex fixture", "The selected Codex service tier is unavailable.", "failed"],
    // Guardian's strict circuit breaker interrupts the turn with an error.
    ["denials fixture", "Codex stopped this turn after too many denied actions.", "interrupted"],
  ]) {
    const events = [];
    const adapter = await createCodexAdapter(config, (event) => events.push(event));
    try {
      await adapter.prompt({ text, mode: "prompt" });
      await waitFor(() => events.some((event) => event.type === "turnCompleted"));
      assert.deepEqual(events.filter((event) => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome }]);
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

for (const version of ["0.147.0", "0.153.4", "0.157.1", "0.163.0", "0.165.0"]) {
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

test("0.165 control-plane notifications stay out of the transcript and the priority tier is Fast", async () => {
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--codex-version=0.165.0", "--priority-tier"] }, () => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.snapshot().serviceTier, "fast");
    assert.deepEqual(adapter.snapshot().blocks.filter((block) => block.fallback).map((block) => block.safeSummary), []);
  } finally { await adapter.dispose(); }
});

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

// The shared fixture cannot show what a thread was registered with or inject a
// `piui/sidekick` call, so these tests run it behind a small proxy. The proxy
// forwards every line unchanged in both directions; it logs the dynamic tools
// of `thread/start` / `thread/resume`, injects the `--wrapper-inject=<json>`
// tool calls once the thread is open and logs the adapter's replies to them.
function proxyScript() {
  return [
    'import { spawn } from "node:child_process";',
    'import { appendFileSync } from "node:fs";',
    'import readline from "node:readline";',
    "const options = process.argv.slice(2);",
    'const logPath = options.find((argument) => argument.startsWith("--wrapper-log=")).slice("--wrapper-log=".length);',
    'const injectArgument = options.find((argument) => argument.startsWith("--wrapper-inject="));',
    'const injections = injectArgument ? JSON.parse(injectArgument.slice("--wrapper-inject=".length)) : [];',
    'const passthrough = options.filter((argument) => !argument.startsWith("--wrapper-"));',
    'const log = (value) => appendFileSync(logPath, JSON.stringify(value) + String.fromCharCode(10));',
    `const child = spawn(process.execPath, [${JSON.stringify(fixture)}, ...passthrough], { stdio: ["pipe", "pipe", "inherit"] });`,
    'process.on("exit", () => child.kill());',
    "const starts = new Set();",
    "const injectedIds = new Set(injections.map((call) => call.id));",
    "readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    '  .on("line", (line) => {',
    "    const message = JSON.parse(line);",
    '    if (message.method === "thread/start" || message.method === "thread/resume") {',
    "      starts.add(message.id);",
    '      log({ kind: "thread", method: message.method, dynamicTools: message.params?.dynamicTools ?? null });',
    "    }",
    "    if (message.method === undefined && injectedIds.has(message.id)) {",
    '      log({ kind: "reply", id: message.id, result: message.result ?? null, error: message.error ?? null });',
    "      return;",
    "    }",
    "    child.stdin.write(line + String.fromCharCode(10));",
    "  })",
    '  .on("close", () => child.stdin.end());',
    "readline.createInterface({ input: child.stdout, crlfDelay: Infinity })",
    '  .on("line", (line) => {',
    "    process.stdout.write(line + String.fromCharCode(10));",
    "    let message;",
    "    try { message = JSON.parse(line); } catch { return; }",
    "    if (message && starts.has(message.id) && message.result?.thread?.id) {",
    "      starts.delete(message.id);",
    "      for (const call of injections) {",
    '        process.stdout.write(JSON.stringify({ method: "item/tool/call", id: call.id, params: { threadId: message.result.thread.id, turnId: "turn-sidekick", callId: call.callId, namespace: call.namespace, tool: call.tool, arguments: call.arguments } }) + String.fromCharCode(10));',
    "      }",
    "    }",
    "  })",
    '  .on("close", () => process.exit(0));',
  ].join("\n");
}

async function openProxied(directory, overrides, { args = [], inject = [], callbacks = [] } = {}) {
  const script = join(directory, "codex-proxy.mjs");
  const logPath = join(directory, `proxy-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(script, proxyScript());
  const events = [];
  const adapter = await createCodexAdapter({
    ...config,
    runtimeArgs: [script, `--wrapper-log=${logPath}`, ...(inject.length ? [`--wrapper-inject=${JSON.stringify(inject)}`] : []), ...args],
    ...overrides,
  }, (event) => events.push(event), undefined, undefined, ...callbacks);
  const entries = () => (existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const thread = () => waitFor(() => entries().find((entry) => entry.kind === "thread"));
  const replies = (count) => waitFor(() => {
    const found = entries().filter((entry) => entry.kind === "reply");
    return found.length >= count ? found : undefined;
  });
  return { adapter, events, thread, replies, notices: () => events.filter((event) => event.type === "notice").map((event) => event.code) };
}

const toolNames = (dynamicTools) => dynamicTools.flatMap((spec) => spec.tools.map((tool) => `${spec.name}/${tool.name}`)).sort();

test("sessions is listed only when enabled beside board and missing support leaves the chat usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sessions-"));
  const sessions = async () => ({ ok: true, chats: [] });
  const board = async () => ({ ok: true });
  try {
    for (const [hostTools, expected] of [
      [["sessions"], ["piui/sessions"]],
      [["board", "sessions"], ["piui/board", "piui/sessions"]],
      [["board"], ["piui/board"]],
    ]) {
      const probe = await openProxied(directory, { hostTools }, { callbacks: [board, undefined, {}, sessions] });
      try {
        const tools = (await probe.thread()).dynamicTools;
        assert.deepEqual(toolNames(tools), expected);
        const schema = tools[0].tools.find(tool => tool.name === "sessions")?.inputSchema;
        if (schema) assert.deepEqual(schema.oneOf.map(shape => shape.properties.op.const), ["start", "list", "message", "read", "wait", "stop"]);
      } finally { await probe.adapter.dispose(); }
    }
    const missing = await openProxied(directory, { hostTools: ["sessions"] }, {
      inject: [{ id: 883, callId: "sessions-unavailable", namespace: "piui", tool: "sessions", arguments: { op: "list" } }],
    });
    try {
      assert.equal((await missing.thread()).dynamicTools, null);
      assert.deepEqual(missing.notices(), ["unsupported-sessions-tool"]);
      const [reply] = await missing.replies(1);
      assert.equal(reply.result.success, false);
      assert.equal(JSON.parse(reply.result.contentItems[0].text).code, "not-allowed");
      assert.equal(missing.adapter.snapshot().status, "idle");
    } finally { await missing.adapter.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a resumed Codex thread keeps its saved sessions tool or starts without it and refuses calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sessions-resume-"));
  const calls = [];
  const sessions = async operation => { calls.push(operation); return { ok: true, chats: [] }; };
  const rollout = (name, tools) => {
    const file = join(directory, name);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { dynamic_tools: tools.length ? [{ type: "namespace", name: "piui", tools: tools.map(name => ({ type: "function", name })) }] : [] } }) + "\n");
    return file;
  };
  try {
    const saved = rollout("with-sessions.jsonl", ["sessions"]);
    const kept = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sessions"] }, {
      args: [`--rollout=${saved}`], callbacks: [undefined, undefined, {}, sessions],
      inject: [{ id: 884, callId: "sessions-saved", namespace: "piui", tool: "sessions", arguments: { op: "list" } }],
    });
    try {
      assert.equal((await kept.thread()).dynamicTools, null, "thread/resume never registers new tools");
      assert.deepEqual(kept.notices(), []);
      const [reply] = await kept.replies(1);
      assert.equal(reply.result.success, true);
      assert.deepEqual(JSON.parse(reply.result.contentItems[0].text), { ok: true, chats: [] });
      assert.deepEqual(calls, [{ op: "list" }]);
    } finally { await kept.adapter.dispose(); }
    for (const file of [rollout("board-only.jsonl", ["board"]), rollout("without-tools.jsonl", []), join(directory, "missing.jsonl")]) {
      const missing = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sessions"] }, {
        args: [`--rollout=${file}`], callbacks: [undefined, undefined, {}, sessions],
        inject: [{ id: 885, callId: "sessions-missing", namespace: "piui", tool: "sessions", arguments: { op: "list" } }],
      });
      try {
        assert.equal((await missing.thread()).dynamicTools, null);
        assert.deepEqual(missing.notices(), ["unsupported-sessions-tool-resume"]);
        const [reply] = await missing.replies(1);
        assert.equal(reply.result.success, false);
        assert.equal(JSON.parse(reply.result.contentItems[0].text).code, "not-allowed");
        assert.equal(missing.adapter.snapshot().status, "idle");
        assert.equal(calls.length, 1, "a missing saved tool never reaches the host");
      } finally { await missing.adapter.dispose(); }
    }
    const missingCallback = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sessions"] }, { args: [`--rollout=${saved}`] });
    try {
      await missingCallback.thread();
      assert.deepEqual(missingCallback.notices(), ["unsupported-sessions-tool"]);
    } finally { await missingCallback.adapter.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sessions dynamic calls round-trip through runner validation and preserve JSON refusals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sessions-call-"));
  const script = join(directory, "proxy.mjs");
  const log = join(directory, "calls.jsonl");
  writeFileSync(script, proxyScript());
  const injections = [
    { id: 881, callId: "sessions-list", namespace: "piui", tool: "sessions", arguments: { op: "list" } },
    { id: 882, callId: "sessions-invalid", namespace: "piui", tool: "sessions", arguments: { op: "list", caller: "spoofed" } },
  ];
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  let buffered = "";
  output.on("data", chunk => {
    buffered += chunk.toString("utf8");
    let end;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  const send = (id, method, params) => input.write(`${JSON.stringify({ id, method, params })}\n`);
  const entries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  runBridge((options, emit, coordinator, board, sidekick, sessions) => createCodexAdapter(options, emit, coordinator, undefined, board, sidekick, {}, sessions), input, output);
  send("init", "initialize", { ...config, hostTools: ["sessions"], runtimeArgs: [script, `--wrapper-log=${log}`, `--wrapper-inject=${JSON.stringify(injections)}`] });
  try {
    assert.equal((await waitFor(() => frames.find(frame => frame.id === "init"))).ok, true);
    const request = await waitFor(() => frames.find(frame => frame.event?.type === "sessionsRequest"));
    assert.deepEqual(request.event.operation, { op: "list" });
    const result = { ok: false, code: "not-allowed", message: "Linked chats are not enabled for this chat." };
    send("answer", "sessionsResponse", { requestId: request.event.requestId, result });
    const replies = await waitFor(() => {
      const values = entries().filter(entry => entry.kind === "reply");
      return values.length === 2 ? values : undefined;
    });
    assert.deepEqual(JSON.parse(replies.find(reply => reply.id === 881).result.contentItems[0].text), result);
    assert.equal(replies.find(reply => reply.id === 881).result.success, false);
    assert.equal(JSON.parse(replies.find(reply => reply.id === 882).result.contentItems[0].text).code, "invalid-operation");
    assert.equal(frames.filter(frame => frame.event?.type === "sessionsRequest").length, 1, "invalid operations never reach the host");
  } finally {
    send("dispose", "dispose", {});
    await waitFor(() => frames.find(frame => frame.id === "dispose"));
    input.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh thread registers the sidekick tool in the piui namespace, beside the board when both are on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sidekick-"));
  const board = async () => ({ ok: true, op: "roster" });
  const sidekick = async () => ({ ok: true, text: "ok" });
  try {
    const only = await openProxied(directory, { hostTools: ["sidekick"] }, { callbacks: [undefined, sidekick] });
    try {
      const start = await only.thread();
      assert.equal(start.method, "thread/start");
      assert.equal(start.dynamicTools.length, 1);
      assert.equal(start.dynamicTools[0].type, "namespace");
      assert.equal(start.dynamicTools[0].name, "piui");
      assert.deepEqual(toolNames(start.dynamicTools), ["piui/sidekick"]);
      const tool = start.dynamicTools[0].tools[0];
      assert.equal(tool.type, "function");
      assert.deepEqual(tool.inputSchema.required, ["op"]);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.waitSeconds.maximum, 540);
      assert.deepEqual(tool.inputSchema.properties.outcome.enum, ["accepted", "rejected", "superseded"]);
      assert.deepEqual(only.notices(), []);
      assert.equal(only.adapter.snapshot().capabilities.nativeSubagents.enforcement, "native", "the sidekick never disables native subagents");
    } finally { await only.adapter.dispose(); }

    const both = await openProxied(directory, { hostTools: ["board", "sidekick"] }, { callbacks: [board, sidekick] });
    try {
      const start = await both.thread();
      assert.equal(start.dynamicTools.length, 1, "one piui namespace carries both tools");
      assert.deepEqual(toolNames(start.dynamicTools), ["piui/board", "piui/sidekick"]);
      assert.deepEqual(both.notices(), []);
    } finally { await both.adapter.dispose(); }

    const boardOnly = await openProxied(directory, { hostTools: ["board"] }, { callbacks: [board, sidekick] });
    try {
      assert.deepEqual(toolNames((await boardOnly.thread()).dynamicTools), ["piui/board"], "a callback alone does not register the tool");
    } finally { await boardOnly.adapter.dispose(); }

    // Requested without a host callback: the chat starts without it, with a notice.
    const missing = await openProxied(directory, { hostTools: ["sidekick"] });
    try {
      assert.equal((await missing.thread()).dynamicTools, null);
      assert.deepEqual(missing.notices(), ["unsupported-sidekick-tool"]);
    } finally { await missing.adapter.dispose(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a piui/sidekick tool call is answered with the host's text and bound to its call id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sidekick-"));
  const calls = [];
  const sidekick = async (operation, context) => {
    calls.push({ operation, toolCallId: context.toolCallId, hasSignal: context.signal instanceof AbortSignal });
    if (operation.op === "stop") return { ok: false, text: "Round r1 is not running." };
    if (operation.op === "reset") throw Object.assign(new Error("raw native detail"), { bridgeCode: "sidekick-cancelled", safeMessage: "The sidekick request was cancelled. Collect the result with wait." });
    return { ok: true, text: "Round r1 is working on the login fix." };
  };
  const call = (id, callId, argumentsValue, tool = "sidekick") => ({ id, callId, namespace: "piui", tool, arguments: argumentsValue });
  try {
    const proxied = await openProxied(directory, { hostTools: ["sidekick"] }, {
      callbacks: [undefined, sidekick],
      inject: [
        call(995, "call-status", { op: "status" }),
        call(996, "call-stop", { op: "stop", roundId: "r1" }),
        call(997, "call-reset", { op: "reset" }),
        call(998, "call-invalid", []),
      ],
    });
    try {
      const replies = await proxied.replies(4);
      const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply.result]));
      assert.deepEqual(byId[995], { contentItems: [{ type: "inputText", text: "Round r1 is working on the login fix." }], success: true }, "the reply is the host's text, not JSON");
      assert.deepEqual(byId[996], { contentItems: [{ type: "inputText", text: "Round r1 is not running." }], success: false });
      assert.equal(byId[997].success, false);
      assert.deepEqual(JSON.parse(byId[997].contentItems[0].text), { ok: false, code: "sidekick-cancelled", message: "The sidekick request was cancelled. Collect the result with wait." });
      assert.doesNotMatch(JSON.stringify(byId[997]), /raw native detail/);
      assert.equal(byId[998].success, false);
      assert.equal(JSON.parse(byId[998].contentItems[0].text).code, "invalid-sidekick-call");
      assert.deepEqual(
        calls.map((entry) => [entry.operation.op, entry.toolCallId, entry.hasSignal]).sort(),
        [["reset", "call-reset", true], ["status", "call-status", true], ["stop", "call-stop", true]],
      );
      assert.deepEqual(calls.find((entry) => entry.operation.op === "stop").operation, { op: "stop", roundId: "r1" });
      assert.deepEqual(proxied.notices(), []);
    } finally { await proxied.adapter.dispose(); }

    // The tool is off for this chat: the persisted/registered tool gets a clean refusal.
    calls.length = 0;
    const off = await openProxied(directory, { hostTools: ["board"] }, {
      callbacks: [async () => ({ ok: true }), sidekick],
      inject: [call(995, "call-off", { op: "status" })],
    });
    try {
      const [reply] = await off.replies(1);
      assert.equal(reply.result.success, false);
      assert.equal(JSON.parse(reply.result.contentItems[0].text).code, "sidekick-disabled");
      assert.deepEqual(calls, [], "a disabled sidekick never reaches the host");
    } finally { await off.adapter.dispose(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed thread keeps the sidekick only if it was started with it; otherwise a notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sidekick-"));
  // Codex 0.163 rollouts start with `session_meta` carrying the persisted dynamic tools.
  const rollout = async (name, tools) => {
    const file = join(directory, name);
    const meta = { type: "session_meta", payload: { id: "resume-fixture", base_instructions: { text: "x".repeat(30000) }, dynamic_tools: tools } };
    await writeFile(file, `${JSON.stringify(meta)}\n{"type":"turn_context","payload":{}}\n`);
    return file;
  };
  const piui = (...names) => [{ type: "namespace", name: "piui", description: "PiUI host tools for this chat.", tools: names.map((name) => ({ type: "function", name, inputSchema: { type: "object" } })) }];
  const calls = [];
  const sidekick = async (operation, context) => { calls.push({ operation, toolCallId: context.toolCallId }); return { ok: true, text: "Round r1 is working." }; };
  try {
    const withSidekick = await rollout("sidekick.jsonl", piui("board", "sidekick"));
    const kept = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sidekick"] }, {
      args: [`--rollout=${withSidekick}`],
      callbacks: [undefined, sidekick],
      inject: [{ id: 995, callId: "call-resumed", namespace: "piui", tool: "sidekick", arguments: { op: "status" } }],
    });
    try {
      const start = await kept.thread();
      assert.equal(start.method, "thread/resume");
      assert.equal(start.dynamicTools, null, "a resumed thread is never registered with new tools");
      assert.deepEqual(kept.notices(), []);
      const [reply] = await kept.replies(1);
      assert.deepEqual(reply.result, { contentItems: [{ type: "inputText", text: "Round r1 is working." }], success: true });
      assert.deepEqual(calls, [{ operation: { op: "status" }, toolCallId: "call-resumed" }]);
    } finally { await kept.adapter.dispose(); }

    // Started without the sidekick (only the board, no tools, no metadata, unreadable file): notice.
    for (const file of [await rollout("board-only.jsonl", piui("board")), await rollout("none.jsonl", []), join(directory, "missing.jsonl")]) {
      const resumed = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sidekick"] }, { args: [`--rollout=${file}`], callbacks: [undefined, sidekick] });
      try {
        assert.equal((await resumed.thread()).dynamicTools, null);
        assert.deepEqual(resumed.notices(), ["unsupported-sidekick-tool-resume"], file);
        assert.equal(resumed.adapter.snapshot().nativeId, "resume-fixture");
      } finally { await resumed.adapter.dispose(); }
    }

    // Both tools asked for on a thread that has only the board: one notice, for the sidekick.
    const board = await rollout("board-both.jsonl", piui("board"));
    const mixed = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["board", "sidekick"] }, {
      args: [`--rollout=${board}`],
      callbacks: [async () => ({ ok: true }), sidekick],
    });
    try {
      await mixed.thread();
      assert.deepEqual(mixed.notices(), ["unsupported-sidekick-tool-resume"]);
    } finally { await mixed.adapter.dispose(); }

    // A resume without a host callback reports the missing callback, not a missing rollout tool.
    const noCallback = await openProxied(directory, { nativeId: "resume-fixture", hostTools: ["sidekick"] }, { args: [`--rollout=${withSidekick}`] });
    try {
      await noCallback.thread();
      assert.deepEqual(noCallback.notices(), ["unsupported-sidekick-tool"]);
    } finally { await noCallback.adapter.dispose(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a piui/sidekick result is written through deliver exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piui-codex-sidekick-"));
  const sidekick = async (operation, context) => {
    await context.deliver({ ok: true, text: "Round r1 is working." });
    return { ok: true, text: "Round r1 is working." };
  };
  try {
    const proxied = await openProxied(directory, { hostTools: ["sidekick"] }, {
      callbacks: [undefined, sidekick],
      inject: [{ id: 995, callId: "call-status", namespace: "piui", tool: "sidekick", arguments: { op: "status" } }],
    });
    try {
      await proxied.replies(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const replies = await proxied.replies(1);
      assert.equal(replies.length, 1, "the result is not written again after deliver");
      assert.deepEqual(replies[0].result, { contentItems: [{ type: "inputText", text: "Round r1 is working." }], success: true });
    } finally { await proxied.adapter.dispose(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const waitUntil = async (predicate) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("fixture condition timed out");
};
const olderTurn = (number) => ({ id: `turn-${number}`, status: "completed", items: [
  { type: "userMessage", id: `paged-user-${number}`, content: [{ type: "text", text: `Question ${number}`, text_elements: [] }] },
  { type: "agentMessage", id: `paged-answer-${number}`, text: `Answer ${number}`, phase: null, memoryCitation: null },
] });

const textsOf = (adapter, kind) => adapter.snapshot().blocks.filter(block => block.kind === kind).map(block => block.text);

test("a resumed Codex thread opens with its newest page and reads older pages afterwards, one bounded event each", async () => {
  const { calls, openChild } = forkTransport({ pages: [undefined, { data: [olderTurn(2)], nextCursor: "page-2" }, { data: [olderTurn(1)], nextCursor: null }] });
  const events = [];
  const adapter = await createCodexAdapter({ ...config, nativeId: "source-fixture", runtimeArgs: [fixture, "--paged-history"] }, event => events.push(event), undefined, openChild);
  try {
    // Opening is not held for the older pages.
    assert.deepEqual(textsOf(adapter, "user"), ["Question 3"]);
    await waitUntil(() => calls.filter(call => call.method === "thread/turns/list").length === 2 && events.filter(event => event.type === "historyPage").length === 2);
    assert.deepEqual(calls.filter(call => call.method === "thread/turns/list").map(call => call.params), [
      { threadId: "source-fixture", sortDirection: "desc", itemsView: "full", cursor: "page-1" },
      { threadId: "source-fixture", sortDirection: "desc", itemsView: "full", cursor: "page-2" },
    ]);
    assert.deepEqual(textsOf(adapter, "user"), ["Question 1", "Question 2", "Question 3"]);
    assert.deepEqual(textsOf(adapter, "assistant"), ["Answer 1", "Answer 2", "Answer 3"]);
    // Each event holds blocks that go before everything shown, in order.
    const pages = events.filter(event => event.type === "historyPage");
    assert.deepEqual(pages.map(page => page.blocks.map(block => block.id)), [
      ["paged-user-2", "paged-answer-2"],
      ["paged-user-1", "paged-answer-1"],
    ]);
  } finally { await adapter.dispose(); }
});

test("Codex history paging is bounded and a page that cannot be read leaves the chat open with the newest turns", async () => {
  const endless = forkTransport({ sourcePage: () => ({ data: [], nextCursor: "page-1" }) });
  const bounded = await createCodexAdapter({ ...config, nativeId: "source-fixture", runtimeArgs: [fixture, "--paged-history"] }, () => {}, undefined, endless.openChild);
  try {
    await waitUntil(() => endless.calls.filter(call => call.method === "thread/turns/list").length === 49);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal(endless.calls.filter(call => call.method === "thread/turns/list").length, 49, "50 pages in total, the first one came with the resume");
    assert.deepEqual(textsOf(bounded, "user"), ["Question 3"]);
  } finally { await bounded.dispose(); }

  const failing = forkTransport({ listError: "PRIVATE_LIST_FAILURE" });
  const events = [];
  const partial = await createCodexAdapter({ ...config, nativeId: "source-fixture", runtimeArgs: [fixture, "--paged-history"] }, event => events.push(event), undefined, failing.openChild);
  try {
    await waitUntil(() => failing.calls.filter(call => call.method === "thread/turns/list").length === 1);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    assert.equal(failing.calls.filter(call => call.method === "thread/turns/list").length, 1);
    assert.deepEqual(textsOf(partial, "user"), ["Question 3"]);
    assert.ok(!events.some(event => event.type === "historyPage"), "a failed optional page adds nothing and the chat stays usable");
    assert.equal(partial.snapshot().status, "idle");
  } finally { await partial.dispose(); }
});

test("a huge history is split into frames below the bridge budget and never replaces a block shown live", async () => {
  const big = "x".repeat(900 * 1024);
  const manyTurns = Array.from({ length: 30 }, (_, index) => ({ id: `big-turn-${index}`, status: "completed", items: [
    { type: "agentMessage", id: `big-answer-${index}`, text: big, phase: null, memoryCitation: null },
  ] }));
  // The newest page's turn is also in the older page (a cursor that shifted): the shown copy wins.
  const { openChild } = forkTransport({ pages: [undefined, { data: [...manyTurns, olderTurn(3)], nextCursor: null }] });
  const events = [];
  const adapter = await createCodexAdapter({ ...config, nativeId: "source-fixture", runtimeArgs: [fixture, "--paged-history"] }, event => events.push(event), undefined, openChild);
  try {
    await waitUntil(() => events.some(event => event.type === "historyPage"));
    const frames = events.filter(event => event.type === "historyPage");
    assert.ok(frames.length > 1, "a page larger than one frame is split");
    for (const frame of frames) assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 5 * 1024 * 1024);
    assert.equal(textsOf(adapter, "assistant").filter(text => text === "Answer 3").length, 1);
    // The snapshot keeps its newest blocks within one frame behind a marker.
    const snapshot = adapter.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 16 * 1024 * 1024);
    assert.ok(snapshot.blocks.some(block => block.id === "paged-answer-3"), "the newest blocks stay");
    assert.equal(snapshot.blocks[0].id, "codex-history-omitted");
    assert.equal(snapshot.blocks[0].kind, "custom");
  } finally { await adapter.dispose(); }
});

test("a live completion that races the resume response wins over the stale history page", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, nativeId: "source-fixture", runtimeArgs: [fixture, "--resume-race"] }, event => events.push(event), undefined);
  try {
    const answer = adapter.snapshot().blocks.find(block => block.id === "race-answer");
    assert.equal(answer.text, "live final answer");
    assert.equal(answer.status, "complete");
    assert.equal(adapter.snapshot().status, "idle", "a turn completed live is not restored as the active turn");
    assert.deepEqual(events.filter(event => event.type === "turnCompleted"), [{ type: "turnCompleted", outcome: "succeeded" }]);
    await assert.rejects(adapter.interrupt(), { bridgeCode: "no-active-turn" });
  } finally { await adapter.dispose(); }
});

test("Codex refuses to branch before a message inside a turn instead of dropping that turn's earlier items", async () => {
  const turns = [
    { id: "turn-a", status: "completed", items: [
      { type: "userMessage", id: "opening-user", content: [{ type: "text", text: "Start", text_elements: [] }] },
      { type: "agentMessage", id: "answer-a", text: "Working", phase: null, memoryCitation: null },
      { type: "userMessage", id: "steer-user", content: [{ type: "text", text: "Also this", text_elements: [] }] },
      { type: "agentMessage", id: "answer-b", text: "Done", phase: null, memoryCitation: null },
    ] },
    { id: "turn-b", status: "completed", items: [
      { type: "hookPrompt", id: "hook-1", fragments: [] },
      { type: "userMessage", id: "next-user", content: [{ type: "text", text: "Next", text_elements: [] }] },
    ] },
  ];
  const steered = forkTransport({ pages: [{ data: turns, nextCursor: null }] });
  await assert.rejects(
    createCodexAdapter({ ...config, fork: { nativeId: "source-fixture", beforeBlockId: "steer-user" } }, () => {}, undefined, steered.openChild),
    { bridgeCode: "branch-unsupported", safeMessage: "This chat cannot be branched natively." },
  );
  assert.ok(!steered.calls.some(call => ["thread/start", "thread/fork"].includes(call.method)), "nothing is forked or started");

  // The opening message of a turn is an exact boundary, also after a hook prompt.
  const exact = forkTransport({ pages: [{ data: turns, nextCursor: null }], childTurns: [turns[0]] });
  const adapter = await createCodexAdapter({ ...config, fork: { nativeId: "source-fixture", beforeBlockId: "next-user" } }, () => {}, undefined, exact.openChild);
  try {
    assert.equal(exact.calls.find(call => call.method === "thread/fork").params.lastTurnId, "turn-a");
  } finally { await adapter.dispose(); }
});

test("Codex reasoning parts stay separate paragraphs and streaming matches the completed item", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--reasoning-parts"] }, event => events.push(event));
  try {
    await waitUntil(() => adapter.snapshot().blocks.find(block => block.id === "reasoning-done")?.status === "complete");
    const expected = "First part\n\nSecond\n\nRaw one\n\nRaw two";
    const text = id => adapter.snapshot().blocks.find(block => block.id === id).text;
    assert.equal(text("reasoning-open"), expected, "streamed only");
    assert.equal(text("reasoning-done"), expected, "replaced by the completed item with the same text");
    assert.equal(adapter.snapshot().blocks.find(block => block.id === "reasoning-open").status, "streaming");
    const streamed = id => events.filter(event => event.type === "textDelta" && event.blockId === id).map(event => event.text).join("");
    assert.equal(streamed("reasoning-open"), expected, "the deltas alone build the same text");
    assert.equal(streamed("reasoning-done"), expected);
  } finally { await adapter.dispose(); }
});

test("Codex emits file events for changed files, viewed and generated images and returned inline images", async () => {
  const events = [];
  const adapter = await createCodexAdapter({ ...config, runtimeArgs: [fixture, "--chat-files"] }, event => events.push(event));
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAH8wD3AAAAABJRU5ErkJggg==";
  try {
    await waitUntil(() => adapter.snapshot().blocks.some(block => block.id === "mcp-image" && block.status === "complete"));
    const cwd = process.cwd();
    assert.deepEqual(events.filter(event => event.type === "file"), [
      { type: "file", blockId: "change-ok", path: join(cwd, "added.txt"), origin: "written" },
      { type: "file", blockId: "change-ok", path: join(cwd, "moved.ts"), origin: "written" },
      { type: "file", blockId: "change-ok", path: resolve(cwd, "relative/dir/d.ts"), origin: "written" },
      { type: "file", blockId: "view-1", path: join(cwd, "shot.PNG"), origin: "read", mimeType: "image/png" },
      { type: "file", blockId: "gen-path", path: join(cwd, "fox.png"), origin: "generated", mimeType: "image/png" },
      { type: "file", blockId: "gen-inline", origin: "generated", inline: { mimeType: "image/png", base64: tinyPng } },
      { type: "file", blockId: "mcp-image", origin: "returned", inline: { mimeType: "image/png", base64: tinyPng } },
    ]);
    const block = id => adapter.snapshot().blocks.find(value => value.id === id);
    assert.deepEqual([block("gen-path").kind, block("gen-path").label, block("gen-path").toolName, block("gen-path").title, block("gen-path").status],
      ["tool", "Image generation", "image-generation", "Image generation: A red fox", "complete"]);
    assert.equal(block("gen-failed").status, "failed");
    // Paths and bytes never enter block text.
    assert.doesNotMatch(JSON.stringify(adapter.snapshot().blocks.filter(value => value.kind === "tool" && value.id !== "view-1")), /fox\.png|nope\.png|SECRET-MUST-NOT-LEAK|iVBORw0KGgo/);
  } finally { await adapter.dispose(); }
});
