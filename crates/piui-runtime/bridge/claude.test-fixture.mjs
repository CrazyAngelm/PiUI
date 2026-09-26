// Fake Claude Code CLI for adapter tests. It emulates the headless stream-json
// and control protocol of Claude Code 2.1.232 (command lifecycle
// acknowledgements, user message replays, queue priorities, interrupts with
// cancel_queued and can_use_tool approvals) without any model or network use.
// Fixture options use the --fixture- prefix and precede the real CLI flags.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const has = (name) => argv.includes(name);
const FIXTURE_OPTIONS_WITH_VALUES = new Set(["--fixture-record", "--fixture-account", "--fixture-mode-override", "--fixture-fast-mode"]);
const cliArgs = [];
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith("--fixture-")) cliArgs.push(argv[index]);
  else if (FIXTURE_OPTIONS_WITH_VALUES.has(argv[index])) index += 1;
}
const recordPath = option("--fixture-record");
const record = (value) => { if (recordPath) appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`); };
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const permissionMode = option("--permission-mode") ?? "default";
const resumeId = option("--resume");
const sessionId = resumeId ?? option("--session-id") ?? randomUUID();
let model = option("--model") ?? "default";
const accounts = {
  subscription: { email: "fixture@example.test", subscriptionType: "Claude Max", apiProvider: "firstParty" },
  "setup-token": { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
  "signed-out": { tokenSource: "none", apiProvider: "firstParty" },
  "api-key": { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
  console: { subscriptionType: "Claude API", apiKeySource: "/login managed key", apiProvider: "firstParty" },
  bearer: { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" },
  helper: { tokenSource: "apiKeyHelper", apiProvider: "firstParty" },
  bedrock: { apiProvider: "bedrock" },
  vertex: { apiProvider: "vertex" },
};
const accountName = option("--fixture-account") ?? "subscription";
const models = [
  { value: "default", resolvedModel: "claude-opus-4-8", displayName: "Default (recommended)", description: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "Haiku" },
  { value: "opus-legacy", resolvedModel: "claude-opus-4-1", displayName: "Unavailable", description: "", disabled: true },
  { value: "--dangerously-skip-permissions", displayName: "Injected", description: "" },
];
const resolved = (value) => models.find((entry) => entry.value === value)?.resolvedModel ?? value;

record({
  kind: "start",
  args: cliArgs,
  cwd: process.cwd(),
  env: Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE|AWS_BEARER_TOKEN_BEDROCK$|PIUI_AGENT_API_|PIUI_FIXTURE_)/i.test(key)),
  // Values of PiUI's own speed and effort controls only; never credentials.
  disableFastMode: process.env.CLAUDE_CODE_DISABLE_FAST_MODE,
  effortOverride: process.env.CLAUDE_CODE_EFFORT_LEVEL,
});

// Native transcript, written only under a test-provided CLAUDE_CONFIG_DIR.
const configHome = process.env.CLAUDE_CONFIG_DIR;
const transcript = configHome ? join(configHome, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) : undefined;
let lastEntry = null;
const writeTranscript = (entry) => {
  if (!transcript) return;
  mkdirSync(join(transcript, ".."), { recursive: true });
  const uuid = entry.uuid ?? randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ parentUuid: lastEntry, sessionId, timestamp: "2026-09-26T10:00:00.000Z", ...entry, uuid })}\n`);
  lastEntry = uuid;
};

const queue = [];
const permissionWaiters = new Map();
let run = null;
let requestSerial = 0;

