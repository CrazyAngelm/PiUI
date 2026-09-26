import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClaudeAdapter } from "./claude.mjs";

const fixture = fileURLToPath(new URL("./claude.test-fixture.mjs", import.meta.url));
const SUBSCRIPTION_MESSAGE = "Sign in to Claude Code with your Claude subscription. API keys and cloud providers are not used by PiUI.";
const FAST_MODE_MESSAGE = "Claude Code fast mode is not available in PiUI because it can use paid extra usage. PiUI runs Claude Code only on your base Claude subscription.";
const FAST_MODE_ACTIVE_MESSAGE = "Claude Code reported fast mode as active, so PiUI did not start the session. PiUI runs Claude Code only on your base Claude subscription.";
const EXTRA_USAGE_MESSAGE = "Claude Code started using paid extra usage, so PiUI stopped this session. PiUI runs Claude Code only on your base Claude subscription.";
// Fixture transcripts and the adapter's native history lookups stay in a
// temporary Claude config directory, never in the user's ~/.claude.
const temporary = [];
const tempDir = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temporary.push(dir); return dir; };
process.env.CLAUDE_CONFIG_DIR = tempDir("piui-claude-config-");
const projectDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
test.after(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

function setup(overrides = {}, fixtureArgs = []) {
  const dir = tempDir("piui-claude-test-");
  const recordPath = join(dir, "record.jsonl");
  const config = {
    harness: "claude-code",
    cwd: process.cwd(),
    sessionDir: dir,
    permissionMode: "native",
    runtimeProgram: process.execPath,
    runtimeArgs: [fixture, "--fixture-record", recordPath, ...fixtureArgs],
    ...overrides,
  };
  const records = () => (existsSync(recordPath) ? readFileSync(recordPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { config, records, dir };
}

// Every emitted event must match the Rust NativeEvent contract, which denies
// unknown fields and lone surrogates.
const BLOCK_KEYS = new Set(["id", "kind", "label", "status", "text", "createdAt", "parentId", "safeSummary", "title", "toolName", "collapsible", "truncated", "fallback"]);
const APPROVAL_KEYS = new Set(["id", "kind", "title", "description", "decisions", "inputLabel", "options"]);
const USAGE_KEYS = new Set(["id", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]);
const EVENT_KEYS = {
  usage: ["usage"], block: ["block"], textDelta: ["blockId", "text"], status: ["status"], approval: ["approval"],
  approvalResolved: ["requestId"], binding: ["nativeId", "nativePath"], turnCompleted: ["outcome"],
  coordinatorRequest: ["requestId", "operation"], error: ["message"],
};
const BLOCK_KINDS = new Set(["user", "assistant", "thinking", "tool", "custom", "error", "compaction", "unknown"]);
const BLOCK_STATUSES = new Set(["complete", "streaming", "failed", "interrupted"]);
function blockProblems(block) {
  const problems = [];
  for (const key of Object.keys(block)) if (!BLOCK_KEYS.has(key)) problems.push(`block.${key}`);
  if (typeof block.id !== "string" || typeof block.label !== "string") problems.push("block id/label");
  if (!BLOCK_KINDS.has(block.kind) || !BLOCK_STATUSES.has(block.status)) problems.push(`block ${block.kind}/${block.status}`);
  return problems;
}
function recorder() {
  const events = [];
  const problems = [];
  const emit = (event) => {
    events.push(event);
    const allowed = EVENT_KEYS[event?.type];
    if (!allowed) { problems.push(`unknown event ${event?.type}`); return; }
    for (const key of Object.keys(event)) if (key !== "type" && !allowed.includes(key)) problems.push(`${event.type}.${key}`);
    if (event.block) problems.push(...blockProblems(event.block));
    if (event.approval) {
      for (const key of Object.keys(event.approval)) if (!APPROVAL_KEYS.has(key)) problems.push(`approval.${key}`);
      for (const option of event.approval.options ?? []) if (Object.keys(option).sort().join(",") !== "id,label") problems.push("approval option");
    }
    if (event.usage) {
      for (const [key, value] of Object.entries(event.usage)) {
        if (!USAGE_KEYS.has(key) || (key !== "id" && (!Number.isSafeInteger(value) || value < 0))) problems.push(`usage.${key}`);
      }
    }
    // JSON.stringify escapes exactly the lone surrogates.
    if (/\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(event))) problems.push("lone surrogate");
  };
  return { events, problems, emit, of: (type) => events.filter((event) => event.type === type) };
}
function snapshotProblems(snapshot) {
  const allowed = new Set(["thinkingLevel", "serviceTier", "nativeId", "nativePath", "materialized", "title", "status", "model", "blocks", "approvals", "capabilities", "models"]);
  const problems = Object.keys(snapshot).filter((key) => !allowed.has(key));
  for (const block of snapshot.blocks) problems.push(...blockProblems(block));
  const capabilityKeys = Object.keys(snapshot.capabilities).sort().join(",");
  if (capabilityKeys !== "approvals,instructions,models,nativeSubagents,prompt,resume,toolPolicy") problems.push("capabilities");
  for (const model of [snapshot.model, ...snapshot.models].filter(Boolean)) {
    for (const key of Object.keys(model)) if (!["id", "provider", "name", "thinkingLevels"].includes(key)) problems.push(`model.${key}`);
  }
  return problems;
}
async function waitFor(predicate, message = "fixture condition timed out", ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const withTimeoutPromise = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
const argValue = (args, name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const startRecord = (records) => records().find((record) => record.kind === "start");
async function runTurn(adapter, log, text, mode = "prompt") {
  const before = log.of("turnCompleted").length;
  await adapter.prompt({ text, mode });
  await waitFor(() => log.of("turnCompleted").length > before && log.events.at(-1)?.type === "status");
}

test("catalog mode maps native models and skills, never offers fast mode, then stops the CLI", async () => {
  const { config, records } = setup({ catalogOnly: true });
  const adapter = await createClaudeAdapter(config, () => {});
  try {
    assert.deepEqual(await adapter.models(), [
      { id: "default", provider: "anthropic", name: "Default (recommended)", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "sonnet", provider: "anthropic", name: "Sonnet", thinkingLevels: ["low", "medium", "high"] },
      { id: "haiku", provider: "anthropic", name: "Haiku", thinkingLevels: [] },
    ]);
    // The native catalog reports fast support for "default"; PiUI never offers it.
    assert.deepEqual((await adapter.catalogModels()).map((model) => [model.id, model.supportsFast]), [["default", false], ["sonnet", false], ["haiku", false]]);
    assert.deepEqual(await adapter.resources(), {
      items: [
        { kind: "skill", id: "review", name: "review", enabled: true, configurable: false },
        { kind: "skill", id: "compact", name: "compact", enabled: true, configurable: false },
      ],
      warnings: [],
    });
    const start = startRecord(records);
    assert.equal(alive(start.pid), false, "the catalog process is stopped after reading");
    assert.ok(!start.args.includes("--session-id") && !start.args.includes("--resume"));
    assert.deepEqual(records().filter((record) => record.kind === "control").map((record) => record.request.subtype), ["initialize"]);
  } finally { await adapter.dispose(); }
});

test("only a Claude subscription login is accepted", async () => {
  for (const account of ["signed-out", "api-key", "console", "bearer", "helper", "bedrock", "vertex", "missing"]) {
    for (const catalogOnly of [false, true]) {
      const { config, records } = setup({ catalogOnly }, ["--fixture-account", account]);
      await assert.rejects(createClaudeAdapter(config, () => {}), (error) => {
        assert.equal(error.bridgeCode, "claude-subscription-required", account);
        assert.equal(error.safeMessage, SUBSCRIPTION_MESSAGE);
        return true;
      });
      assert.equal(alive(startRecord(records).pid), false, `${account} process stopped`);
    }
  }
  for (const account of ["subscription", "setup-token"]) {
    const { config } = setup({}, ["--fixture-account", account]);
    const adapter = await createClaudeAdapter(config, () => {});
    assert.equal((await adapter.snapshot()).status, "idle");
    await adapter.dispose();
  }
});

test("the CLI environment carries no API key, provider switch, billing override or operator credential", async () => {
  const injected = {
    ANTHROPIC_API_KEY: "SECRET-MUST-NOT-LEAK", ANTHROPIC_AUTH_TOKEN: "SECRET", ANTHROPIC_BASE_URL: "https://proxy.invalid",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.invalid", ANTHROPIC_VERTEX_PROJECT_ID: "project", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", AWS_BEARER_TOKEN_BEDROCK: "SECRET", PIUI_AGENT_API_TOKEN: "SECRET",
    PIUI_AGENT_API_PORT: "1", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3", CLAUDECODE: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\host", CLAUDE_CODE_MESSAGING_TOKEN: "SECRET", CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    CLAUDE_CODE_SESSION_ID: "host-session", CLAUDE_CODE_SSE_PORT: "12345", CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    ANTHROPIC_UNIX_SOCKET: "/tmp/proxy.sock", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: SECRET", ANTHROPIC_IDENTITY_TOKEN: "SECRET",
    CLAUDE_CODE_USE_GATEWAY: "1", CLAUDE_CODE_USE_MANTLE: "1", CLAUDE_CODE_USE_ANTHROPIC_AWS: "1", CLAUDE_CODE_EXTRA_BODY: "{}",
    CLAUDE_CODE_SUBSCRIPTION_TYPE: "max", CLAUDE_CODE_API_BASE_URL: "https://proxy.invalid", CLAUDE_CODE_DISABLE_FAST_MODE: "0",
    PIUI_FIXTURE_KEEP: "1", CLAUDE_CODE_GIT_BASH_PATH: "C:\\fixture\\bash.exe",
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  const { config, records } = setup();
  let adapter;
  try {
    adapter = await createClaudeAdapter(config, () => {});
    const start = startRecord(records);
    assert.deepEqual(start.env.filter((key) => key in injected).sort(), ["CLAUDE_CODE_DISABLE_FAST_MODE", "CLAUDE_CODE_GIT_BASH_PATH", "PIUI_FIXTURE_KEEP"], "only user configuration reaches the CLI");
    assert.equal(start.disableFastMode, "1", "PiUI disables fast mode for the whole CLI process");
    assert.ok(!start.args.includes("--bare"), "bare mode requires an API key and is never used");
    assert.ok(!start.args.includes("--permission-mode"), "native permissions keep the user's own configured mode");
    assert.deepEqual(start.args.slice(0, 11), [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--replay-user-messages", "--permission-prompt-tool", "stdio", "--session-id",
    ]);
    assert.equal(argValue(start.args, "--settings"), JSON.stringify({ fastMode: false }), "standard speed is pinned per session");
  } finally {
    await adapter?.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("permission modes map to native Claude Code modes and must be applied", async () => {
  for (const [permissionMode, native] of [["native", undefined], ["read-only", "plan"], ["workspace-write", "acceptEdits"], ["full-access", "bypassPermissions"]]) {
    const { config, records } = setup({ permissionMode });
    const adapter = await createClaudeAdapter(config, () => {});
    assert.equal(argValue(startRecord(records).args, "--permission-mode"), native);
    await adapter.dispose();
  }
  const { config } = setup({ permissionMode: "full-access" }, ["--fixture-mode-override", "default"]);
  await assert.rejects(createClaudeAdapter(config, () => {}), { bridgeCode: "unsupported-policy" });
  // `native` never overrides the user's own configured default mode.
  const configured = setup({ permissionMode: "native" }, ["--fixture-mode-override", "acceptEdits"]);
  const log = recorder();
  const adapter = await createClaudeAdapter(configured.config, log.emit);
  try {
    assert.ok(!startRecord(configured.records).args.includes("--permission-mode"));
    await adapter.prompt({ text: "approve", mode: "prompt" });
    const { approval } = await waitFor(() => log.of("approval")[0]);
    assert.deepEqual(approval.decisions, ["approve-once", "approve-session", "deny", "cancel"], "native approvals are not restricted by PiUI");
    await adapter.respond({ requestId: approval.id, decision: "deny" });
    await waitFor(() => log.of("turnCompleted").length === 1);
  } finally { await adapter.dispose(); }
});

test("session settings become native launch arguments and stay off the command line when private", async () => {
  const { config, records } = setup({
    model: { id: "sonnet", provider: "anthropic", name: "Sonnet" },
    thinkingLevel: "high",
    instructions: "Follow the assigned graph task.",
    allowedTools: ["Read", "Grep", "Agent"],
    nativeSubagents: true,
    title: "Graph step",
  });
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    const { args } = startRecord(records);
    assert.equal(argValue(args, "--model"), "sonnet");
    assert.equal(argValue(args, "--effort"), "high");
    assert.equal(argValue(args, "--tools"), "Read,Grep,Agent");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(argValue(args, "--disallowed-tools"), "mcp__*");
    assert.ok(!args.includes("--allowed-tools"), "a restriction never pre-approves tools");
    const instructionsFile = argValue(args, "--append-system-prompt-file");
    assert.equal(readFileSync(instructionsFile, "utf8"), "Follow the assigned graph task.");
    assert.ok(!args.some((value) => value.includes("Follow the assigned")));
    const snapshot = await adapter.snapshot();
    assert.deepEqual(snapshotProblems(snapshot), []);
    assert.equal(snapshot.title, "Graph step");
    assert.equal(snapshot.thinkingLevel, "high");
    assert.equal(snapshot.model.id, "sonnet");
    assert.deepEqual(snapshot.capabilities.toolPolicy, { supported: true, enforcement: "native" });
    await adapter.dispose();
    assert.equal(existsSync(instructionsFile), false, "private launch files are removed on dispose");
  } finally { await adapter.dispose(); }

  const subagentsOff = setup({ nativeSubagents: false, serviceTier: "standard" });
  const second = await createClaudeAdapter(subagentsOff.config, () => {});
  try {
    const { args } = startRecord(subagentsOff.records);
    assert.equal(argValue(args, "--disallowed-tools"), "Agent");
    assert.equal(argValue(args, "--settings"), JSON.stringify({ fastMode: false }));
    assert.equal((await second.snapshot()).serviceTier, "standard");
  } finally { await second.dispose(); }
});

test("fast mode is refused before launch and an active native fast mode stops the start", async () => {
  const fast = setup({ serviceTier: "fast", runtimeProgram: "must-not-launch" });
  await assert.rejects(createClaudeAdapter(fast.config, () => {}), (error) => {
    assert.equal(error.bridgeCode, "unsupported-settings");
    assert.equal(error.safeMessage, FAST_MODE_MESSAGE);
    return true;
  });
  assert.equal(fast.records().length, 0, "nothing spawns for a fast request");
  for (const state of ["on", "cooldown"]) {
    const active = setup({}, ["--fixture-fast-mode", state]);
    await assert.rejects(createClaudeAdapter(active.config, () => {}), (error) => {
      assert.equal(error.bridgeCode, "unsupported-policy");
      assert.equal(error.safeMessage, FAST_MODE_ACTIVE_MESSAGE);
      return true;
    });
    assert.equal(alive(startRecord(active.records).pid), false, `${state} process stopped`);
  }
  // A catalog read runs no turns, so it still lists models.
  const catalog = await createClaudeAdapter(setup({ catalogOnly: true }, ["--fixture-fast-mode", "on"]).config, () => {});
  assert.equal((await catalog.models()).length, 3);
  await catalog.dispose();
});

test("an effort environment override never wins over a PiUI effort", async () => {
  const previous = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  try {
    const explicit = setup({ thinkingLevel: "high" });
    const first = await createClaudeAdapter(explicit.config, () => {});
    assert.equal(startRecord(explicit.records).effortOverride, undefined, "an explicit effort drops the override");
    assert.equal(argValue(startRecord(explicit.records).args, "--effort"), "high");
    await first.dispose();

    const inherited = setup();
    const second = await createClaudeAdapter(inherited.config, () => {});
    try {
      assert.equal(startRecord(inherited.records).effortOverride, "low", "without a PiUI effort the user's own default stays");
      await second.setModel({ model: { id: "default", name: "Default" }, thinkingLevel: "max" });
      const starts = inherited.records().filter((record) => record.kind === "start");
      assert.equal(starts.length, 2, "the runtime setting cannot beat the override, so the CLI restarts");
      assert.equal(starts[1].effortOverride, undefined);
      assert.equal(argValue(starts[1].args, "--effort"), "max");
      assert.equal((await second.snapshot()).thinkingLevel, "max");
    } finally { await second.dispose(); }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = previous;
  }
});

test("an extended-length Windows workspace path maps to the native project directory", { skip: process.platform !== "win32" }, async () => {
  const { toNamespacedPath } = await import("node:path");
  const { config, records } = setup({ cwd: toNamespacedPath(process.cwd()) });
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    assert.equal(startRecord(records).cwd, process.cwd(), "Claude Code starts from the plain spelling");
    await runTurn(adapter, log, "hello");
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.nativePath, join(projectDir, `${snapshot.nativeId}.jsonl`));
    assert.equal(snapshot.materialized, true, "the binding names the transcript Claude Code wrote");
  } finally { await adapter.dispose(); }
});

test("unsupported or unsafe settings fail before the CLI starts", async () => {
  const cases = [
    [{ harness: "codex" }, "wrong-harness"],
    [{ permissionMode: "strict-magic" }, "unsupported-policy"],
    [{ networkAccess: true }, "unsupported-policy"],
    [{ baseInstructions: "" }, "unsupported-settings"],
    [{ resourceRules: [{ kind: "skill", id: "review", enabled: false }] }, "unsupported-resource-policy"],
    [{ thinkingLevel: "ultra" }, "unsupported-settings"],
    [{ serviceTier: "turbo" }, "unsupported-settings"],
    [{ serviceTier: "fast" }, "unsupported-settings"],
    [{ model: { id: "--dangerously-skip-permissions", name: "x" } }, "unsupported-settings"],
    [{ model: { id: "gpt-5", provider: "openai", name: "x" } }, "unsupported-settings"],
    [{ allowedTools: ["Bash(rm *)"] }, "unsupported-policy"],
    [{ allowedTools: ["mcp__docs__search"] }, "unsupported-policy"],
    [{ allowedTools: ["workspace"] }, "unsupported-policy"],
    [{ allowedTools: ["Read"], nativeSubagents: true }, "unsupported-policy"],
    [{ coordination: true, nativeSubagents: true }, "unsupported-policy"],
    [{ nativeId: "--resume" }, "invalid-session"],
  ];
  for (const [override, code] of cases) {
    const { config, records } = setup({ ...override, runtimeProgram: "must-not-launch" });
    await assert.rejects(createClaudeAdapter(config, () => {}, async () => ({})), { bridgeCode: code }, JSON.stringify(override));
    assert.equal(records().length, 0);
  }
  await assert.rejects(createClaudeAdapter({ ...setup().config, coordination: true }, () => {}), { bridgeCode: "coordinator-unavailable" });
  await assert.rejects(createClaudeAdapter({ ...setup().config, runtimeProgram: "must-not-launch" }, () => {}), { bridgeCode: "runtime-unavailable" });
  await assert.rejects(createClaudeAdapter({ ...setup().config, runtimeProgram: join(tmpdir(), "piui-missing-claude.exe"), runtimeArgs: [] }, () => {}), { bridgeCode: "native-unavailable" });
  await assert.rejects(createClaudeAdapter(setup({}, ["--fixture-bad-frame"]).config, () => {}), { bridgeCode: "invalid-native-protocol" });
  await assert.rejects(createClaudeAdapter(setup({ model: { id: "opus-legacy", name: "x" } }).config, () => {}), { bridgeCode: "model-unavailable" });
  await assert.rejects(createClaudeAdapter(setup({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "low" }).config, () => {}), { bridgeCode: "unsupported-settings" });
  await assert.rejects(createClaudeAdapter(setup({ model: { id: "sonnet", name: "Sonnet" }, serviceTier: "fast" }).config, () => {}), { bridgeCode: "unsupported-settings" });
});

test("a prompt streams into blocks, usage and exactly one successful turn", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    const initial = await adapter.snapshot();
    assert.equal(initial.status, "idle");
    assert.equal(initial.materialized, false, "a zero-turn session is an unpersisted draft");
    assert.match(initial.nativeId, /^[0-9a-f-]{36}$/);
    assert.equal(initial.nativePath, join(projectDir, `${initial.nativeId}.jsonl`));
    assert.deepEqual(log.of("binding"), [{ type: "binding", nativeId: initial.nativeId, nativePath: initial.nativePath }]);
    assert.equal(argValue(startRecord(records).args, "--session-id"), initial.nativeId);

    assert.deepEqual(await adapter.prompt({ text: "slow", mode: "prompt" }), { accepted: true });
    assert.equal(log.of("turnCompleted").length, 0, "prompt returns on acceptance, not turn end");
    await waitFor(() => log.of("turnCompleted").length === 1);
    await runTurn(adapter, log, "think");
    const snapshot = await adapter.snapshot();
    assert.deepEqual(snapshotProblems(snapshot), []);
    assert.equal(snapshot.materialized, true);
    assert.deepEqual(snapshot.blocks.map((block) => [block.kind, block.status, block.text]), [
      ["user", "complete", "slow"], ["assistant", "complete", "ack slow"],
      ["user", "complete", "think"], ["thinking", "complete", "Consider options"], ["assistant", "complete", "Hello world"],
    ]);
    assert.deepEqual(log.of("textDelta").filter((event) => event.blockId === snapshot.blocks[4].id).map((event) => event.text), ["Hello", " world"]);
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["succeeded", "succeeded"]);
    const statuses = log.events.filter((event) => ["status", "turnCompleted"].includes(event.type)).map((event) => event.status ?? event.outcome);
    assert.deepEqual(statuses, ["idle", "running", "succeeded", "idle", "running", "succeeded", "idle"]);
    const usage = log.of("usage").at(-1).usage;
    assert.deepEqual({ ...usage, id: "receipt" }, { id: "receipt", inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17 });
    const sent = records().filter((record) => record.kind === "user");
    assert.deepEqual(sent.map((record) => [record.text, record.priority, record.sessionId]), [["slow", undefined, initial.nativeId], ["think", undefined, initial.nativeId]]);
    await assert.rejects(adapter.prompt({ text: "  ", mode: "prompt" }), { bridgeCode: "invalid-request" });
    await assert.rejects(adapter.prompt({ text: "x", mode: "later" }), { bridgeCode: "invalid-request" });
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("native tool calls become bounded tool blocks without raw payloads", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await runTurn(adapter, log, "tools");
    const tools = (await adapter.snapshot()).blocks.filter((block) => block.kind === "tool");
    const [bash, read, grep, task, fetchTool, mcp, emoji] = tools;
    assert.equal(tools.length, 7);
    assert.deepEqual([bash.title, bash.toolName, bash.status, bash.truncated], ["Bash: npm test --silent", "Bash", "complete", true]);
    assert.ok(bash.text.startsWith("head line\n") && bash.text.endsWith("\ntail line"));
    assert.ok(bash.text.includes(`\n… ${24020 - 16 * 1024} characters omitted …\n`));
    assert.ok(bash.text.length <= 16 * 1024 + 64);
    assert.ok(log.events.some((event) => event.type === "block" && event.block.id === bash.id && event.block.status === "streaming"));
    assert.deepEqual([read.title, read.text, read.truncated], ["Read: src/main.rs", "fn main() {}\n[image]", false]);
    assert.deepEqual([grep.title, grep.status, grep.text, grep.safeSummary], ["Grep: TODO in src", "failed", "grep failed", "The tool failed."]);
    assert.equal(task.title, "Task: Explore code");
    assert.equal(fetchTool.title, "WebFetch: https://example.invalid/docs");
    assert.equal(mcp.title, "mcp__docs__search");
    assert.ok(emoji.truncated && emoji.text.isWellFormed(), "cuts never split a surrogate pair");
    assert.equal((await adapter.snapshot()).blocks.at(-1).text, "Done.");
    assert.doesNotMatch(JSON.stringify(log.events), /SECRET-MUST-NOT-LEAK|toolu_/);
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("tool approvals round-trip once and session approvals never persist to settings files", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  const nextApproval = async () => {
    const seen = log.of("approval").length;
    return (await waitFor(() => log.of("approval").length > seen && log.of("approval").at(-1))).approval;
  };
  const responses = () => records().filter((record) => record.kind === "permission").map((record) => record.response);
  try {
    let approvalEvent = nextApproval();
    await adapter.prompt({ text: "approve", mode: "prompt" });
    let approval = await approvalEvent;
    assert.deepEqual([approval.kind, approval.title, approval.decisions], ["command", "Run command", ["approve-once", "approve-session", "deny", "cancel"]]);
    assert.match(approval.description, /Command: rm -rf build/);
    assert.match(approval.description, /Reason: Command writes files/);
    const duplicate = await Promise.allSettled([
      adapter.respond({ requestId: approval.id, decision: "approve-once" }),
      adapter.respond({ requestId: approval.id, decision: "approve-once" }),
    ]);
    assert.deepEqual(duplicate.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(duplicate.find((result) => result.status === "rejected").reason.bridgeCode, "stale-approval");
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.deepEqual(responses()[0], { behavior: "allow", updatedInput: { command: "rm -rf build", description: "Remove build output" } });

    approvalEvent = nextApproval();
    await adapter.prompt({ text: "approve", mode: "prompt" });
    approval = await approvalEvent;
    await adapter.respond({ requestId: approval.id, decision: "approve-session" });
    await waitFor(() => log.of("turnCompleted").length === 2);
    assert.deepEqual(responses()[1].updatedPermissions, [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "session" }]);

    approvalEvent = nextApproval();
    await adapter.prompt({ text: "approve", mode: "prompt" });
    approval = await approvalEvent;
    await adapter.respond({ requestId: approval.id, decision: "deny" });
    await waitFor(() => log.of("turnCompleted").length === 3);
    assert.deepEqual(responses()[2], { behavior: "deny", message: "The user denied this action." });
    assert.equal((await adapter.snapshot()).blocks.filter((block) => block.kind === "tool").at(-1).status, "failed");

    approvalEvent = nextApproval();
    await adapter.prompt({ text: "approve-edit", mode: "prompt" });
    approval = await approvalEvent;
    assert.deepEqual([approval.kind, approval.title], ["file-change", "Edit file"]);
    assert.match(approval.description, /File: src\/app\.ts\nReplace:\nlet a = 1;\nWith:\nlet a = 2;/);
    await adapter.respond({ requestId: approval.id, decision: "cancel" });
    await waitFor(() => log.of("turnCompleted").length === 4);
    assert.deepEqual(responses()[3], { behavior: "deny", message: "The user cancelled this action.", interrupt: true });
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["succeeded", "succeeded", "succeeded", "interrupted"]);
    assert.ok(records().some((record) => record.kind === "control" && record.request.subtype === "interrupt" && record.request.cancel_queued === true));
    assert.equal((await adapter.snapshot()).approvals.length, 0);
    await assert.rejects(adapter.respond({ requestId: approval.id, decision: "deny" }), { bridgeCode: "stale-approval" });
    assert.equal((await adapter.snapshot()).status, "idle", "echoed control responses are ignored");
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("restrictive profiles can only deny approvals", async () => {
  const { config, records } = setup({ permissionMode: "workspace-write" });
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "approve", mode: "prompt" });
    const { approval } = await waitFor(() => log.of("approval")[0]);
    assert.deepEqual(approval.decisions, ["deny", "cancel"]);
    await assert.rejects(adapter.respond({ requestId: approval.id, decision: "approve-once" }), { bridgeCode: "invalid-request" });
    assert.equal((await adapter.snapshot()).approvals.length, 1, "a rejected decision keeps the request pending");
    await adapter.respond({ requestId: approval.id, decision: "deny" });
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.equal(records().find((record) => record.kind === "permission").response.behavior, "deny");
  } finally { await adapter.dispose(); }
});

test("AskUserQuestion answers carry the chosen native label and malformed requests are declined", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  const permission = (scenario) => records().find((record) => record.kind === "permission" && record.scenario === scenario)?.response;
  try {
    await adapter.prompt({ text: "ask", mode: "prompt" });
    const { approval } = await waitFor(() => log.of("approval")[0]);
    assert.deepEqual([approval.kind, approval.decisions, approval.inputLabel], ["input", ["approve-once", "deny", "cancel"], undefined]);
    assert.deepEqual(approval.options, [{ id: "option-1", label: "Postgres" }, { id: "option-2", label: "SQLite" }]);
    assert.match(approval.description, /Question: Database\nWhich database\?\nOption: Postgres — Relational/);
    for (const text of [undefined, "MySQL", "option-9"]) {
      await assert.rejects(adapter.respond({ requestId: approval.id, decision: "approve-once", text }), { bridgeCode: "invalid-response" });
    }
    await adapter.respond({ requestId: approval.id, decision: "approve-once", text: "option-2" });
    await waitFor(() => permission("ask"));
    assert.deepEqual(permission("ask").updatedInput.answers, { "Which database?": "SQLite" });
    await waitFor(() => log.of("turnCompleted").length === 1);

    await adapter.prompt({ text: "ask-multi", mode: "prompt" });
    const multi = (await waitFor(() => log.of("approval")[1])).approval;
    assert.equal(multi.options, undefined);
    assert.equal(multi.inputLabel, "Answer");
    await adapter.respond({ requestId: multi.id, decision: "approve-once", text: "Auth, Billing" });
    await waitFor(() => permission("ask-multi"));
    assert.deepEqual(permission("ask-multi").updatedInput.answers, { "Which features?": "Auth, Billing" });
    await waitFor(() => log.of("turnCompleted").length === 2);

    await adapter.prompt({ text: "ask-many", mode: "prompt" });
    await waitFor(() => permission("ask-many"));
    assert.equal(permission("ask-many").behavior, "deny");
    assert.equal(log.of("approval").length, 2, "unsupported structured input never reaches the user");
    assert.ok(log.of("error").some((event) => /one at a time/.test(event.message)));
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("a native control_cancel_request retires the pending approval", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "native-cancel", mode: "prompt" });
    const { approval } = await waitFor(() => log.of("approval")[0]);
    await waitFor(() => log.of("approvalResolved").some((event) => event.requestId === approval.id));
    await assert.rejects(adapter.respond({ requestId: approval.id, decision: "approve-once" }), { bridgeCode: "stale-approval" });
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.equal(log.of("turnCompleted")[0].outcome, "succeeded");
  } finally { await adapter.dispose(); }
});

test("interrupt aborts the native turn and reports it as interrupted", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await assert.rejects(adapter.interrupt(), { bridgeCode: "no-active-turn" });
    await adapter.prompt({ text: "wait", mode: "prompt" });
    await waitFor(() => log.of("textDelta").length > 0);
    assert.deepEqual(await adapter.interrupt(), { interrupted: true });
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.deepEqual(log.of("turnCompleted"), [{ type: "turnCompleted", outcome: "interrupted" }]);
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.blocks.find((block) => block.kind === "assistant").status, "interrupted");
    assert.equal(snapshot.blocks.some((block) => block.kind === "error"), false, "a deliberate interrupt is not an error");
    assert.equal(snapshot.blocks.some((block) => /Request interrupted/.test(block.text ?? "")), false);
    assert.deepEqual(records().find((record) => record.kind === "control" && record.request.subtype === "interrupt").request, { subtype: "interrupt", cancel_queued: true });
    await runTurn(adapter, log, "hello");
    assert.equal(log.of("turnCompleted").at(-1).outcome, "succeeded", "the next turn is not mistaken for the aborted one");
  } finally { await adapter.dispose(); }
});

