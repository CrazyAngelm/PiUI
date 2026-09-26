import readline from "node:readline";
import { join } from "node:path";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let threadId = "thread-fixture";
const poolFixture = process.argv.includes("--pool");
let threadSerial = 0;
const permissionIndex = process.argv.indexOf("--expect-permission");
const expectedPermission = permissionIndex >= 0 ? process.argv[permissionIndex + 1] : "native";
const expectNetwork = process.argv.includes("--expect-network");
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
const toolItemsFixture = process.argv.includes("--tool-items");
// MCP elicitations (`mcpServer/elicitation/request`, ids 960-979). Every
// client reply is echoed back as an agent message `reply-<id>` whose text is
// the exact reply JSON, so tests can read all of them from the snapshot.
const elicitationFixture = process.argv.includes("--mcp-elicitation");
const elicitationEdgeFixture = process.argv.includes("--mcp-elicitation-edge");
const elicitationResolvedFixture = process.argv.includes("--mcp-elicitation-resolved");
const elicitationTurnFixture = process.argv.includes("--mcp-elicitation-turn");
const isElicitationReply = (message) => typeof message.id === "number" && message.id >= 960 && message.id < 980 && message.method === undefined;
const elicitation = (id, params) => send({ method: "mcpServer/elicitation/request", id, params: { threadId, turnId: "turn-approval", serverName: "docs", ...params } });
const issueForm = {
  mode: "form",
  _meta: null,
  message: "Create an issue in the docs tracker?",
  requestedSchema: {
    type: "object",
    properties: {
      title: { type: "string", title: "Title", minLength: 3, maxLength: 40 },
      priority: { type: "string", title: "Priority", oneOf: [{ const: "p1", title: "Urgent" }, { const: "p2", title: "Normal" }], default: "p2" },
      count: { type: "integer", title: "Copies", minimum: 1, maximum: 5 },
      notify: { type: "boolean", title: "Notify the team", default: false },
      contact: { type: "string", format: "email", description: "Who to ask" },
      // A computed key is an own property, as JSON.parse creates it.
      ["__proto__"]: { type: "string", title: "Prototype key" },
    },
    required: ["title", "priority"],
  },
};
// Emulated app-server version (default: the newest verified protocol). Shapes
// that changed between versions follow it; see CONTRACT.md (Codex section).
const codexVersion = process.argv.find((argument) => argument.startsWith("--codex-version="))?.slice("--codex-version=".length) ?? "0.157.1";
const [versionMajor, versionMinor] = codexVersion.split(".").map((part) => Number.parseInt(part, 10));
const protocolAtLeast = (minor) => versionMajor > 0 || versionMinor >= minor;
const timeReplies = {};
// Every verified version nests the effective ThreadSettings (`effort`, not
// `reasoningEffort`); 0.157 adds `disabledPluginIds`.
const settingsUpdated = ({ model, effort, serviceTier }) => ({ threadId, threadSettings: {
  ...(protocolAtLeast(157) ? { disabledPluginIds: [] } : {}),
  cwd: process.cwd(), approvalPolicy: "on-request", approvalsReviewer: "user",
  sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: null,
  model, modelProvider: "openai", serviceTier: serviceTier ?? null, effort: effort ?? null, summary: null,
  collaborationMode: { mode: "default", settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } },
  multiAgentMode: "explicitRequestOnly", personality: null,
} });