const lifecycle = (uuid, state) => send({ type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionId });
const ok = (requestId, response = {}) => send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
const refuse = (requestId, error) => send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });
const stream = (event) => send({ type: "stream_event", event, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId });
const assistant = (id, content, extra = {}) => {
  send({ type: "assistant", message: { id, type: "message", role: "assistant", model: resolved(model), content }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), ...extra });
  writeTranscript({ type: "assistant", message: { id, role: "assistant", content } });
};
const toolResult = (toolUseId, content, isError = false) => {
  const message = { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] };
  send({ type: "user", message, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  writeTranscript({ type: "user", message });
};
const streamText = (messageId, chunks, type = "text") => {
  stream({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [] } });
  stream({ type: "content_block_start", index: 0, content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } });
  for (const chunk of chunks) stream({ type: "content_block_delta", index: 0, delta: type === "text" ? { type: "text_delta", text: chunk } : { type: "thinking_delta", thinking: chunk } });
  stream({ type: "content_block_stop", index: 0 });
};
const say = (messageId, text) => {
  streamText(messageId, [text]);
  assistant(messageId, [{ type: "text", text }]);
};
const useTool = (toolUseId, name, input) => {
  const messageId = `msg-${toolUseId}`;
  stream({ type: "message_start", message: { id: messageId, type: "message", role: "assistant", content: [] } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name, input: {} } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  stream({ type: "content_block_stop", index: 0 });
  assistant(messageId, [{ type: "tool_use", id: toolUseId, name, input }]);
};
const askPermission = (request) => new Promise((resolve) => {
  const requestId = `perm-${++requestSerial}`;
  permissionWaiters.set(requestId, resolve);
  send({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", ...request } });
  if (run) run.permissionRequestId = requestId;
});
const until = async (predicate) => {
  while (!predicate()) {
    if (run?.aborted) return false;
    await wait(5);
  }
  return true;
};

const scenarios = {
  async hello(current) {
    say("msg-hello", `ack ${current.text}`);
  },
  async think() {
    streamText("msg-think", ["Consider", " options"], "thinking");
    assistant("msg-think", [{ type: "thinking", thinking: "Consider options", signature: "sig" }]);
    stream({ type: "message_start", message: { id: "msg-answer", type: "message", role: "assistant", content: [] } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } });
    stream({ type: "content_block_stop", index: 0 });
    assistant("msg-answer", [{ type: "text", text: "Hello world" }]);
  },
  async tools() {
    useTool("toolu_bash", "Bash", { command: "npm test --silent", description: "Run tests" });
    toolResult("toolu_bash", `head line\n${"x".repeat(24000)}\ntail line`);
    useTool("toolu_read", "Read", { file_path: "src/main.rs" });
    toolResult("toolu_read", [{ type: "text", text: "fn main() {}" }, { type: "image", source: { type: "base64", data: "SECRET-MUST-NOT-LEAK" } }]);
    useTool("toolu_grep", "Grep", { pattern: "TODO", path: "src" });
    toolResult("toolu_grep", "grep failed", true);
    useTool("toolu_task", "Task", { description: "Explore code", prompt: "SECRET-MUST-NOT-LEAK" });
    // Subagent frames carry parent_tool_use_id and stay out of the root timeline.
    send({ type: "assistant", message: { id: "msg-sub", role: "assistant", content: [{ type: "text", text: "subagent SECRET-MUST-NOT-LEAK" }] }, parent_tool_use_id: "toolu_task", session_id: sessionId, uuid: randomUUID() });
    toolResult("toolu_task", "explored");
    useTool("toolu_fetch", "WebFetch", { url: "https://example.invalid/docs", prompt: "Summarize" });
    toolResult("toolu_fetch", "fetched");
    useTool("toolu_mcp", "mcp__docs__search", { query: "fixture", token: "SECRET-MUST-NOT-LEAK" });
    toolResult("toolu_mcp", "found");
    useTool("toolu_emoji", "Bash", { command: "echo emoji" });
    toolResult("toolu_emoji", "😀".repeat(20000));
    say("msg-done", "Done.");
  },
  async approve(current) {
    const input = { command: "rm -rf build", description: "Remove build output" };
    useTool("toolu_rm", "Bash", input);
    const response = await askPermission({
      tool_name: "Bash", display_name: "Bash", input, tool_use_id: "toolu_rm", description: "Remove build output",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "localSettings" }],
      decision_reason: "Command writes files",
    });
    record({ kind: "permission", scenario: current.text, response });
    if (response?.behavior === "allow") toolResult("toolu_rm", "removed");
    else toolResult("toolu_rm", response?.message ?? "denied", true);
    if (response?.interrupt) { current.aborted = true; return; }
    say("msg-after", "Finished.");
  },
  async "approve-edit"(current) {
    const input = { file_path: "src/app.ts", old_string: "let a = 1;", new_string: "let a = 2;" };
    useTool("toolu_edit", "Edit", input);
    const response = await askPermission({ tool_name: "Edit", input, tool_use_id: "toolu_edit", permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    record({ kind: "permission", scenario: current.text, response });
    toolResult("toolu_edit", response?.behavior === "allow" ? "edited" : "denied", response?.behavior !== "allow");
    // A deny with interrupt aborts the native turn.
    if (response?.interrupt) current.aborted = true;
  },
  async ask(current) {
    const input = { questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded" }] }] };
    useTool("toolu_ask", "AskUserQuestion", input);
    const response = await askPermission({ tool_name: "AskUserQuestion", input, tool_use_id: "toolu_ask" });
    record({ kind: "permission", scenario: current.text, response });
    toolResult("toolu_ask", response?.behavior === "allow" ? JSON.stringify(response.updatedInput.answers) : "declined", response?.behavior !== "allow");
  },
  async "ask-multi"(current) {
    const input = { questions: [{ question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Auth", description: "" }, { label: "Billing", description: "" }] }] };
    const response = await askPermission({ tool_name: "AskUserQuestion", input, tool_use_id: "toolu_multi" });
    record({ kind: "permission", scenario: current.text, response });
  },
  async "ask-many"(current) {
    const question = (text) => ({ question: text, header: "Q", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] });
    const response = await askPermission({ tool_name: "AskUserQuestion", input: { questions: [question("First?"), question("Second?")] }, tool_use_id: "toolu_many" });
    record({ kind: "permission", scenario: current.text, response });
  },
  async "native-cancel"(current) {
    useTool("toolu_cancelled", "Bash", { command: "sleep 100" });
    void askPermission({ tool_name: "Bash", input: { command: "sleep 100" }, tool_use_id: "toolu_cancelled" });
    await wait(30);
    // A hook resolved the request first: the CLI withdraws its prompt.
    send({ type: "control_cancel_request", request_id: current.permissionRequestId });
    toolResult("toolu_cancelled", "resolved by hook");
  },
  async wait(current) {
    stream({ type: "message_start", message: { id: "msg-wait", type: "message", role: "assistant", content: [] } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } });
    await until(() => false);
    assistant("msg-wait", [{ type: "text", text: "Working" }], { aborted: true });
    send({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
    current.aborted = true;
  },
  async slow(current) {
    await wait(120);
    say("msg-slow", `ack ${current.text}`);
  },
  async "hold-fold"(current) {
    say("msg-before", "Starting.");
    await until(() => queue.some((item) => item.priority !== "later"));
    // Mid-turn fold at a tool boundary: consumed, acknowledged and replayed.
    const steer = queue.splice(queue.findIndex((item) => item.priority !== "later"), 1)[0];
    current.batch.push(steer.uuid);
    lifecycle(steer.uuid, "started");
    send({ type: "user", message: { role: "user", content: steer.text }, parent_tool_use_id: null, session_id: sessionId, uuid: steer.uuid, isReplay: true });
    say("msg-folded", `folded ${steer.text}`);
  },
  async "hold-late"() {
    say("msg-before", "Starting.");
    // The steer arrives, but the turn ends before another tool boundary.
    await until(() => queue.some((item) => item.priority !== "later"));
    say("msg-final", "Finished before the steer.");
  },
  async fail(current) {
    assistant("msg-fail", [{ type: "text", text: "Invalid API key · SECRET-MUST-NOT-LEAK" }], { error: "authentication_failed" });
    current.apiErrorStatus = 401;
    current.isError = true;
  },
  async compact() {
    send({ type: "system", subtype: "status", status: "compacting", uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 }, uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "status", status: null, uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 2000 }, uuid: randomUUID(), session_id: sessionId });
    say("msg-compact", "Compacted.");
  },
  async notices() {
    send({ type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart", hook_event: "SessionStart", uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "SessionStart", hook_event: "SessionStart", output: "SECRET-MUST-NOT-LEAK", stdout: "", stderr: "", outcome: "success", uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "task_started", task_id: "t1", description: "background", uuid: randomUUID(), session_id: sessionId });
    send({ type: "system", subtype: "informational", content: "Auto-update available.", level: "warning", uuid: randomUUID(), session_id: sessionId });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, uuid: randomUUID(), session_id: sessionId });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1790000000, utilization: 0.9 }, uuid: randomUUID(), session_id: sessionId });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1790000000, utilization: 0.95 }, uuid: randomUUID(), session_id: sessionId });
    send({ type: "future_event", payload: "SECRET-MUST-NOT-LEAK" });
    send({ type: "future_event", payload: "again" });
    send({ type: "keep_alive" });
    send({ type: "tool_progress", tool_use_id: "x", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30, heartbeat: true, uuid: randomUUID(), session_id: sessionId });
    say("msg-notices", "Noted.");
  },
  async mcp() {
    const config = JSON.parse(readFileSync(option("--mcp-config"), "utf8")).mcpServers["piui-workspace"];
    const call = (body, headers = config.headers) => fetch(config.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const denied = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
    const initialized = await (await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })).json();
    const notification = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    const roster = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "workspace", arguments: { type: "roster" } } })).json();
    const invalid = await (await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace", arguments: { type: "send", extra: true } } })).json();
    record({
      kind: "mcp",
      unauthorized: denied.status,
      protocolVersion: initialized.result?.protocolVersion,
      notification: notification.status,
      tools: listed.result?.tools?.map((tool) => tool.name),
      roster: roster.result?.content?.[0]?.text,
      invalid: invalid.result?.isError === true ? invalid.result.content[0].text : "accepted",
    });
    useTool("toolu_workspace", "mcp__piui-workspace__workspace", { type: "roster" });
    toolResult("toolu_workspace", roster.result.content);
    say("msg-mcp", "Coordinated.");
  },
  async crash() {
    process.exit(3);
  },
  async overage(current) {
    stream({ type: "message_start", message: { id: "msg-overage", type: "message", role: "assistant", content: [] } });
    // The subscription limit is exhausted and the account allows extra usage.
    send({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", overageStatus: "allowed", isUsingOverage: true, rateLimitType: "five_hour", resetsAt: 1790000000 },
      uuid: randomUUID(), session_id: sessionId,
    });
    await until(() => false);
    current.aborted = true;
  },
};