test("steer is folded into the running turn at a tool boundary", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    assert.deepEqual(adapter.composerCapabilities(), { steer: true, compact: false, images: true });
    await assert.rejects(adapter.prompt({ text: "no turn", mode: "steer" }), { bridgeCode: "no-active-turn" });
    await adapter.prompt({ text: "hold-fold", mode: "prompt" });
    await waitFor(async () => (await adapter.snapshot()).blocks.some((block) => block.text === "Starting."));
    await assert.rejects(adapter.prompt({ text: "second prompt", mode: "prompt" }), { bridgeCode: "turn-active" });
    assert.deepEqual(await adapter.prompt({ text: "use a smaller change", mode: "steer" }), { accepted: true });
    await waitFor(() => log.of("turnCompleted").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["succeeded"]);
    const texts = (await adapter.snapshot()).blocks.map((block) => block.text);
    assert.deepEqual(texts, ["hold-fold", "Starting.", "use a smaller change", "folded use a smaller change"]);
    assert.equal(records().find((record) => record.kind === "user" && record.text === "use a smaller change").priority, undefined);
  } finally { await adapter.dispose(); }
});

test("a steer that misses the running turn stays part of the same admitted turn", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "hold-late", mode: "prompt" });
    await waitFor(async () => (await adapter.snapshot()).blocks.some((block) => block.text === "Starting."));
    const from = log.events.length;
    await adapter.prompt({ text: "steer: late", mode: "steer" });
    await waitFor(async () => (await adapter.snapshot()).blocks.some((block) => block.text === "ack steer: late"));
    await waitFor(() => log.of("turnCompleted").length === 1);
    const after = log.events.slice(from);
    assert.equal(after.filter((event) => event.type === "usage").length, 2, "two native runs");
    assert.deepEqual(after.filter((event) => event.type === "turnCompleted").map((event) => event.outcome), ["succeeded"]);
    const statuses = after.filter((event) => event.type === "status").map((event) => event.status);
    assert.deepEqual(statuses, ["idle"], "no idle gap before the steer ran");
    const texts = (await adapter.snapshot()).blocks.map((block) => block.text);
    assert.deepEqual(texts, ["hold-late", "Starting.", "Finished before the steer.", "steer: late", "ack steer: late"]);
  } finally { await adapter.dispose(); }
});

