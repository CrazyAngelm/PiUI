let pending = Buffer.alloc(0);
const toolFlag = process.argv.indexOf("--tools");
let sessionName = process.argv.includes("--no-tools") ? "no-tools" : toolFlag >= 0 ? process.argv[toolFlag + 1] : "Fixture";
const write = (value, fragmented = false) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (!fragmented) process.stdout.write(bytes);
  else { process.stdout.write(bytes.subarray(0, 5)); setImmediate(() => process.stdout.write(bytes.subarray(5))); }
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
    else if (request.type === "prompt") {
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
    else if (request.type === "abort" || request.type === "set_model" || request.type === "set_thinking_level") write({ id: request.id, type: "response", command: request.type, success: true, data: request.type === "set_model" ? { provider: request.provider, id: request.modelId, name: request.modelId } : undefined });
    else if (request.type === "extension_ui_response") {}
    else write({ id: request.id, type: "response", command: request.type, success: false, error: "fixture rejected secret" });
  }
});