const startRun = async (batch) => {
  const [first] = batch;
  const current = { batch: batch.map((item) => item.uuid), text: first.text, aborted: false, isError: false, apiErrorStatus: undefined };
  run = current;
  for (const uuid of current.batch) lifecycle(uuid, "started");
  const initOverride = has("--fixture-init-api-key") ? "ANTHROPIC_API_KEY" : "none";
  send({
    type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId, apiKeySource: initOverride, cwd: process.cwd(),
    tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task"], mcp_servers: [], model: resolved(model),
    permissionMode: has("--fixture-init-mode-drift") ? "default" : permissionMode, slash_commands: ["review"], output_style: "default",
    skills: [], plugins: [], capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"], claude_code_version: "2.1.232",
  });
  for (const item of batch) {
    send({ type: "user", message: { role: "user", content: item.text }, parent_tool_use_id: null, session_id: sessionId, uuid: item.uuid, isReplay: true });
    writeTranscript({ type: "user", uuid: item.uuid, message: { role: "user", content: item.text } });
  }
  const scenario = scenarios[first.text] ?? scenarios.hello;
  await scenario(current);
  const failed = current.aborted || current.isError;
  send({
    type: "result", subtype: current.aborted ? "error_during_execution" : "success", is_error: failed, duration_ms: 5, duration_api_ms: 4,
    num_turns: 1, result: current.aborted ? undefined : "done", session_id: sessionId, uuid: randomUUID(), total_cost_usd: 0.01,
    ...(current.apiErrorStatus ? { api_error_status: current.apiErrorStatus } : {}),
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    ...(!current.aborted && current.batch.length ? { user_message_uuid: current.batch.at(-1) } : {}),
    permission_denials: [], modelUsage: {},
  });
  for (const uuid of current.batch) lifecycle(uuid, current.aborted ? "cancelled" : "completed");
  run = null;
  drain();
};
const drain = () => {
  if (run || queue.length === 0) return;
  const rank = (item) => (item.priority === "now" ? 0 : item.priority === "later" ? 2 : 1);
  const best = Math.min(...queue.map(rank));
  const next = queue.splice(queue.findIndex((item) => rank(item) === best), 1)[0];
  void startRun([next]);
};

