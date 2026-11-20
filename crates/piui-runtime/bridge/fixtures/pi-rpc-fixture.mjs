let pending = Buffer.alloc(0);
const toolFlag = process.argv.indexOf("--tools");
const textOnly = process.argv.includes("--text-only-model");
const catalogOnly = process.argv.includes("--catalog-only-fixture");
if (catalogOnly && (!process.argv.includes("--no-session") || process.argv.includes("--session") || process.argv.includes("--session-id"))) {
  throw new Error("catalog must not restore or persist a native session");
}
let modelRequests = 0;
// A Nano session reopened without a model: Pi restored the recorded Nano model.
const restoredNano = process.argv.includes("--restored-nano-model");
const providerFlag = process.argv.indexOf("--provider");
const modelFlag = process.argv.indexOf("--model");
const chosenModel = providerFlag >= 0 && modelFlag >= 0
  ? { provider: process.argv[providerFlag + 1], id: process.argv[modelFlag + 1], name: process.argv[modelFlag + 1], input: ["text"] }
  : null;
let sessionName = process.argv.includes("--no-tools") ? "no-tools" : toolFlag >= 0 ? process.argv[toolFlag + 1] : "Fixture";
// A scenario step `{ busyProbes: n }` makes the next n `get_state` replies
// report a streaming run, like a runtime still busy after `agent_end`.
let busyProbes = 0;
const busyNow = () => { if (busyProbes <= 0) return false; busyProbes -= 1; return true; };
// The default turn's assistant message and the history entry of the same answer
// share this timestamp, the way Pi persists the message it streamed.
const ANSWER_TIMESTAMP = 1790000000123;
const write = (value, fragmented = false) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (!fragmented) process.stdout.write(bytes);
  else { process.stdout.write(bytes.subarray(0, 5)); setImmediate(() => process.stdout.write(bytes.subarray(5))); }
};

