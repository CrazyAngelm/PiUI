import readline from "node:readline";
import { join } from "node:path";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadId = "thread-fixture";
const poolFixture = process.argv.includes("--pool");
let threadSerial = 0;
const permissionIndex = process.argv.indexOf("--expect-permission");
const expectedPermission = permissionIndex >= 0 ? process.argv[permissionIndex + 1] : "native";
const coordinatorFixture = process.argv.includes("--coordinator");
const activeResumeFixture = process.argv.includes("--active-resume");
const holdTurnFixture = process.argv.includes("--hold-turn");
const childEventsFixture = process.argv.includes("--child-events");
const systemErrorFixture = process.argv.includes("--system-error");
const holdModelFixture = process.argv.includes("--hold-model");
const effectivePermissionMismatch = process.argv.includes("--effective-permission-mismatch");
const badFrame = process.argv.find((argument) => argument.startsWith("--bad-frame="))?.slice("--bad-frame=".length);
const userInputFixture = process.argv.includes("--user-input");
const settingsIndex = process.argv.indexOf("--expect-settings");
const expectedSettings = settingsIndex >= 0 ? JSON.parse(process.argv[settingsIndex + 1]) : undefined;
const unknownItemsFixture = process.argv.includes("--unknown-items");

const permissionMatches = (params) => {
  if (expectedPermission === "native") return params.permissions === undefined && params.approvalPolicy === undefined;
  if (expectedPermission === "read-only") return params.permissions === ":read-only" && params.approvalPolicy === "never";
  if (expectedPermission === "workspace-write") return params.permissions === ":workspace" && params.approvalPolicy === "never";
  return params.permissions === ":danger-full-access" && params.approvalPolicy === "never";
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (poolFixture && message.params?.threadId) threadId = message.params.threadId;
  if (message.method === "initialize") {
    const userAgent = process.argv.includes("--wrong-version") ? "fixture/0.148.0" : "fixture/0.147.0";
    send({ id: message.id, result: { userAgent, codexHome: "/fixture", platformFamily: "fixture", platformOs: "fixture" } });
  } else if (message.method === "initialized") {
    if (process.argv.includes("--mcp-startup")) {
      for (const status of ["starting", "ready", "failed"]) send({ method: "mcpServer/startupStatus/updated", params: { name: "fixture", status, error: "PRIVATE_MCP_DETAIL" } });
    }
    // Handshake notification has no response.
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    if (expectedSettings && (message.params.serviceTier !== expectedSettings.tier || message.params.config?.["mcp_servers.example.enabled"] !== false || message.params.config?.["skills.config"]?.[0]?.enabled !== false)) {
      send({ id: message.id, error: { code: -32602, message: "settings not forwarded" } }); return;
    }
    if (poolFixture && message.method === "thread/start") threadId = `thread-${++threadSerial}`;
    if (badFrame) {
      process.stdout.write(badFrame === "syntax" ? "{invalid\n" : badFrame === "null" ? "null\n" : "{}\n");
      return;
    }
    if (
      !permissionMatches(message.params)
      || (message.method === "thread/start" && "cwd" in message.params)
      || (message.method === "thread/resume" && (
        message.params.cwd !== process.cwd()
        || "ephemeral" in message.params
        || message.params.excludeTurns !== true
        || message.params.initialTurnsPage?.sortDirection !== "desc"
        || message.params.initialTurnsPage?.itemsView !== "full"
      ))
    ) {
      send({ id: message.id, error: { code: -32602, message: "permission or pagination fixture mismatch" } });
      return;
    }
    if (message.method === "thread/resume") threadId = message.params.threadId;
    const turns = activeResumeFixture && message.method === "thread/resume"
      ? [{ id: "active-resumed-turn", status: "inProgress", items: [] }]
      : [];
    const threadStatus = systemErrorFixture ? { type: "systemError" } : turns.length ? { type: "active", activeFlags: [] } : { type: "idle" };
    send({ method: "thread/started", params: { thread: { id: threadId, path: "/fixture/thread.jsonl", status: threadStatus } } });
    const effectiveSandbox = effectivePermissionMismatch
      ? { type: "readOnly", networkAccess: false }
      : expectedPermission === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : expectedPermission === "workspace-write"
          ? { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
          : expectedPermission === "full-access"
            ? { type: "dangerFullAccess" }
            : { type: "readOnly", networkAccess: false };
    send({ id: message.id, result: {
      thread: { id: threadId, path: "/fixture/thread.jsonl", status: threadStatus, turns: message.method === "thread/resume" ? [] : turns },
      initialTurnsPage: message.method === "thread/resume" ? { data: turns, nextCursor: null, backwardsCursor: null } : null,
      model: "fixture-model",
      modelProvider: "openai",
      cwd: process.argv.includes("--wrong-cwd") ? join(process.cwd(), "another-workspace")
        : process.argv.includes("--plain-cwd") ? process.cwd().slice(4) : process.cwd(),
      sandbox: effectiveSandbox,
      activePermissionProfile: expectedPermission === "native" ? null : { id: expectedPermission === "read-only" ? ":read-only" : expectedPermission === "workspace-write" ? ":workspace" : ":danger-full-access" },
      approvalPolicy: expectedPermission === "native" ? "on-request" : "never",
    } });
    send({ method: "item/started", params: { threadId, turnId: "turn-approval", startedAtMs: 1, item: { type: "fileChange", id: "file-item", changes: [{ path: "/workspace/file.txt", kind: { type: "update", move_path: null }, diff: "+fixture" }], status: "inProgress" } } });
    send({ method: "item/fileChange/patchUpdated", params: { threadId, turnId: "turn-approval", itemId: "file-item", changes: [{ path: "/workspace/file.txt", kind: { type: "update", move_path: null }, diff: "+updated" }] } });
    send({ method: "item/commandExecution/requestApproval", id: 900, params: { threadId, turnId: "turn-approval", itemId: "command-item", startedAtMs: 1, environmentId: null, command: "fixture command", cwd: "/workspace", reason: "fixture reason", networkApprovalContext: { host: "example.invalid", protocol: "https" }, additionalPermissions: { network: { enabled: true }, fileSystem: { read: [], write: ["/workspace/out"], entries: [] } }, availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: { command: ["fixture", "command"] } } }, "acceptForSession", "decline", "cancel"] } });
    send({ method: "item/fileChange/requestApproval", id: 901, params: { threadId, turnId: "turn-approval", itemId: "file-item", startedAtMs: 2, reason: "fixture edit" } });
    send({ method: "attestation/generate", id: 902, params: {} });
    if (childEventsFixture) {
      send({ method: "thread/started", params: { thread: { id: "child-thread", path: "/fixture/child.jsonl" } } });
      send({ method: "turn/started", params: { threadId: "child-thread", turn: { id: "child-turn", status: "inProgress", items: [] } } });
      send({ method: "item/started", params: { threadId: "child-thread", turnId: "child-turn", startedAtMs: 5, item: { type: "agentMessage", id: "child-item", text: "child secret", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed", items: [] } } });
      send({ method: "item/commandExecution/requestApproval", id: 920, params: { threadId: "child-thread", turnId: "child-turn", itemId: "child-command", startedAtMs: 6, environmentId: null, command: "child command", availableDecisions: ["accept", "decline", "cancel"] } });
    }
    if (userInputFixture) {
      send({ method: "item/tool/requestUserInput", id: 905, params: { threadId, turnId: "turn-input", itemId: "input-item", isBlocking: true, autoResolutionMs: null, questions: [{ id: "choice", header: "Choose mode", question: "Which mode should Codex use?", isOther: false, isSecret: false, options: [{ label: "Safe", description: "Use safe mode" }] }] } });
      send({ method: "item/tool/requestUserInput", id: 906, params: { threadId, turnId: "turn-input", itemId: "multi-input", isBlocking: true, autoResolutionMs: null, questions: [{ id: "one", header: "One", question: "First?", isOther: false, isSecret: false, options: null }, { id: "two", header: "Two", question: "Second?", isOther: false, isSecret: false, options: null }] } });
    }
    if (unknownItemsFixture) {
      send({ method: "item/started", params: { threadId, turnId: "turn-items", startedAtMs: 7, item: { type: "commandExecution", id: "command-display", command: "display command", cwd: process.cwd(), aggregatedOutput: "", status: "inProgress" } } });
      for (const type of ["mcpToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration"]) {
        send({ method: "item/started", params: { threadId, turnId: "turn-items", startedAtMs: 8, item: { type, id: `unsupported-${type}`, status: "inProgress" } } });
      }
    }
    if (coordinatorFixture) {
      const tools = message.params.dynamicTools?.[0]?.tools?.map((tool) => tool.name).sort();
      if (
        message.params.dynamicTools?.[0]?.name !== "workspace"
        || tools?.join(",") !== "observe,roster,send,spawn,spawn_agent,wait"
        || message.params.config?.["features.multi_agent"] !== false
        || message.params.config?.["features.multi_agent_v2"] !== false
      ) {
        send({ id: 903, error: { code: -32602, message: "workspace tools missing" } });
      } else {
        send({ method: "item/tool/call", id: 910, params: { threadId, turnId: "turn-coordinator", callId: "call-roster", namespace: "workspace", tool: "roster", arguments: {} } });
        send({ method: "item/tool/call", id: 911, params: { threadId, turnId: "turn-coordinator", callId: "call-invalid", namespace: "workspace", tool: "send", arguments: { recipientMemberId: "member", body: "hi", extra: true } } });
      }
    }
  } else if (message.id === 900 && message.result?.decision === "accept") {
    send({ method: "serverRequest/resolved", params: { threadId, requestId: 900 } });
    send({ method: "thread/name/updated", params: { threadId, threadName: "command:accept" } });
  } else if (message.id === 901 && message.result?.decision === "cancel") {
    send({ method: "serverRequest/resolved", params: { threadId, requestId: 901 } });
    send({ method: "thread/name/updated", params: { threadId, threadName: "file:cancel" } });
  } else if (message.id === 902 && message.error?.code === -32601) {
    send({ method: "warning", params: { threadId, message: "unsupported request rejected" } });
  } else if (message.id === 920 && message.result?.decision === "cancel") {
    send({ method: "thread/name/updated", params: { threadId, threadName: "child:cancelled" } });
  } else if (message.id === 905 && message.result?.answers?.choice?.answers?.[0] === "Safe") {
    send({ method: "serverRequest/resolved", params: { threadId, requestId: 905 } });
    send({ method: "thread/name/updated", params: { threadId, threadName: "input:ok" } });
  } else if (message.id === 906 && message.result?.answers?.one?.answers?.length === 0 && message.result?.answers?.two?.answers?.length === 0) {
    send({ method: "thread/name/updated", params: { threadId, threadName: "multi:declined" } });
  } else if (message.id === 910 && message.result?.success === true && JSON.parse(message.result.contentItems?.[0]?.text || "{}").ok === true) {
    send({ method: "thread/name/updated", params: { threadId, threadName: "coordinator:ok" } });
  } else if (message.id === 911 && message.result?.success === false) {
    send({ method: "warning", params: { threadId, message: "invalid coordinator call rejected" } });
  } else if (message.method === "turn/start") {
    if (expectedSettings && (message.params.serviceTier !== expectedSettings.tier || message.params.effort !== "low")) {
      send({ id: message.id, error: { code: -32602, message: "turn settings not forwarded" } }); return;
    }
    if (poolFixture && message.params.input?.[0]?.text === 'crash fixture') { process.exit(1); }
    const responseText = poolFixture ? message.params.input?.[0]?.text : "hello";
    send({ id: message.id, result: { turn: { id: "turn-fixture", status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId, turn: { id: "turn-fixture", status: "inProgress", items: [] } } });
    send({ method: "item/started", params: { threadId, turnId: "turn-fixture", startedAtMs: 3, item: { type: "agentMessage", id: "agent-fixture", text: "", phase: null, memoryCitation: null } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-fixture", itemId: "agent-fixture", delta: responseText } });
    send({ method: "item/completed", params: { threadId, turnId: "turn-fixture", completedAtMs: 4, item: { type: "agentMessage", id: "agent-fixture", text: responseText, phase: null, memoryCitation: null } } });
    if (!holdTurnFixture) {
      const requestedText = message.params.input?.[0]?.text;
      const finalStatus = requestedText === "fail fixture" ? "failed" : "completed";
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn-fixture", status: finalStatus, items: [], ...(finalStatus === "failed" ? { error: { message: "raw fixture secret", codexErrorInfo: "unauthorized", additionalDetails: "raw fixture detail" } } : {}) } } });
    }
  } else if (message.method === "thread/unsubscribe") {
    send({id:message.id,result:{status:'unsubscribed'}});
  } else if (message.method === "model/list") {
    if (holdModelFixture) return;
    send({ id: message.id, result: { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture Model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null } });
  } else if (message.method === "thread/settings/update" || message.method === "thread/name/set" || message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (message.method === "thread/settings/update") send({ method: "thread/settings/updated", params: { threadId, model: message.params.model, reasoningEffort: message.params.effort, serviceTier: message.params.serviceTier } });
    if (message.method === "thread/name/set") send({ method: "thread/name/updated", params: { threadId, threadName: message.params.name } });
    if (message.method === "turn/interrupt" && holdTurnFixture) send({ method: "turn/completed", params: { threadId, turn: { id: "turn-fixture", status: "interrupted", items: [] } } });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "fixture unsupported" } });
  }
});