const initializeResponse = () => ({
  commands: [{ name: "review", description: "Review code", argumentHint: "" }, { name: "compact", description: "Compact", argumentHint: "" }, { name: 7 }],
  agents: [{ name: "Explore", description: "Explore the codebase" }],
  output_style: "default",
  available_output_styles: ["default"],
  models,
  ...(accountName === "missing" ? {} : { account: accounts[accountName] }),
  pid: process.pid,
  current_permission_mode: option("--fixture-mode-override") ?? (permissionMode === "manual" ? "default" : permissionMode),
  fast_mode_state: option("--fixture-fast-mode") ?? "off",
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (has("--fixture-bad-frame") && line.includes("initialize")) { process.stdout.write("{not json\n"); return; }
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    record({ kind: "control-response", response: message.response });
    // Replay mode echoes PiUI's own replies back on stdout.
    send(message);
    const waiter = permissionWaiters.get(message.response.request_id);
    if (waiter) { permissionWaiters.delete(message.response.request_id); waiter(message.response.response); }
    return;
  }
  if (message.type === "control_request") {
    const { request_id: requestId, request } = message;
    record({ kind: "control", request });
    if (request.subtype === "initialize") {
      send({ type: "system", subtype: "hook_started", hook_id: "startup", hook_name: "SessionStart", hook_event: "SessionStart", uuid: randomUUID(), session_id: sessionId });
      ok(requestId, initializeResponse());
    } else if (request.subtype === "interrupt") {
      const cancelled = request.cancel_queued ? queue.splice(0).map((item) => item.uuid) : [];
      for (const uuid of cancelled) lifecycle(uuid, "cancelled");
      ok(requestId, request.cancel_queued ? { still_queued: [], cancelled: [...(run?.batch ?? []), ...cancelled] } : { still_queued: queue.map((item) => item.uuid) });
      if (run) run.aborted = true;
    } else if (request.subtype === "set_model") {
      if (models.some((entry) => entry.value === request.model && !entry.disabled)) { model = request.model; ok(requestId); }
      else refuse(requestId, "set_model: unknown model");
    } else if (request.subtype === "apply_flag_settings") {
      if (has("--fixture-no-flag-settings")) refuse(requestId, "Unsupported control request subtype: apply_flag_settings");
      else ok(requestId);
    } else refuse(requestId, `Unsupported control request subtype: ${request.subtype}`);
    return;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    const text = Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : String(content);
    const images = Array.isArray(content) ? content.filter((part) => part.type === "image") : [];
    record({ kind: "user", uuid: message.uuid, priority: message.priority, text, sessionId: message.session_id, ...(images.length ? { images } : {}) });
    lifecycle(message.uuid, "queued");
    queue.push({ uuid: message.uuid, text, priority: message.priority ?? "next" });
    drain();
  }
});
input.on("close", () => process.exit(0));