test("follow-ups wait for the running turn and complete in admission order", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "slow", mode: "prompt" });
    assert.deepEqual(await adapter.prompt({ text: "follow: one", mode: "follow-up" }), { accepted: true });
    assert.ok(!(await adapter.snapshot()).blocks.some((block) => block.text === "follow: one"), "shown once Claude Code takes it");
    await waitFor(() => log.of("turnCompleted").length === 2);
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["succeeded", "succeeded"]);
    const texts = (await adapter.snapshot()).blocks.map((block) => block.text);
    assert.deepEqual(texts, ["slow", "ack slow", "follow: one", "ack follow: one"]);
    assert.equal(records().find((record) => record.kind === "user" && record.text === "follow: one").priority, "later");
    const idle = log.events.filter((event) => event.type === "status" && event.status === "idle");
    assert.equal(idle.length, 2, "initial idle and the final idle only");
    await runTurn(adapter, log, "follow: idle", "follow-up");
    assert.equal(records().find((record) => record.kind === "user" && record.text === "follow: idle").priority, undefined);
  } finally { await adapter.dispose(); }
});

test("model, effort and speed changes use native runtime controls", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  const controls = () => records().filter((record) => record.kind === "control").map((record) => record.request);
  try {
    assert.deepEqual(await adapter.setModel({ model: { id: "sonnet", provider: "anthropic", name: "Sonnet" }, thinkingLevel: "high" }), {
      model: { id: "sonnet", provider: "anthropic", name: "Sonnet", thinkingLevels: ["low", "medium", "high"] },
      thinkingLevel: "high",
    });
    assert.deepEqual(controls().slice(1), [{ subtype: "set_model", model: "sonnet" }, { subtype: "apply_flag_settings", settings: { effortLevel: "high" } }]);
    const snapshot = await adapter.snapshot();
    assert.deepEqual([snapshot.model.id, snapshot.thinkingLevel], ["sonnet", "high"]);
    await assert.rejects(adapter.setModel({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "low" }), { bridgeCode: "unsupported-settings" });
    const before = controls().length;
    for (const model of [{ id: "sonnet", name: "Sonnet" }, { id: "default", name: "Default" }]) {
      await assert.rejects(adapter.setModel({ model, serviceTier: "fast" }), { bridgeCode: "unsupported-settings", safeMessage: FAST_MODE_MESSAGE });
    }
    assert.equal(controls().length, before, "a fast request never reaches Claude Code");
    await assert.rejects(adapter.setModel({ model: { id: "opus-legacy", name: "x" } }), { bridgeCode: "model-unavailable" });
    await adapter.setModel({ model: { id: "default", name: "Default" }, serviceTier: "standard" });
    assert.deepEqual(controls().slice(before), [{ subtype: "set_model", model: "default" }], "standard speed is already pinned");
    assert.equal((await adapter.snapshot()).serviceTier, "standard");
    assert.ok(!controls().some((request) => request.subtype === "apply_flag_settings" && "fastMode" in request.settings));
    assert.equal(records().filter((record) => record.kind === "start").length, 1, "no restart was needed");
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("paid extra usage stops the session at the first report", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "overage", mode: "prompt" });
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.deepEqual(log.of("turnCompleted"), [{ type: "turnCompleted", outcome: "failed" }]);
    assert.ok(log.of("error").some((event) => event.message === EXTRA_USAGE_MESSAGE));
    await waitFor(() => !alive(startRecord(records).pid));
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.blocks.find((block) => block.kind === "error").safeSummary, EXTRA_USAGE_MESSAGE);
    await assert.rejects(adapter.prompt({ text: "again", mode: "prompt" }), { bridgeCode: "not-running" });
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("effort changes restart the CLI on the same conversation when runtime settings are unavailable", async () => {
  const { config, records } = setup({}, ["--fixture-no-flag-settings"]);
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    const { nativeId } = await adapter.snapshot();
    await adapter.setModel({ model: { id: "default", name: "Default" }, thinkingLevel: "low" });
    let starts = records().filter((record) => record.kind === "start");
    assert.equal(starts.length, 2);
    assert.equal(alive(starts[0].pid), false, "the previous process ended");
    assert.equal(argValue(starts[1].args, "--session-id"), nativeId, "an unmaterialized draft keeps its id");
    assert.equal(argValue(starts[1].args, "--effort"), "low");
    await runTurn(adapter, log, "hello");
    await adapter.setModel({ model: { id: "default", name: "Default" }, thinkingLevel: "max" });
    starts = records().filter((record) => record.kind === "start");
    assert.equal(argValue(starts[2].args, "--resume"), nativeId, "a materialized conversation is resumed");
    assert.equal(argValue(starts[2].args, "--effort"), "max");
    assert.equal((await adapter.snapshot()).thinkingLevel, "max");
    await runTurn(adapter, log, "hello");
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["succeeded", "succeeded"]);
    assert.equal(log.of("error").length, 0, "a planned restart is not a failure");
    await adapter.prompt({ text: "slow", mode: "prompt" });
    await assert.rejects(adapter.setModel({ model: { id: "default", name: "Default" }, thinkingLevel: "high" }), { bridgeCode: "turn-active" });
    await waitFor(() => log.of("turnCompleted").length === 3);
  } finally { await adapter.dispose(); }
});