const permissionMatches = (params) => {
  if (expectedPermission === "native") return params.permissions === undefined && params.approvalPolicy === undefined;
  if (expectedPermission === "read-only") return params.permissions === ":read-only" && params.approvalPolicy === "never";
  if (expectedPermission === "workspace-write") return params.permissions === ":workspace" && params.approvalPolicy === "never";
  return params.permissions === ":danger-full-access" && params.approvalPolicy === "never";
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (poolFixture && message.params?.threadId) threadId = message.params.threadId;
  if (isElicitationReply(message)) {
    send({ method: "item/completed", params: { threadId, turnId: "turn-elicitation", completedAtMs: 9, item: {
      type: "agentMessage", id: `reply-${message.id}`, text: JSON.stringify("result" in message ? message.result : { error: message.error }),
      phase: null, memoryCitation: null,
    } } });
    if (message.id === 960 || message.id === 961) send({ method: "serverRequest/resolved", params: { threadId, requestId: message.id } });
    return;
  }
  if (message.method === "initialize") {
    // Real shape: `<client name>/<codex version> (<os>; <arch>) <terminal> (<client name>; <client version>)`.
    const userAgent = process.argv.includes("--raw-user-agent")
      ? codexVersion
      : `${message.params?.clientInfo?.name}/${codexVersion} (Fixture OS 1.0; x86_64) fixture-terminal (${message.params?.clientInfo?.name}; ${message.params?.clientInfo?.version})`;
    send({ id: message.id, result: { userAgent, codexHome: "/fixture", platformFamily: "fixture", platformOs: "fixture" } });
    // Observed from the real 0.157.1 app-server right after the initialize
    // response, before `initialized`: remote-control state and, for a user
    // config.toml with unrecognized keys, a configuration warning.
    if (protocolAtLeast(157)) {
      send({ method: "remoteControl/status/changed", params: { status: "disabled", serverName: "fixture", installationId: "fixture-installation", environmentId: null } });
    }
    if (process.argv.includes("--config-warning")) {
      send({ method: "configWarning", params: { summary: "PRIVATE_CONFIG_DETAIL `features.fixture` is ignored.", details: null, path: "C:\\PRIVATE_CONFIG_PATH\\config.toml" } });
    }
    if (process.argv.includes("--deprecation-notice")) {
      send({ method: "deprecationNotice", params: { summary: "PRIVATE_DEPRECATION_DETAIL", details: null } });
    }
  } else if (message.method === "initialized") {
    if (process.argv.includes("--rate-limits")) {
      send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 20 } } } });
      send({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 21 } } } });
      send({ method: "future/conversation/event", params: {} });
    }
    // MCP startup is scoped to the thread runtime (`threadId`, all verified
    // versions), so the bridge must defer these until its thread is known.
    const mcpScope = { threadId, failureReason: null };
    if (process.argv.includes("--mcp-startup")) {
      for (const status of ["starting", "ready", "failed"]) send({ method: "mcpServer/startupStatus/updated", params: { ...mcpScope, name: "fixture", status, error: "PRIVATE_MCP_DETAIL" } });
    }
    if (process.argv.includes("--mcp-recovery")) {
      for (const status of ["starting", "failed", "ready"]) send({ method: "mcpServer/startupStatus/updated", params: { ...mcpScope, name: "fixture", status, error: "PRIVATE_MCP_DETAIL" } });
    }
    if (process.argv.includes("--mcp-cancelled")) {
      for (const status of ["starting", "failed", "cancelled"]) send({ method: "mcpServer/startupStatus/updated", params: { ...mcpScope, name: "fixture", status, error: "PRIVATE_MCP_DETAIL" } });
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
    // 0.153 added `kind` ("command" | "writeStdin") to command approvals.
    const commandKind = protocolAtLeast(153) ? { kind: "command" } : {};
    send({ method: "item/commandExecution/requestApproval", id: 900, params: { ...commandKind, threadId, turnId: "turn-approval", itemId: "command-item", startedAtMs: 1, environmentId: null, command: "fixture command", cwd: "/workspace", reason: "fixture reason", networkApprovalContext: { host: "example.invalid", protocol: "https" }, additionalPermissions: { network: { enabled: true }, fileSystem: { read: [], write: ["/workspace/out"], entries: [] } }, availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["fixture", "command"] } }, "acceptForSession", "decline", "cancel"] } });
    send({ method: "item/fileChange/requestApproval", id: 901, params: { threadId, turnId: "turn-approval", itemId: "file-item", startedAtMs: 2, reason: "fixture edit" } });
    send({ method: "attestation/generate", id: 902, params: {} });
    if (process.argv.includes("--current-time")) {
      send({ method: "currentTime/read", id: 930, params: { threadId } });
      send({ method: "currentTime/read", id: 931, params: { threadId: "child-thread" } });
    }
    if (process.argv.includes("--permissions-request")) {
      send({ method: "item/permissions/requestApproval", id: 950, params: { threadId, turnId: "turn-approval", itemId: "permissions-item", environmentId: null, startedAtMs: 4, cwd: "/workspace", reason: "fixture network", permissions: { network: { enabled: true }, fileSystem: null } } });
    }
    if (process.argv.includes("--write-stdin") && protocolAtLeast(153)) {
      // write_stdin_approval: `command` is the shell-joined write request.
      send({ method: "item/commandExecution/requestApproval", id: 940, params: { kind: "writeStdin", threadId, turnId: "turn-approval", itemId: "command-item", approvalId: "stdin-call", startedAtMs: 3, environmentId: null, command: "write_stdin --session-id 7 'y'", cwd: "/workspace", availableDecisions: ["accept", "cancel"] } });
    }
    if (childEventsFixture) {
      send({ method: "thread/started", params: { thread: { id: "child-thread", path: "/fixture/child.jsonl" } } });
      send({ method: "turn/started", params: { threadId: "child-thread", turn: { id: "child-turn", status: "inProgress", items: [] } } });
      send({ method: "item/started", params: { threadId: "child-thread", turnId: "child-turn", startedAtMs: 5, item: { type: "agentMessage", id: "child-item", text: "child secret", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed", items: [] } } });
      send({ method: "item/commandExecution/requestApproval", id: 920, params: { ...commandKind, threadId: "child-thread", turnId: "child-turn", itemId: "child-command", startedAtMs: 6, environmentId: null, command: "child command", availableDecisions: ["accept", "decline", "cancel"] } });
    }
    if (elicitationFixture) {
      elicitation(960, issueForm);
      elicitation(961, {
        mode: "form",
        message: 'Allow the docs MCP server to run tool "search_docs"?',
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_title: "Search docs",
          tool_description: "Searches the docs.", tool_params: { query: "fixture", filters: { token: "SECRET-MUST-NOT-LEAK" } },
        },
      });
    }
    if (elicitationEdgeFixture) {
      elicitation(962, { mode: "url", _meta: null, message: "Sign in to docs", url: "https://example.invalid/oauth", elicitationId: "elicitation-962" });
      elicitation(963, { mode: "form", _meta: null, message: "No schema" });
      elicitation(964, { mode: "openai/userVerification", _meta: null, title: "Verify", description: "Prove it", challenge: "challenge" });
      elicitation(965, { mode: "form", _meta: null, message: "Pick files", requestedSchema: { type: "object", properties: { files: { type: "array", items: { type: "string", enum: ["a", "b"] } } }, required: ["files"] } });
      elicitation(966, { mode: "form", message: "Install a plugin?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "tool_suggestion" } });
      // A request without a mode (MCP before 2025-11-25) with an optional array.
      elicitation(967, { message: "Which branch?", requestedSchema: { type: "object", properties: {
        branch: { type: "string", enum: ["main", "dev"], enumNames: ["Main line", "Development"] },
        tags: { type: "array", items: { type: "string" } },
      } } });
      send({ method: "mcpServer/elicitation/request", id: 968, params: { threadId: "child-thread", turnId: "child-turn", serverName: "docs", mode: "form", _meta: null, message: "Child request", requestedSchema: { type: "object", properties: {} } } });
      elicitation(971, { mode: "openai/form", _meta: null, message: "Extension form", requestedSchema: { type: "object", properties: {} } });
    }
    if (elicitationResolvedFixture) {
      elicitation(969, { mode: "form", _meta: null, message: "Answered in another client", requestedSchema: { type: "object", properties: {} } });
      send({ method: "serverRequest/resolved", params: { threadId, requestId: 969 } });
    }
    if (userInputFixture) {
      send({ method: "item/tool/requestUserInput", id: 905, params: { threadId, turnId: "turn-input", itemId: "input-item", isBlocking: true, autoResolutionMs: null, questions: [{ id: "choice", header: "Choose mode", question: "Which mode should Codex use?", isOther: false, isSecret: false, options: [{ label: "Safe", description: "Use safe mode" }] }] } });
      send({ method: "item/tool/requestUserInput", id: 906, params: { threadId, turnId: "turn-input", itemId: "multi-input", isBlocking: true, autoResolutionMs: null, questions: [{ id: "one", header: "One", question: "First?", isOther: false, isSecret: false, options: null }, { id: "two", header: "Two", question: "Second?", isOther: false, isSecret: false, options: null }] } });
    }
    if (unknownItemsFixture) {
      send({ method: "item/started", params: { threadId, turnId: "turn-items", startedAtMs: 7, item: { type: "commandExecution", id: "command-display", command: "display command", cwd: process.cwd(), aggregatedOutput: "", status: "inProgress" } } });
      // ThreadItem types without a dedicated projection; 0.153 added functionCallOutput.
      for (const type of ["collabAgentToolCall", "imageView", "imageGeneration", "sleep", "subAgentActivity", "hookPrompt", ...(protocolAtLeast(153) ? ["functionCallOutput"] : [])]) {
        send({ method: "item/started", params: { threadId, turnId: "turn-items", startedAtMs: 8, item: { type, id: `unsupported-${type}`, status: "inProgress" } } });
      }
      send({ method: "item/started", params: { threadId, turnId: "turn-items", startedAtMs: 8, item: {
        type: "webSearch",
        id: "web-search-item",
        query: "latest fixture news",
        action: { type: "search" },
        results: [{ title: "Fixture result", secret: "SECRET-MUST-NOT-LEAK" }],
        status: "inProgress",
      } } });
    }
    if (toolItemsFixture) {
      const secret = "SECRET-MUST-NOT-LEAK";
      const item = (method, value) => send({ method, params: { threadId, turnId: "turn-tools", item: value } });
      const mcp = {
        type: "mcpToolCall", id: "mcp-item", server: "docs", tool: "search_docs",
        arguments: { query: "fixture", limit: 3, filters: { token: secret } },
        appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: true, result: null, error: null, durationMs: null,
      };
      item("item/started", { ...mcp, status: "inProgress" });
      send({ method: "item/mcpToolCall/progress", params: { threadId, turnId: "turn-tools", itemId: "mcp-item", message: "Searching" } });
      item("item/completed", { ...mcp, status: "completed", durationMs: 12, result: {
        content: [{ type: "text", text: "found 3 docs" }, { type: "image", data: secret, mimeType: "image/png" }],
        structuredContent: { token: secret },
        _meta: { token: secret },
      } });
      item("item/completed", { ...mcp, id: "mcp-failed", status: "failed", error: { message: "docs server unavailable" } });
      const dynamic = {
        type: "dynamicToolCall", id: "dynamic-item", namespace: "workspace", tool: "spawn_agent",
        arguments: { profileId: "reviewer", name: "Helper", instructions: "Review\nthe change" },
        contentItems: null, success: null, durationMs: null,
      };
      item("item/started", { ...dynamic, status: "inProgress" });
      item("item/completed", { ...dynamic, status: "completed", success: true, durationMs: 5, contentItems: [
        { type: "inputText", text: "x".repeat(20000) },
        { type: "inputImage", imageUrl: `data:image/png;base64,${secret}` },
      ] });
      item("item/completed", {
        ...dynamic, id: "dynamic-denied", namespace: null, tool: "send",
        arguments: { recipientMemberId: "member", body: "hi" },
        status: "completed", success: false, durationMs: 1,
        contentItems: [{ type: "inputText", text: "{\"ok\":false}" }],
      });
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
  } else if (message.id === 930 || message.id === 931) {
    const now = Math.floor(Date.now() / 1000);
    timeReplies[message.id] = Number.isSafeInteger(message.result?.currentTimeAt)
      && Math.abs(message.result.currentTimeAt - now) <= 5
      && Object.keys(message.result).join(",") === "currentTimeAt" ? "ok" : "invalid";
    if (timeReplies[930] && timeReplies[931]) send({ method: "thread/name/updated", params: { threadId, threadName: `time:${timeReplies[930]},${timeReplies[931]}` } });
  } else if (message.id === 950) {
    const granted = message.result?.scope === "session" && message.result?.permissions?.network?.enabled === true;
    send({ method: "serverRequest/resolved", params: { threadId, requestId: 950 } });
    send({ method: "thread/name/updated", params: { threadId, threadName: `permissions:${granted ? "session" : "other"}` } });
  } else if (message.id === 940 && message.result?.decision === "accept") {
    send({ method: "serverRequest/resolved", params: { threadId, requestId: 940 } });
    send({ method: "thread/name/updated", params: { threadId, threadName: "stdin:accept" } });
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
    if (expectNetwork && (
      message.params.sandboxPolicy?.type !== "workspaceWrite"
      || message.params.sandboxPolicy?.networkAccess !== true
      || !message.params.sandboxPolicy?.writableRoots?.includes(process.cwd())
    )) {
      send({ id: message.id, error: { code: -32602, message: "network sandbox policy not forwarded" } }); return;
    }
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
    if (elicitationTurnFixture) {
      elicitation(970, { turnId: "turn-fixture", mode: "form", _meta: null, message: "Continue the search?", requestedSchema: { type: "object", properties: {} } });
    }
    if (!holdTurnFixture) {
      const requestedText = message.params.input?.[0]?.text;
      // `rateLimitExceeded` and `misalignmentPolicyViolation` are 0.153+ error infos.
      const failureInfo = { "fail fixture": "unauthorized", "rate limit fixture": "rateLimitExceeded", "policy fixture": "misalignmentPolicyViolation" }[requestedText];
      const finalStatus = failureInfo ? "failed" : "completed";
      send({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: {inputTokens:10,outputTokens:4,cachedInputTokens:2,totalTokens:14} } } });
      if (process.argv.includes("--external-settings")) {
        // Settings changed by another client of the same thread.
        send({ method: "thread/settings/updated", params: settingsUpdated({ model: "fixture-model-2", effort: "high", serviceTier: "fast" }) });
      }
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn-fixture", status: finalStatus, items: [], ...(failureInfo ? { error: { message: "raw fixture secret", codexErrorInfo: failureInfo, additionalDetails: "raw fixture detail" } } : {}) } } });
    }
  } else if (message.method === "thread/unsubscribe") {
    send({id:message.id,result:{status:'unsubscribed'}});
  } else if (message.method === "skills/list") {
    send({ id: message.id, result: { data: [{ skills: [{ name: "Review", path: "/skills/review/SKILL.md", enabled: false }] }] } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { mcp_servers: { docs: { enabled: true, env: { TOKEN: "SECRET-MUST-NOT-LEAK" } } } } } });
  } else if (message.method === "mcpServerStatus/list") {
    send({ id: message.id, result: { data: [{ name: "docs", tools: { search_docs: { name: "Search docs" } } }], nextCursor: null } });
  } else if (message.method === "model/list") {
    if (holdModelFixture) return;
    if (process.argv.includes("--missing-current-model")) { send({ id: message.id, result: { data: [], nextCursor: null } }); return; }
    if (process.argv.includes("--hidden-current-model")) {
      const data = message.params.includeHidden ? [
        { id: "fixture-model", displayName: "Hidden current", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }] },
        { id: "other-hidden", hidden: true },
      ] : [];
      send({ id: message.id, result: { data, nextCursor: null } }); return;
    }
    send({ id: message.id, result: { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture Model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null } });
  } else if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId, turn: { id: "compact-fixture", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, item: { id: "compact-item", type: "contextCompaction" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "compact-fixture", status: "completed" } } });
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
  } else if (message.method === "thread/settings/update" || message.method === "thread/name/set" || message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (message.method === "thread/settings/update") send({ method: "thread/settings/updated", params: settingsUpdated({ model: message.params.model, effort: message.params.effort, serviceTier: message.params.serviceTier }) });
    if (message.method === "thread/name/set") send({ method: "thread/name/updated", params: { threadId, threadName: message.params.name } });
    if (message.method === "turn/interrupt" && holdTurnFixture) send({ method: "turn/completed", params: { threadId, turn: { id: "turn-fixture", status: "interrupted", items: [] } } });
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "fixture unsupported" } });
  }
});