// Prompt texts that select a native event scenario instead of the default turn.
const secret = "SECRET-MUST-NOT-LEAK";
const longOutput = `${"head line\n".repeat(1200)}${"tail line\n".repeat(1200)}`;
// Both 8 KiB cut points of this output fall inside a surrogate pair.
const emojiOutput = `${"a".repeat(8191)}\u{1F600}${"b".repeat(100)}\u{1F600}${"c".repeat(8191)}`;
const tool = (type, toolCallId, toolName, fields) => ({ type, toolCallId, toolName, ...fields });
const textResult = (text) => ({ content: [{ type: "text", text }], details: { fullOutputPath: `/private/${secret}.log` } });
// The timestamp of the rich assistant message: live events and `--history-rich` entries share it.
const RICH_TIMESTAMP = 1790000000900;
// Never meant to reach a block: the streamed JSON arguments of a tool call.
const toolArgsMarker = "TOOLCALL-ARGS-MUST-NOT-BE-PROSE";
// A 1x1 PNG.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAH8wD3AAAAABJRU5ErkJggg==";
const update = (assistantMessageEvent) => ({ type: "message_update", message: { role: "assistant", timestamp: RICH_TIMESTAMP }, assistantMessageEvent });
// Session entries: a user turn, an assistant message (thinking, text, tool
// call, text), its tool result, a compaction, an abandoned branch and the
// final answer. `leafId` names the tip the active branch ends at.
const richHistory = {
  leafId: "e-answer",
  entries: [
    { id: "e-user", parentId: null, type: "message", timestamp: "2026-11-18T10:00:00.000Z", message: { role: "user", content: "do it", timestamp: 1790000000800 } },
    { id: "e-assistant", parentId: "e-user", type: "message", message: { role: "assistant", timestamp: RICH_TIMESTAMP, stopReason: "toolUse", content: [
      { type: "thinking", thinking: "plan the change" },
      { type: "text", text: "First part." },
      { type: "toolCall", id: "call-write", name: "write", arguments: { path: "notes.md", content: "x" } },
      { type: "text", text: "Second part." },
    ] } },
    { id: "e-result", parentId: "e-assistant", type: "message", message: { role: "toolResult", toolCallId: "call-write", toolName: "write", isError: false, content: [{ type: "text", text: "Wrote notes.md" }], timestamp: 1790000000950 } },
    { id: "e-compaction", parentId: "e-result", type: "compaction", summary: "SECRET-MUST-NOT-LEAK", firstKeptEntryId: "e-result", tokensBefore: 9 },
    { id: "e-abandoned", parentId: "e-user", type: "message", message: { role: "assistant", timestamp: 1790000000555, stopReason: "stop", content: [{ type: "text", text: "ABANDONED BRANCH" }] } },
    { id: "e-answer", parentId: "e-compaction", type: "message", message: { role: "assistant", timestamp: 1790000001000, stopReason: "stop", content: [{ type: "text", text: "Done." }] } },
  ],
};
// Two finished turns for branching. `--history-two-turns` serves them, and a
// successful `fork` request on a user message leaves the session as Pi would:
// a new session holding what came before that message.
const twoTurns = process.argv.includes("--history-two-turns");
const twoTurnEntries = [
  { id: "t-user-1", parentId: null, type: "message", message: { role: "user", content: "first question", timestamp: 1790000100000 } },
  { id: "t-answer-1", parentId: "t-user-1", type: "message", message: { role: "assistant", timestamp: 1790000100100, stopReason: "stop", content: [{ type: "text", text: "first answer" }] } },
  { id: "t-user-2", parentId: "t-answer-1", type: "message", message: { role: "user", content: "second question", timestamp: 1790000100200 } },
  { id: "t-answer-2", parentId: "t-user-2", type: "message", message: { role: "assistant", timestamp: 1790000100300, stopReason: "stop", content: [{ type: "text", text: "second answer" }] } },
];
let branchedBefore;
const keptEntries = () => (branchedBefore === undefined ? twoTurnEntries : twoTurnEntries.slice(0, twoTurnEntries.findIndex((entry) => entry.id === branchedBefore)));
const assistantText = (text) =>({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
// error -> agent_end(willRetry) -> retry succeeds -> final agent_end.
function retryRuns() {
  return [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" } },
    { type: "agent_end", willRetry: true },
    { type: "auto_retry_start", attempt: 1 },
    { type: "agent_start" },
    assistantText("recovered answer"),
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
  ];
}
const scenarios = {
  tools: [
    { type: "agent_start" },
    tool("tool_execution_start", "call-bash", "bash", { args: { command: "npm test\n  --silent" } }),
    tool("tool_execution_update", "call-bash", "bash", { args: { command: "npm test\n  --silent" }, partialResult: textResult("partial output") }),
    tool("tool_execution_end", "call-bash", "bash", { result: textResult(longOutput), isError: false }),
    tool("tool_execution_start", "call-read", "read", { args: { path: "src/main.rs", offset: 10 } }),
    tool("tool_execution_end", "call-read", "read", { result: { content: [{ type: "text", text: "fn main() {}" }, { type: "image", data: secret, mimeType: "image/png" }] }, isError: false }),
    tool("tool_execution_start", "call-emoji", "bash", { args: { command: "print emoji" } }),
    tool("tool_execution_end", "call-emoji", "bash", { result: textResult(emojiOutput), isError: false }),
    tool("tool_execution_start", "call-custom", "deploy", { args: { target: "staging", retries: 2, options: { token: secret } } }),
    tool("tool_execution_end", "call-custom", "deploy", { result: { content: [{ type: "text", text: "deploy failed" }] }, isError: true }),
    tool("tool_execution_start", "call-untyped", "extension_tool", { args: {} }),
    tool("tool_execution_end", "call-untyped", "extension_tool", { result: { content: null }, isError: false }),
    { type: "agent_settled" },
  ],
  compaction: [
    { type: "agent_start" },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", result: { summary: secret, tokensBefore: 10, estimatedTokensAfter: 2 }, aborted: false, willRetry: false },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false, errorMessage: `Auto-compaction failed: 429 ${secret}` },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", result: null, aborted: true, willRetry: false },
    { type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: `Context overflow recovery failed ${secret}` },
    { type: "auto_compaction_start", reason: "threshold" },
    { type: "agent_settled" },
  ],
  // One assistant message with a thinking block, two text blocks around a tool
  // call whose arguments stream as JSON, then the tool run. Its message
  // timestamp and call id match the `--history-rich` entries below.
  richlive: [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", timestamp: RICH_TIMESTAMP } },
    update({ type: "start" }),
    update({ type: "thinking_start", contentIndex: 0 }),
    update({ type: "thinking_delta", contentIndex: 0, delta: "plan the change" }),
    update({ type: "thinking_end", contentIndex: 0, content: "plan the change" }),
    update({ type: "text_start", contentIndex: 1 }),
    update({ type: "text_delta", contentIndex: 1, delta: "First part." }),
    update({ type: "text_end", contentIndex: 1, content: "First part." }),
    update({ type: "toolcall_start", contentIndex: 2 }),
    update({ type: "toolcall_delta", contentIndex: 2, delta: `{"path":"notes.md","note":"${toolArgsMarker}"}` }),
    update({ type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call-write", name: "write", arguments: { path: "notes.md" } } }),
    update({ type: "text_start", contentIndex: 3 }),
    update({ type: "text_delta", contentIndex: 3, delta: "Second part." }),
    update({ type: "text_end", contentIndex: 3, content: "Second part." }),
    update({ type: "done", reason: "toolUse" }),
    { type: "message_end", message: { role: "assistant", timestamp: RICH_TIMESTAMP, stopReason: "toolUse" } },
    tool("tool_execution_start", "call-write", "write", { args: { path: "notes.md", content: "x" } }),
    tool("tool_execution_end", "call-write", "write", { result: { content: [{ type: "text", text: "Wrote notes.md" }] }, isError: false }),
    { type: "agent_settled" },
  ],
  // A call the model was writing when the person stopped the turn never runs.
  toolcallstopped: [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", timestamp: RICH_TIMESTAMP } },
    update({ type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "call-long", name: "write", arguments: {} }] } }),
    update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"big.md"', partial: { content: [{ type: "toolCall", id: "call-long", name: "write", arguments: { path: "big.md" } }] } }),
    { type: "message_end", message: { role: "assistant", timestamp: RICH_TIMESTAMP, stopReason: "aborted" } },
    { type: "agent_settled" },
  ],
  // Pi's subagent tool: one agent, parallel tasks and a chain.
  delegations: [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", timestamp: RICH_TIMESTAMP } },
    { type: "tool_execution_start", toolCallId: "call-one", toolName: "subagent", args: { agent: "scout", task: "Find the crash" } },
    { type: "tool_execution_end", toolCallId: "call-one", toolName: "subagent", result: { content: [{ type: "text", text: "found" }] }, isError: false },
    { type: "tool_execution_start", toolCallId: "call-many", toolName: "subagent", args: { tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] } },
    { type: "tool_execution_end", toolCallId: "call-many", toolName: "subagent", result: { content: [] }, isError: false },
    { type: "tool_execution_start", toolCallId: "call-chain", toolName: "subagent", args: { chain: [{ agent: "planner", task: "a" }, { agent: "worker", task: "b" }] } },
    { type: "tool_execution_end", toolCallId: "call-chain", toolName: "subagent", result: { content: [] }, isError: false },
    { type: "message_end", message: { role: "assistant", timestamp: RICH_TIMESTAMP, stopReason: "stop" } },
    { type: "agent_settled" },
  ],
  // `text_end` content heals a dropped delta; an unknown update type is reported once.
  updatekinds: [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant", timestamp: RICH_TIMESTAMP } },
    update({ type: "text_start", contentIndex: 0 }),
    update({ type: "text_delta", contentIndex: 0, delta: "Hel" }),
    update({ type: "text_end", contentIndex: 0, content: "Hello" }),
    update({ type: "mystery_delta", contentIndex: 1, delta: toolArgsMarker }),
    update({ type: "mystery_delta", contentIndex: 1, delta: toolArgsMarker }),
    { type: "message_end", message: { role: "assistant", timestamp: RICH_TIMESTAMP, stopReason: "stop" } },
    { type: "agent_settled" },
  ],
  // Chat files: written paths, an image file read, a returned inline image,
  // and results that must stay silent (failed write, wrong type, bad base64).
  files: [
    { type: "agent_start" },
    tool("tool_execution_start", "call-w1", "write", { args: { path: "out/a.txt", content: "x" } }),
    tool("tool_execution_end", "call-w1", "write", { result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
    tool("tool_execution_start", "call-e1", "edit", { args: { path: "@src/b.ts" } }),
    tool("tool_execution_end", "call-e1", "edit", { result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
    tool("tool_execution_start", "call-w2", "write", { args: { path: "failed.txt" } }),
    tool("tool_execution_end", "call-w2", "write", { result: { content: [{ type: "text", text: "no" }] }, isError: true }),
    tool("tool_execution_start", "call-r1", "read", { args: { path: "shots/screen.PNG" } }),
    tool("tool_execution_end", "call-r1", "read", { result: { content: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }] }, isError: false }),
    tool("tool_execution_start", "call-b1", "bash", { args: { command: "render" } }),
    tool("tool_execution_end", "call-b1", "bash", { result: { content: [
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
      { type: "image", data: TINY_PNG, mimeType: "image/svg+xml" },
      { type: "image", data: "not base64!", mimeType: "image/png" },
    ] }, isError: false }),
    { type: "agent_settled" },
  ],
  surfaces: [
    { type: "agent_start" },
    { type: "extension_ui_request", id: "native-notify", method: "notify", message: "Deployed to /srv/app", notifyType: "warning" },
    { type: "extension_ui_request", id: "native-status", method: "setStatus", statusKey: "build", statusText: "Building" },
    { type: "extension_ui_request", id: "native-widget", method: "setWidget", widgetKey: "todo", widgetLines: ["a", "b"], widgetPlacement: "belowEditor", extra: secret },
    { type: "extension_ui_request", id: "native-huge", method: "setWidget", widgetKey: "huge", widgetLines: Array.from({ length: 500 }, () => "x") },
    { type: "extension_ui_request", id: "native-title", method: "setTitle", title: "PR 42" },
    { type: "extension_ui_request", id: "native-editor-text", method: "set_editor_text", text: "/review" },
    { type: "extension_ui_request", id: "native-editor", method: "editor", title: "Edit message", prefill: "feat: draft", timeout: 40 },
    { type: "agent_settled" },
  ],
  // A newer Pi: event types this adapter never saw (repeated and hostile), known
  // housekeeping events that stay silent, and a frame no handler can process.
  futureevents: [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "future_event", payload: secret },
    { type: "future_event", payload: secret },
    { type: `<script>${secret}</script>` },
    { type: "queue_update", queue: [] },
    null,
    { type: "agent_settled" },
  ],
  unknownui: [
    { type: "agent_start" },
    { type: "extension_ui_request", id: "native-custom", method: "custom", payload: secret },
    { type: "agent_settled" },
  ],
  // Pi auto-retry: the failed run ends with agent_end(willRetry:true) and a
  // second run answers. Only agent_settled (Pi >= 0.80.4) closes the turn.
  retry: [
    ...retryRuns(),
    { type: "agent_settled" },
  ],
  // The same sequence from a Pi build that predates agent_settled.
  "retry-legacy": retryRuns(),
  // A queued follow-up continues the turn after an agent_end(willRetry:false).
  continued: [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // Without agent_settled a runtime keeps working after agent_end(willRetry:false):
  // a queued continuation starts a new run a moment later.
  "late-continuation": [
    { type: "agent_start" },
    assistantText("first"),
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { pause: 100 },
    { type: "agent_start" },
    assistantText("second"),
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
  ],
  // Compaction recovery after agent_end, then the continued run.
  "compaction-recovery": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { pause: 80 },
    { type: "compaction_start", reason: "overflow" },
    { pause: 80 },
    { type: "compaction_end", reason: "overflow", result: { summary: "x" }, aborted: false, willRetry: true },
    { pause: 80 },
    { type: "agent_start" },
    assistantText("after compaction"),
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
  ],
  // No further event after agent_end, but get_state still reports a busy run
  // for two probes (no agent_settled, as on an unidentified build).
  "quiet-busy": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { busyProbes: 2 },
  ],
  // A transient error that Pi retries after a delay and then answers.
  "retry-slow": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" } },
    { type: "agent_end", willRetry: true },
    { pause: 200 },
    { type: "auto_retry_start", attempt: 1 },
    { type: "agent_start" },
    assistantText("recovered answer"),
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // Retries exhausted: the last attempt fails too.
  "retry-exhausted": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" } },
    { type: "agent_end", willRetry: true },
    { type: "auto_retry_start", attempt: 1 },
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // The local Nano relay answers in OpenAI shape; Pi surfaces its text.
  "nano-credits": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: `402: {"message":"SECRET-MUST-NOT-LEAK","type":"nano","code":"nano_credits_exhausted"}` } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  "err-quota": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 insufficient_quota: You exceeded your current quota SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  "err-model-missing": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "404 The model `chat-latest` does not exist or you do not have access to it. SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  "err-settings": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "400 Unsupported parameter: reasoning.effort is not supported with this model. SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  "err-context": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "400 maximum context length is 128000 tokens SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // What OpenAI answers when a ChatGPT sign-in is asked for an API-only model.
  "err-model-not-supported": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "400 {\"detail\":\"The 'chat-latest' model is not supported when using Codex with a ChatGPT account.\",\"code\":\"model_not_found\"} SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // The provider's code outranks its status line: a 403 that says model_not_found is not an authentication problem.
  "err-model-403": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "403 {\"error\":{\"code\":\"model_not_found\"}} SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // "billing" alone is not a quota signal.
  "err-billing-timeout": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "502 billing service connection timed out SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  // A very long single line must neither stall the bridge nor fall through to a wrong class.
  "err-long": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: `${"model ".repeat(40_000)}SECRET-MUST-NOT-LEAK` } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  "nano-plain": [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "402 SECRET-MUST-NOT-LEAK" } },
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  ],
  select: [
    { type: "agent_start" },
    { type: "extension_ui_request", id: "native-select-one", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block", "Line one\nline two"], timeout: 10000 },
    { type: "extension_ui_request", id: "native-select-two", method: "select", title: "Choose again", options: ["Allow", "Block", "Line one\nline two"] },
    { type: "extension_ui_request", id: "native-select-empty", method: "select", title: "Nothing to choose", options: [] },
  ],
};
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  let lf;
  while ((lf = pending.indexOf(0x0a)) !== -1) {
    const line = pending.subarray(0, lf); pending = pending.subarray(lf + 1);
    if (!line.length) continue;
    const request = JSON.parse(line.toString("utf8"));
    if (catalogOnly) {
      if (request.type === "get_available_models" && ++modelRequests > 1) throw new Error("duplicate model lookup");
      if (!["get_available_models", "get_commands", "get_state"].includes(request.type)) throw new Error("unexpected session request");
      if (request.type === "get_state" && process.argv.includes("--fail-state")) {
        write({ id: request.id, type: "response", command: request.type, success: false });
        continue;
      }
      // A runtime that never answers get_state: the model list it already gave must survive.
      if (request.type === "get_state" && process.argv.includes("--silent-state")) continue;
      if (request.type === "get_commands" && process.argv.includes("--fail-commands")) {
        write({ id: request.id, type: "response", command: request.type, success: false });
        continue;
      }
    }
    // Records the images a prompt carried so tests can read them back as the title.
    if (Array.isArray(request.images)) {
      sessionName = `images:${request.type}:${request.images.map((image) => `${image.type}/${image.mimeType}/${image.data}`).join(",")}`;
      write({ type: "message_start", message: { id: `user-${request.id}`, role: "user", content: [{ type: "text", text: request.message }, ...request.images] } });
    }
    if (request.type === "get_state") write({ id: request.id, type: "response", command: request.type, success: true, data: { sessionId: branchedBefore === undefined ? "native-fixture" : "native-branch", sessionFile: branchedBefore === undefined ? "host/private.jsonl" : "host/branch.jsonl", sessionName, isStreaming: busyNow(), isCompacting: false, pendingMessageCount: 0, thinkingLevel: "medium", model: chosenModel ?? (restoredNano ? { provider: "nano", id: "smart", name: "Smart", input: ["text"] } : { provider: "fixture", id: "model", name: "Fixture Model", input: textOnly ? ["text"] : ["text", "image"] }) } }, true);
    else if (request.type === "get_commands") write({ id: request.id, type: "response", command: request.type, success: true, data: { commands: [
      { name: "skill:review", description: "Review a diff", source: "skill", location: "user", path: "/home/SECRET-MUST-NOT-LEAK/skills/review/SKILL.md" },
      { name: "fix-tests", description: "Fix failing tests", source: "prompt", location: "project", path: "/home/SECRET-MUST-NOT-LEAK/prompts/fix-tests.md" },
      { name: "session-name", description: "Set or clear session name", source: "extension", path: "/home/SECRET-MUST-NOT-LEAK/ext.ts" },
      { name: "settings", source: "builtin" },
    ] } });
    else if (request.type === "get_available_models") write({ id: request.id, type: "response", command: request.type, success: true, data: { models: process.argv.includes("--catalog-many")
      ? [{ provider: "fixture", id: "alpha", name: "Alpha" }, { provider: "fixture", id: "model", name: "Fixture Model" }, { provider: "fixture", id: "zeta", name: "Zeta" }]
      : [{ provider: "fixture", id: "model", name: "Fixture Model" }] } });
    else if (request.type === "get_entries" && twoTurns) {
      const entries = keptEntries();
      write({ id: request.id, type: "response", command: request.type, success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } });
    }
    else if (request.type === "fork") {
      const entry = twoTurnEntries.find((candidate) => candidate.id === request.entryId && candidate.message.role === "user");
      if (!twoTurns || !entry || process.argv.includes("--fork-rejects")) write({ id: request.id, type: "response", command: request.type, success: false, error: "Invalid entry ID for forking SECRET-MUST-NOT-LEAK" });
      else if (process.argv.includes("--fork-cancelled")) write({ id: request.id, type: "response", command: request.type, success: true, data: { cancelled: true } });
      else { branchedBefore = entry.id; write({ id: request.id, type: "response", command: request.type, success: true, data: { text: entry.message.content, cancelled: false } }); }
    }
    else if (request.type === "get_entries" && process.argv.includes("--history-rich")) write({ id: request.id, type: "response", command: request.type, success: true, data: richHistory });
    else if (request.type === "get_entries") write({ id: request.id, type: "response", command: request.type, success: true, data: { entries: [
      { id: "entry-private", type: "message", message: { role: "user", content: "hello" } },
      ...(process.argv.includes("--history-answer") ? [{ id: "entry-answer-private", type: "message", message: { role: "assistant", timestamp: ANSWER_TIMESTAMP, stopReason: "stop", content: [{ type: "text", text: "answer" }] } }] : []),
    ] } });
    else if (request.type === "prompt" && request.message === "/skill-paths") {
      write({ id: request.id, type: "response", command: request.type, success: true, data: { disposition: "handled" } });
    }
    else if (request.type === "prompt" && scenarios[request.message]) {
      write({ id: request.id, type: "response", command: request.type, success: true });
      setTimeout(async () => {
        for (const event of scenarios[request.message]) {
          // `null` is a frame the bridge cannot process; the fixture writes it as is.
          if (event?.pause) await new Promise((resolve) => setTimeout(resolve, event.pause));
          else if (event?.busyProbes !== undefined) busyProbes = event.busyProbes;
          else write(event);
        }
      }, 30);
    } else if (request.type === "prompt") {
      write({ id: request.id, type: "response", command: request.type, success: true });
      setTimeout(() => {
        write({ type: "agent_start" });
        write({ type: "message_start", message: { role: "assistant", timestamp: ANSWER_TIMESTAMP } });
        write({ type: "message_update", message: { role: "assistant", timestamp: ANSWER_TIMESTAMP }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
        write({ type: "message_update", message: { role: "assistant", timestamp: ANSWER_TIMESTAMP }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" } });
        write({ type: "extension_ui_request", id: "native-approval-secret", method: "confirm", title: "Allow?", message: "Continue?" });
        const stopReason = request.message === "fail" || request.message === "authfail" ? "error" : request.message === "abort" ? "aborted" : "stop";
        const errorMessage = request.message === "authfail" ? "401 missing API key SECRET-MUST-NOT-LEAK" : undefined;
        write({ type: "message_end", message: { role: "assistant", stopReason, usage: {input:10,output:4,cacheRead:2,cacheWrite:0,totalTokens:14}, ...(errorMessage ? { errorMessage } : {}) } });
        write({ type: "agent_settled" });
      }, 30);
    }
    // Like real Pi RPC, `follow_up` only queues and never starts an idle run.
    else if (request.type === "follow_up") write({ id: request.id, type: "response", command: request.type, success: true });
    else if (request.type === "set_session_name") { sessionName = request.name; write({ id: request.id, type: "response", command: request.type, success: true }); }
    else if (request.type === "compact") {
      // Models an older build that reports only the start of manual compaction.
      write({ type: "compaction_start", reason: "manual" });
      write({ id: request.id, type: "response", command: request.type, success: true });
    }
    else if (request.type === "steer" || request.type === "abort" || request.type === "set_model" || request.type === "set_thinking_level") write({ id: request.id, type: "response", command: request.type, success: true, data: request.type === "set_model" ? { provider: request.provider, id: request.modelId, name: request.modelId } : undefined });
    // The session name records the last dialog reply so tests can read it back.
    else if (request.type === "extension_ui_response") sessionName = `ui:${request.cancelled ? "cancelled" : request.value ?? request.confirmed}`;
    else write({ id: request.id, type: "response", command: request.type, success: false, error: "fixture rejected secret" });
  }
});