test("resume rebuilds the active branch of the native transcript without replay", async () => {
  const nativeId = "11111111-2222-4333-8444-555555555555";
  mkdirSync(projectDir, { recursive: true });
  const line = (value) => JSON.stringify({ sessionId: nativeId, timestamp: "2026-09-26T10:00:00.000Z", ...value });
  writeFileSync(join(projectDir, `${nativeId}.jsonl`), [
    line({ type: "summary", summary: "Old", leafUuid: "a4" }),
    line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Fix the build" } }),
    line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "Check logs", signature: "s" }] } }),
    line({ type: "assistant", uuid: "a2", parentUuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm run build" } }] } }),
    // Parallel calls: the second call chains on the first, and each result
    // hangs off its own call, so the first result sits beside the branch.
    line({ type: "assistant", uuid: "a2b", parentUuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_3", name: "Glob", input: { pattern: "src/**" } }] } }),
    line({ type: "user", uuid: "u2", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "build failed", is_error: true }] } }),
    line({ type: "user", uuid: "u2b", parentUuid: "a2b", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "src/main.rs" }] } }),
    line({ type: "user", uuid: "abandoned", parentUuid: "u2b", message: { role: "user", content: "An abandoned branch" } }),
    line({ type: "system", uuid: "c1", parentUuid: null, logicalParentUuid: "u2b", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } }),
    line({ type: "user", uuid: "s1", parentUuid: "c1", isCompactSummary: true, message: { role: "user", content: "Summary of the earlier conversation" } }),
    "{corrupted",
    line({ type: "user", uuid: "m2", parentUuid: "s1", isMeta: true, message: { role: "user", content: "<system-reminder>internal</system-reminder>" } }),
    line({ type: "user", uuid: "u3", parentUuid: "m2", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }, { type: "text", text: "Try again" }] } }),
    line({ type: "assistant", uuid: "side", parentUuid: "u3", isSidechain: true, message: { id: "ms", role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
    line({ type: "assistant", uuid: "e1", parentUuid: "u3", isApiErrorMessage: true, message: { id: "me", role: "assistant", content: [{ type: "text", text: "API Error: SECRET-MUST-NOT-LEAK" }] } }),
    line({ type: "assistant", uuid: "a4", parentUuid: "e1", message: { id: "m4", role: "assistant", content: [{ type: "text", text: "Fixed." }, { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.ts" } }] } }),
    line({ type: "file-history-snapshot", messageId: "x" }),
  ].join("\n"));
  const { config, records } = setup({ nativeId, nativePath: join(projectDir, `${nativeId}.jsonl`) });
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    const snapshot = await adapter.snapshot();
    assert.deepEqual(snapshotProblems(snapshot), []);
    assert.deepEqual([snapshot.nativeId, snapshot.materialized], [nativeId, true]);
    assert.equal(argValue(startRecord(records).args, "--resume"), nativeId);
    assert.deepEqual(snapshot.blocks.map((block) => [block.kind, block.status, block.text ?? block.safeSummary, block.title]), [
      ["user", "complete", "Fix the build", undefined],
      ["thinking", "complete", "Check logs", undefined],
      ["tool", "failed", "build failed", "Bash: npm run build"],
      ["tool", "complete", "src/main.rs", "Glob: src/**"],
      ["compaction", "complete", "Context was compacted.", undefined],
      ["user", "complete", "Try again", undefined],
      ["error", "failed", "Claude Code could not complete this turn.", undefined],
      ["assistant", "complete", "Fixed.", undefined],
      ["tool", "interrupted", undefined, "Read: a.ts"],
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET-MUST-NOT-LEAK|An abandoned branch|"subagent"|Summary of the earlier|internal</);
    assert.equal(log.of("block").length, 0, "history is part of the snapshot, not replayed as live events");
    await runTurn(adapter, log, "hello");
    assert.equal((await adapter.snapshot()).blocks.at(-1).text, "ack hello");
  } finally { await adapter.dispose(); }

  await assert.rejects(createClaudeAdapter(setup({ nativeId: "99999999-2222-4333-8444-555555555555" }).config, () => {}), { bridgeCode: "invalid-session" });
  await assert.rejects(createClaudeAdapter(setup({ nativeId, nativePath: join(tmpdir(), `${nativeId}.jsonl`) }).config, () => {}), { bridgeCode: "invalid-session" });
});

test("a conversation written by the CLI reopens with stable block ids", async () => {
  const first = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(first.config, log.emit);
  let nativeId;
  let live;
  try {
    await runTurn(adapter, log, "hello");
    ({ nativeId } = await adapter.snapshot());
    live = (await adapter.snapshot()).blocks.find((block) => block.kind === "user");
  } finally { await adapter.dispose(); }
  const reopened = await createClaudeAdapter(setup({ nativeId }).config, () => {});
  try {
    const blocks = (await reopened.snapshot()).blocks;
    assert.deepEqual(blocks.map((block) => [block.kind, block.text]), [["user", "hello"], ["assistant", "ack hello"]]);
    assert.equal(blocks[0].id, live.id, "the native message uuid keeps the user block identity");
  } finally { await reopened.dispose(); }
});

test("managed runs expose the coordinator through a session-scoped MCP endpoint", async () => {
  const calls = [];
  const { config, records } = setup({ coordination: true });
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit, async (operation, metadata) => {
    calls.push({ operation, toolCallId: metadata.toolCallId });
    if (Object.keys(operation).sort().join(",") !== "type") {
      throw Object.assign(new Error("invalid"), { bridgeCode: "invalid-coordinator-operation", safeMessage: "The coordinator operation is invalid." });
    }
    return { members: ["member-a"] };
  });
  try {
    const { args } = startRecord(records);
    const mcpConfigPath = argValue(args, "--mcp-config");
    assert.ok(existsSync(mcpConfigPath));
    assert.equal(argValue(args, "--allowed-tools"), "mcp__piui-workspace__workspace");
    assert.equal(argValue(args, "--disallowed-tools"), "Agent", "managed runs delegate through the coordinator only");
    assert.ok(!args.some((value) => /Bearer|127\.0\.0\.1/.test(value)), "the coordinator token stays off the command line");
    assert.equal((await adapter.snapshot()).capabilities.nativeSubagents.enforcement, "coordinator");
    await runTurn(adapter, log, "mcp");
    const mcp = records().find((record) => record.kind === "mcp");
    assert.deepEqual(mcp, {
      pid: mcp.pid, kind: "mcp", unauthorized: 403, protocolVersion: "2025-06-18", notification: 202, tools: ["workspace"],
      roster: JSON.stringify({ ok: true, result: { members: ["member-a"] } }),
      invalid: JSON.stringify({ ok: false, error: { code: "invalid-coordinator-operation", message: "The coordinator operation is invalid." } }),
    });
    assert.deepEqual(calls.map((call) => call.operation), [{ type: "roster" }, { type: "send", extra: true }]);
    assert.equal((await adapter.snapshot()).blocks.find((block) => block.kind === "tool").title, "mcp__piui-workspace__workspace");
    await adapter.dispose();
    assert.equal(existsSync(mcpConfigPath), false);
  } finally { await adapter.dispose(); }
});

test("an API key reported during a turn stops the session before it continues", async () => {
  const { config, records } = setup({}, ["--fixture-init-api-key"]);
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "wait", mode: "prompt" });
    await waitFor(() => log.of("turnCompleted").length === 1);
    assert.deepEqual(log.of("turnCompleted"), [{ type: "turnCompleted", outcome: "failed" }]);
    assert.ok(log.of("error").some((event) => event.message === SUBSCRIPTION_MESSAGE));
    await waitFor(() => !alive(startRecord(records).pid));
    const snapshot = await adapter.snapshot();
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.blocks.find((block) => block.kind === "error").safeSummary, SUBSCRIPTION_MESSAGE);
    await assert.rejects(adapter.prompt({ text: "again", mode: "prompt" }), { bridgeCode: "not-running" });
  } finally { await adapter.dispose(); }

  const drift = setup({ permissionMode: "read-only" }, ["--fixture-init-mode-drift"]);
  const driftLog = recorder();
  const drifted = await createClaudeAdapter(drift.config, driftLog.emit);
  try {
    await drifted.prompt({ text: "wait", mode: "prompt" });
    await waitFor(() => driftLog.of("turnCompleted").length === 1);
    assert.equal((await drifted.snapshot()).status, "failed");
  } finally { await drifted.dispose(); }
});

test("an unexpected CLI exit fails the session without inventing a turn outcome", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await adapter.prompt({ text: "crash", mode: "prompt" });
    await waitFor(() => log.of("status").some((event) => event.status === "failed"));
    assert.ok(log.of("error").some((event) => event.message === "Claude Code exited unexpectedly."));
    assert.equal(log.of("turnCompleted").length, 0, "a transport loss has no terminal proof");
  } finally { await adapter.dispose(); }
});

test("provider failures become safe error blocks and failed turns", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await runTurn(adapter, log, "fail");
    assert.deepEqual(log.of("turnCompleted").map((event) => event.outcome), ["failed"]);
    const error = (await adapter.snapshot()).blocks.find((block) => block.kind === "error");
    assert.equal(error.safeSummary, "Claude Code could not authenticate. Sign in to Claude Code with your Claude subscription again.");
    assert.ok(log.of("error").some((event) => event.message === error.safeSummary));
    assert.equal((await adapter.snapshot()).status, "idle", "a failed turn does not fail the session");
    assert.doesNotMatch(JSON.stringify(log.events), /SECRET-MUST-NOT-LEAK|Invalid API key/);
  } finally { await adapter.dispose(); }
});

test("native notices, usage limits, compaction and unknown events map to safe blocks", async () => {
  const { config } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    await runTurn(adapter, log, "notices");
    const blocks = (await adapter.snapshot()).blocks;
    const notice = blocks.find((block) => block.title === "Warning");
    assert.deepEqual([notice.kind, notice.text], ["custom", "Auto-update available."]);
    const limits = blocks.filter((block) => block.label === "Usage limit");
    assert.equal(limits.length, 1, "repeated limit reports are not duplicated");
    assert.equal(limits[0].text, `Your Claude subscription usage is close to its limit. It resets at ${new Date(1790000000 * 1000).toISOString()}.`);
    const unknown = blocks.filter((block) => block.kind === "unknown");
    assert.deepEqual(unknown.map((block) => [block.safeSummary, block.fallback]), [["Unsupported Claude Code event: future_event", true]]);
    assert.doesNotMatch(JSON.stringify(log.events), /SECRET-MUST-NOT-LEAK|SessionStart|background/);

    await runTurn(adapter, log, "compact");
    const compactions = (await adapter.snapshot()).blocks.filter((block) => block.kind === "compaction");
    assert.deepEqual(compactions.map((block) => [block.status, block.safeSummary]), [["complete", "Context was compacted."], ["complete", "Context was compacted."]]);
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("the embedded bridge source drives Claude Code through the common runner", async () => {
  // Mirrors the Rust launch: factory + runner concatenated into one ESM
  // source, delivered behind a 4-byte length prefix on stdin.
  const factory = readFileSync(new URL("./claude.mjs", import.meta.url), "utf8");
  const runner = readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
  const source = Buffer.from(`${factory}\nglobalThis.__PIUI_BRIDGE_FACTORY__=createClaudeAdapter;\n${runner}`);
  const bootstrap = "const fs=await import('node:fs');const h=Buffer.alloc(4);let o=0;while(o<4){const n=fs.readSync(0,h,o,4-o,null);if(n===0)throw new Error('bridge source EOF');o+=n}const z=h.readUInt32LE(0),b=Buffer.alloc(z);o=0;while(o<z){const n=fs.readSync(0,b,o,z-o,null);if(n===0)throw new Error('bridge source EOF');o+=n}await import('data:text/javascript;base64,'+b.toString('base64'));";
  const { spawn } = await import("node:child_process");
  const bridge = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  bridge.stderr.on("data", () => {});
  const frames = [];
  let pending = "";
  bridge.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let lf;
    while ((lf = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, lf);
      pending = pending.slice(lf + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(source.length);
  bridge.stdin.write(Buffer.concat([header, source]));
  const send = (value) => bridge.stdin.write(`${JSON.stringify(value)}\n`);
  const reply = (id) => waitFor(() => frames.find((frame) => frame.id === id), `no reply to ${id}`, 8000);
  const { config } = setup();
  try {
    send({ id: "init", method: "initialize", params: { ...config, baseInstructions: null, serviceTier: null, coordination: false, poolHost: false, catalogOnly: false } });
    assert.deepEqual(await reply("init"), { id: "init", ok: true, result: { initialized: true } });
    send({ id: "prompt", method: "prompt", params: { text: "hello", mode: "prompt" } });
    assert.deepEqual(await reply("prompt"), { id: "prompt", ok: true, result: { accepted: true } });
    await waitFor(() => frames.some((frame) => frame.event?.type === "turnCompleted"), "no terminal outcome", 8000);
    send({ id: "model", method: "setModel", params: { model: { id: "sonnet", provider: "anthropic", name: "Sonnet" }, thinkingLevel: null, serviceTier: null } });
    assert.equal((await reply("model")).ok, true);
    send({ id: "snapshot", method: "snapshot", params: {} });
    const snapshot = (await reply("snapshot")).result;
    assert.deepEqual(snapshotProblems(snapshot), []);
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["hello", "ack hello"]);
    assert.equal(snapshot.model.id, "sonnet");
    send({ id: "compact", method: "compact", params: {} });
    assert.equal((await reply("compact")).error.code, "unsupported-method");
    send({ id: "stale", method: "respond", params: { requestId: "claude-approval-9", decision: "deny", text: null } });
    assert.equal((await reply("stale")).error.code, "stale-approval");
    const outcomes = frames.filter((frame) => frame.event?.type === "turnCompleted").map((frame) => frame.event.outcome);
    assert.deepEqual(outcomes, ["succeeded"]);
  } finally {
    bridge.stdin.end();
    await withTimeoutPromise(new Promise((resolve) => bridge.once("close", resolve)), 5000);
    if (bridge.exitCode === null) bridge.kill();
  }
});
test("dispose retires pending approvals and ends the CLI", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  await adapter.prompt({ text: "approve", mode: "prompt" });
  const { approval } = await waitFor(() => log.of("approval")[0]);
  await adapter.dispose();
  assert.ok(log.of("approvalResolved").some((event) => event.requestId === approval.id));
  assert.deepEqual(log.of("status").slice(-2).map((event) => event.status), ["stopping", "closed"]);
  assert.equal(alive(startRecord(records).pid), false);
  assert.equal((await adapter.snapshot()).approvals.length, 0);
  assert.deepEqual(await adapter.dispose(), { disposed: true });
});

test("images reach Claude Code as base64 content blocks and show as markers", async () => {
  const { config, records } = setup();
  const log = recorder();
  const adapter = await createClaudeAdapter(config, log.emit);
  try {
    const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
    for (const invalid of [[{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }], [{ data: "x" }], {}, Array.from({ length: 7 }, () => png)]) {
      await assert.rejects(adapter.prompt({ text: "look", mode: "prompt", images: invalid }), { bridgeCode: "invalid-request" });
    }
    assert.equal(records().filter((record) => record.kind === "user").length, 0, "nothing was written for invalid images");
    const before = log.of("turnCompleted").length;
    await adapter.prompt({ text: "What is on this screen?", mode: "prompt", images: [png, { mimeType: "image/jpeg", data: "/9j/4A==" }] });
    await waitFor(() => log.of("turnCompleted").length > before);
    const sent = records().find((record) => record.kind === "user");
    assert.equal(sent.text, "What is on this screen?");
    assert.deepEqual(sent.images, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4A==" } },
    ]);
    const user = (await adapter.snapshot()).blocks.find((block) => block.kind === "user");
    assert.equal(user.text, "What is on this screen?\n\n[image]\n[image]");
    assert.doesNotMatch(JSON.stringify(log.events), /iVBORw0KGgo/);
    assert.deepEqual(log.problems, []);
  } finally { await adapter.dispose(); }
});

test("native slash commands keep their description and hint, and Claude has no $ skills", async () => {
  const { config } = setup();
  const adapter = await createClaudeAdapter(config, () => {});
  try {
    assert.deepEqual(adapter.composerCatalog(), {
      commands: [
        { name: "review", description: "Review code", source: "command" },
        { name: "compact", description: "Compact", source: "command" },
      ],
      skills: [],
    });
  } finally { await adapter.dispose(); }
});

test("resumed user messages list their images as markers", async () => {
  const nativeId = "22222222-2222-4333-8444-555555555555";
  mkdirSync(projectDir, { recursive: true });
  const line = (value) => JSON.stringify({ sessionId: nativeId, timestamp: "2026-09-26T10:00:00.000Z", ...value });
  writeFileSync(join(projectDir, `${nativeId}.jsonl`), [
    line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: [{ type: "text", text: "Why is this red?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "SECRET-MUST-NOT-LEAK" } }] } }),
    line({ type: "user", uuid: "u2", parentUuid: "u1", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "SECRET-MUST-NOT-LEAK" } }] } }),
  ].join("\n"));
  const { config } = setup({ nativeId, nativePath: join(projectDir, `${nativeId}.jsonl`) });
  const adapter = await createClaudeAdapter(config, () => {});
  try {
    const snapshot = await adapter.snapshot();
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["Why is this red?\n\n[image]", "[image]"]);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET-MUST-NOT-LEAK/);
  } finally { await adapter.dispose(); }
});
