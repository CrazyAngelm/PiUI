let pending = Buffer.alloc(0);
const toolFlag = process.argv.indexOf("--tools");
let sessionName = process.argv.includes("--no-tools") ? "no-tools" : toolFlag >= 0 ? process.argv[toolFlag + 1] : "Fixture";
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
  unknownui: [
    { type: "agent_start" },
    { type: "extension_ui_request", id: "native-custom", method: "custom", payload: secret },
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
    if (request.type === "get_state") write({ id: request.id, type: "response", command: request.type, success: true, data: { sessionId: "native-fixture", sessionFile: "host/private.jsonl", sessionName, isStreaming: false, thinkingLevel: "medium" } }, true);
    else if (request.type === "get_commands") write({ id: request.id, type: "response", command: request.type, success: true, data: { commands: [{ name: "skill:review", source: "skill" }] } });
    else if (request.type === "get_available_models") write({ id: request.id, type: "response", command: request.type, success: true, data: { models: [{ provider: "fixture", id: "model", name: "Fixture Model" }] } });
    else if (request.type === "get_entries") write({ id: request.id, type: "response", command: request.type, success: true, data: { entries: [{ id: "entry-private", type: "message", message: { role: "user", content: "hello" } }] } });
    else if (request.type === "prompt" && scenarios[request.message]) {
      write({ id: request.id, type: "response", command: request.type, success: true });
      setTimeout(() => { for (const event of scenarios[request.message]) write(event); }, 30);
    } else if (request.type === "prompt") {
      write({ id: request.id, type: "response", command: request.type, success: true });
      setTimeout(() => {
        write({ type: "agent_start" });
        write({ type: "message_start", message: { role: "assistant" } });
        write({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
        write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" } });
        write({ type: "extension_ui_request", id: "native-approval-secret", method: "confirm", title: "Allow?", message: "Continue?" });
        const stopReason = request.message === "fail" || request.message === "authfail" ? "error" : request.message === "abort" ? "aborted" : "stop";
        const errorMessage = request.message === "authfail" ? "401 missing API key SECRET-MUST-NOT-LEAK" : undefined;
        write({ type: "message_end", message: { role: "assistant", stopReason, usage: {input:10,output:4,cacheRead:2,cacheWrite:0,totalTokens:14}, ...(errorMessage ? { errorMessage } : {}) } });
        write({ type: "agent_settled" });
      }, 30);
    } else if (request.type === "set_session_name") { sessionName = request.name; write({ id: request.id, type: "response", command: request.type, success: true }); }
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
