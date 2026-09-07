// Codex app-server adapter. All implementation bindings stay factory-local so
// this source can be concatenated with the common embedded runner.
export async function createCodexAdapter(config, emit, coordinatorRequest, openChild) {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");

  const fail = (code, message) => {
    const error = new Error(message);
    error.bridgeCode = code;
    error.safeMessage = message;
    return error;
  };
  if (
    config?.harness !== "codex"
    || typeof config.cwd !== "string"
    || !path.isAbsolute(config.cwd)
    || typeof config.runtimeProgram !== "string"
    || config.runtimeProgram.length === 0
    || !Array.isArray(config.runtimeArgs)
  ) {
    throw fail("invalid-config", "The Codex runtime configuration is invalid.");
  }
  if (!new Set(["native", "read-only", "workspace-write", "full-access"]).has(config.permissionMode)) {
    throw fail("unsupported-permission-mode", "The requested Codex permission mode is not supported.");
  }
  if (Array.isArray(config.allowedTools)) {
    throw fail("unsupported-tool-policy", "Codex cannot enforce the requested tool allowlist.");
  }
  if (config.nativePath && !config.nativeId) {
    throw fail("unsupported-native-reference", "Codex requires a native thread ID to resume.");
  }
  const coordinationEnabled = config.coordination === true;
  if (coordinationEnabled && typeof coordinatorRequest !== "function") {
    throw fail("coordinator-unavailable", "The managed Codex coordinator is unavailable.");
  }
  if (coordinationEnabled && config.nativeId) {
    throw fail("unsupported-coordinator-resume", "Codex 0.147.0 cannot re-register the managed workspace tool while resuming.");
  }
  if (coordinationEnabled && config.nativeSubagents === true) {
    throw fail("unsupported-managed-native-subagents", "Managed Codex runs use coordinator-only spawning and cannot also enable native subagents.");
  }
  if (config.nativeSubagents === true) {
    throw fail("unsupported-native-subagent-policy", "Codex cannot prove that native subagents are enabled for this session.");
  }

  const MAX_FRAME_BYTES = 32 * 1024 * 1024;
  const pending = new Map();
  const pendingApprovals = new Map();
  const pendingCoordinatorCalls = new Map();
  const completedTurnOutcomes = new Set();
  const reportedTurnErrors = new Set();
  const blocks = new Map();
  let requestSerial = 0;
  let blockSerial = 0;
  let approvalSerial = 0;
  const deferredNativeMessages = [];
  let startingTurn = false;
  let interruptStartingTurn = false;
  let stdoutBuffer = Buffer.alloc(0);
  let status = "starting";
  let disposed = false;
  let nativeStopSettled = false;
  let nativeId = typeof config.nativeId === "string" ? config.nativeId : undefined;
  const resumingNativeThread = nativeId !== undefined;
  let bindingPublished = false;
  let materialized = false;
  let nativePath = typeof config.nativePath === "string" ? config.nativePath : undefined;
  let title = typeof config.title === "string" ? config.title : "Codex session";
  let activeTurnId;
  let lastCompletedTurnId;
  let currentModel = config.model && typeof config.model.id === "string"
    ? { id: config.model.id, provider: config.model.provider, name: config.model.name || config.model.id }
    : undefined;
  let thinkingLevel = typeof config.thinkingLevel === "string" ? config.thinkingLevel : undefined;
  let currentProvider = currentModel?.provider;
  let modelCatalog = [];
  const modelDefaults = new Map();
  let serviceTier = config.serviceTier;

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    emit({ type: "status", status: next });
  };
  const publishBinding = () => {
    if (bindingPublished || !nativeId) return;
    bindingPublished = true;
    emit({ type: "binding", nativeId, ...(nativePath ? { nativePath } : {}) });
  };
  const writeNative = async (value) => {
    if (disposed || !child.stdin.writable) {
      throw fail("native-closed", "The Codex app server is closed.");
    }
    const frame = `${JSON.stringify(value)}\n`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        child.stdin.off("close", onClose);
        if (error) reject(fail("native-closed", "The Codex app server is closed."));
        else resolve();
      };
      const onClose = () => finish(new Error("closed"));
      child.stdin.once("close", onClose);
      try {
        child.stdin.write(frame, (error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  };
  const callNative = (method, params = {}) => {
    const id = `piui-${++requestSerial}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      writeNative({ method, id, params }).catch((error) => {
        pending.delete(id);
        reject(error);
      });
    });
  };
  const notifyNative = (method, params) => writeNative(
    params === undefined ? { method } : { method, params },
  );
  const safeNativeError = () => fail(
    "native-operation-failed",
    "The Codex app server could not complete the request.",
  );
  const mapStatus = (value) => {
    if (value === "inProgress") return "streaming";
    if (value === "failed") return "failed";
    if (value === "interrupted" || value === "declined") return "interrupted";
    return "complete";
  };
  const safeCodexErrorMessage = (error) => {
    const info = error?.codexErrorInfo;
    const tag = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
    const detail = tag && typeof info?.[tag] === "object" ? info[tag] : undefined;
    const httpStatus = Number.isInteger(detail?.httpStatusCode) ? detail.httpStatusCode : undefined;
    if (tag === "unauthorized" || httpStatus === 401 || httpStatus === 403) return "Codex authentication is unavailable.";
    if (tag === "usageLimitExceeded" || tag === "sessionBudgetExceeded" || httpStatus === 429) return "A Codex usage limit prevents this turn.";
    if (tag === "contextWindowExceeded") return "This Codex thread exceeds the model context window.";
    if (["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(tag)) {
      return httpStatus && httpStatus >= 500 ? "The Codex model provider is unavailable." : "Codex could not reach the model provider.";
    }
    if (tag === "serverOverloaded" || tag === "internalServerError" || (httpStatus && httpStatus >= 500)) return "The Codex model provider is unavailable.";
    if (tag === "badRequest") return "Codex rejected the model request.";
    if (tag === "cyberPolicy") return "Codex blocked this turn under provider policy.";
    if (tag === "sandboxError") return "Codex could not apply the local execution policy.";
    if (tag === "threadRollbackFailed") return "Codex could not restore the thread state.";
    if (tag === "activeTurnNotSteerable") return "The active Codex turn cannot accept more input.";
    return "Codex reported a turn error.";
  };
  const textInput = (text) => ({ type: "text", text, text_elements: [] });
  const fileChangesText = (changes) => (changes || []).map((change) => {
    const move = change.kind?.type === "update" && change.kind.move_path ? ` -> ${change.kind.move_path}` : "";
    return `${change.kind?.type || "change"}: ${change.path || "unknown path"}${move}${change.diff ? `\n${change.diff}` : ""}`;
  }).join("\n");
  const itemText = (item) => {
    if (item?.type === "userMessage") {
      return (item.content || []).filter((value) => value?.type === "text").map((value) => value.text).join("\n");
    }
    if (item?.type === "agentMessage" || item?.type === "plan") return item.text || "";
    if (item?.type === "reasoning") return [...(item.summary || []), ...(item.content || [])].join("\n");
    if (item?.type === "commandExecution") {
      return [
        typeof item.command === "string" && item.command ? `Command: ${item.command}` : "",
        typeof item.cwd === "string" && item.cwd ? `Working directory: ${item.cwd}` : "",
        item.aggregatedOutput || "",
      ].filter(Boolean).join("\n");
    }
    if (item?.type === "fileChange") return fileChangesText(item.changes);
    return "";
  };
  const itemKind = (type) => {
    if (type === "userMessage") return "user";
    if (type === "agentMessage") return "assistant";
    if (type === "reasoning" || type === "plan") return "thinking";
    if (type === "contextCompaction") return "compaction";
    if (["commandExecution", "fileChange"].includes(type)) return "tool";
    return "unknown";
  };
  const itemLabel = (type) => ({
    userMessage: "You",
    agentMessage: "Codex",
    reasoning: "Reasoning",
    plan: "Plan",
    commandExecution: "Command",
    fileChange: "File change",
    mcpToolCall: "MCP tool",
    dynamicToolCall: "Tool",
    collabAgentToolCall: "Agent tool",
    contextCompaction: "Compaction",
  })[type] || "Codex item";
  const putItem = (item, overrideStatus) => {
    if (!item || typeof item.id !== "string") return;
    const kind = itemKind(item.type);
    const existing = blocks.get(item.id);
    const block = {
      id: item.id,
      kind,
      label: itemLabel(item.type),
      status: overrideStatus || mapStatus(item.status),
      text: itemText(item),
      ...(kind === "tool" ? { toolName: item.tool || item.type, collapsible: true } : {}),
      ...(kind === "unknown" ? {
        safeSummary: `Unsupported Codex item: ${typeof item.type === "string" ? item.type : "unknown"}`,
        fallback: true,
      } : {}),
      ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
    };
    blocks.set(item.id, block);
    emit({ type: "block", block });
  };
  const emitUnknown = (method) => {
    const id = `unknown-${++blockSerial}`;
    const block = {
      id,
      kind: "unknown",
      label: "Codex event",
      status: "complete",
      safeSummary: `Unsupported Codex event: ${typeof method === "string" ? method : "unknown"}`,
      fallback: true,
    };
    blocks.set(id, block);
    emit({ type: "block", block });
  };
  const retireApproval = (approvalId) => {
    if (!pendingApprovals.delete(approvalId)) return false;
    emit({ type: "approvalResolved", requestId: approvalId });
    return true;
  };
  const resolveApproval = (nativeRequestId) => {
    for (const [approvalId, entry] of pendingApprovals) {
      if (entry.nativeRequestId === String(nativeRequestId)) retireApproval(approvalId);
    }
  };
  const decisionsFor = (method, params) => {
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      const canAnswer = questions.length === 1 && questions[0]?.isSecret !== true;
      return [...(canAnswer ? ["approve-once"] : []), "deny", "cancel"];
    }
    const strictPermissionMode = config.permissionMode === "read-only" || config.permissionMode === "workspace-write";
    if (method === "item/commandExecution/requestApproval") {
      const mapping = { accept: "approve-once", acceptForSession: "approve-session", decline: "deny", cancel: "cancel" };
      const decisions = Array.isArray(params?.availableDecisions)
        ? params.availableDecisions.map((decision) => mapping[decision]).filter(Boolean)
        : ["approve-once", "approve-session", "deny", "cancel"];
      return strictPermissionMode ? decisions.filter((decision) => decision === "deny" || decision === "cancel") : decisions;
    }
    if (
      strictPermissionMode
      && ["item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"].includes(method)
    ) return ["deny", "cancel"];
    return ["approve-once", "approve-session", "deny", "cancel"];
  };
  const approvalDescription = (method, params, kind) => {
    const parts = [];
    if (method === "item/tool/requestUserInput" && Array.isArray(params.questions) && params.questions.length === 1) {
      const question = params.questions[0];
      if (typeof question.header === "string" && question.header) parts.push(`Question: ${question.header}`);
      if (typeof question.question === "string" && question.question) parts.push(question.question);
      if (Array.isArray(question.options)) {
        for (const option of question.options) {
          if (typeof option?.label === "string") parts.push(`Option: ${option.label}${typeof option.description === "string" && option.description ? ` — ${option.description}` : ""}`);
        }
      }
    }
    const command = Array.isArray(params.command) ? undefined : params.command;
    if (kind === "command" && typeof command === "string" && command) parts.push(`Command: ${command}`);
    if (kind === "command" && Array.isArray(params.command)) parts.push(`Command argv: ${params.command.map((argument) => JSON.stringify(argument)).join(" ")}`);
    if (typeof params.cwd === "string" && params.cwd) parts.push(`Working directory: ${params.cwd}`);
    if (typeof params.reason === "string" && params.reason) parts.push(`Reason: ${params.reason}`);
    const permissionProfile = params.additionalPermissions || params.permissions;
    if (permissionProfile?.network?.enabled === true) parts.push("Additional network access requested");
    for (const access of ["read", "write"]) {
      const paths = permissionProfile?.fileSystem?.[access];
      if (Array.isArray(paths) && paths.length) parts.push(`Filesystem ${access}: ${paths.filter((value) => typeof value === "string").join(", ")}`);
    }
    if (Array.isArray(permissionProfile?.fileSystem?.entries) && permissionProfile.fileSystem.entries.length) {
      const entries = permissionProfile.fileSystem.entries.map((entry) => {
        const value = entry?.path?.type === "path"
          ? entry.path.path
          : entry?.path?.type === "glob_pattern"
            ? entry.path.pattern
            : entry?.path?.type === "special" && entry.path.value?.kind
              ? [entry.path.value.kind, entry.path.value.path, entry.path.value.subpath].filter((part) => typeof part === "string" && part).join(":")
              : undefined;
        return typeof value === "string" ? `${entry.access || "access"}: ${value}` : undefined;
      }).filter(Boolean);
      parts.push(entries.length ? `Additional filesystem entries: ${entries.join(", ")}` : `${permissionProfile.fileSystem.entries.length} additional filesystem entries requested`);
    }
    if (params.networkApprovalContext?.host) {
      parts.push(`Network destination: ${params.networkApprovalContext.protocol || "network"}://${params.networkApprovalContext.host}`);
    }
    if (Array.isArray(params.proposedNetworkPolicyAmendments)) {
      for (const amendment of params.proposedNetworkPolicyAmendments) {
        if (typeof amendment?.host === "string") parts.push(`Network policy: ${amendment.action || "change"} ${amendment.host}`);
      }
    }
    if (kind === "file-change" && typeof params.grantRoot === "string") parts.push(`Write root: ${params.grantRoot}`);
    if (kind === "file-change" && params.fileChanges && typeof params.fileChanges === "object") {
      const paths = Object.keys(params.fileChanges);
      if (paths.length) parts.push(`Files: ${paths.join(", ")}`);
    }
    const correlatedFileChange = kind === "file-change" ? blocks.get(params.itemId) : undefined;
    if (correlatedFileChange?.text) parts.push(`File changes:\n${correlatedFileChange.text}`);
    return parts.join("\n") || "Codex requires a decision before it can continue.";
  };
  const registerApproval = (message) => {
    const method = message.method;
    const params = message.params || {};
    const approvalThreadId = params.threadId || params.conversationId;
    if (nativeId && approvalThreadId && approvalThreadId !== nativeId) {
      let result;
      if (method === "item/permissions/requestApproval") result = { permissions: {}, scope: "turn" };
      else if (method === "item/tool/requestUserInput") {
        result = { answers: Object.fromEntries((params.questions || []).map((question) => [question.id, { answers: [] }])) };
      } else if (method === "execCommandApproval" || method === "applyPatchApproval") result = { decision: "abort" };
      else if (!Array.isArray(params.availableDecisions) || params.availableDecisions.includes("cancel")) result = { decision: "cancel" };
      else if (params.availableDecisions.includes("decline")) result = { decision: "decline" };
      else {
        void writeNative({ id: message.id, error: { code: -32601, message: "Unsupported child approval decisions" } }).catch(() => {});
        return;
      }
      void writeNative({ id: message.id, result }).catch(() => {});
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      if (questions.length !== 1 || questions[0]?.isSecret === true) {
        const result = { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])) };
        void writeNative({ id: message.id, result }).catch(() => {});
        emit({ type: "error", message: "Codex requested unsupported structured or secret input; the request was declined." });
        return;
      }
    }
    const kind = method.includes("command") || method === "execCommandApproval"
      ? "command"
      : method.includes("fileChange") || method === "applyPatchApproval"
        ? "file-change"
        : method.includes("permissions")
          ? "permission"
          : "input";
    const id = `approval-${++approvalSerial}`;
    const decisions = decisionsFor(method, params);
    if (!decisions || decisions.length === 0) {
      void writeNative({ id: message.id, error: { code: -32601, message: "Unsupported approval decisions" } }).catch(() => {});
      emit({ type: "error", message: "Codex requested approval choices that PiUI cannot represent." });
      return;
    }
    const approval = {
      id,
      kind,
      title: kind === "command" ? "Run command" : kind === "file-change" ? "Apply file changes" : kind === "permission" ? "Grant permissions" : "Codex needs input",
      description: approvalDescription(method, params, kind),
      decisions,
      ...(kind === "input" ? { inputLabel: params.questions?.[0]?.isSecret ? "Secret response" : params.questions?.[0]?.question || "Response" } : {}),
    };
    pendingApprovals.set(id, {
      nativeRequestId: String(message.id),
      nativeId: message.id,
      method,
      params,
      approval,
    });
    emit({ type: "approval", approval });
  };
  const coordinatorOperation = (params) => {
    if (
      !coordinationEnabled
      || params?.namespace !== "workspace"
      || !new Set(["roster", "send", "observe", "wait", "spawn", "spawn_agent"]).has(params?.tool)
      || !params.arguments
      || typeof params.arguments !== "object"
      || Array.isArray(params.arguments)
    ) return null;
    const value = params.arguments;
    const keys = Object.keys(value).sort();
    if (params.tool === "roster" && keys.length === 0) return { type: "roster" };
    if (
      params.tool === "send"
      && keys.join(",") === "body,recipientMemberId"
      && typeof value.recipientMemberId === "string"
      && typeof value.body === "string"
    ) return { type: "send", recipientMemberId: value.recipientMemberId, body: value.body };
    if (
      (params.tool === "observe" || params.tool === "wait")
      && keys.join(",") === "targetMemberId"
      && typeof value.targetMemberId === "string"
    ) return { type: params.tool, targetMemberId: value.targetMemberId };
    if (
      params.tool === "spawn"
      && keys.join(",") === "stepId"
      && typeof value.stepId === "string"
    ) return { type: "spawn", stepId: value.stepId };
    if (params.tool === "spawn_agent" && keys.join(",") === "instructions,name,profileId" && [value.profileId, value.name, value.instructions].every(v => typeof v === "string")) return { type: "spawnAgent", ...value };
    return null;
  };
  const answerCoordinatorCall = async (message) => {
    const params = message.params || {};
    const key = `${String(message.id)}:${String(params.callId)}`;
    const operation = coordinatorOperation(params);
    if (
      !operation
      || params.threadId !== nativeId
      || typeof params.turnId !== "string"
      || typeof params.callId !== "string"
      || pendingCoordinatorCalls.has(key)
    ) {
      await writeNative({
        id: message.id,
        result: {
          contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code: "invalid-coordinator-call", message: "The workspace request is invalid." } }) }],
          success: false,
        },
      });
      return;
    }
    const controller = new AbortController();
    pendingCoordinatorCalls.set(key, { controller, turnId: params.turnId });
    try {
      const result = await coordinatorRequest(operation, { toolCallId: params.callId, signal: controller.signal });
      if (controller.signal.aborted) throw fail("coordinator-cancelled", "The workspace request was cancelled.");
      await writeNative({
        id: message.id,
        result: {
          contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, result: result ?? null }) }],
          success: true,
        },
      });
    } catch (error) {
      const code = typeof error?.bridgeCode === "string" ? error.bridgeCode : "coordinator-failed";
      const messageText = typeof error?.safeMessage === "string" ? error.safeMessage : "The workspace request failed.";
      await writeNative({
        id: message.id,
        result: {
          contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code, message: messageText } }) }],
          success: false,
        },
      }).catch(() => {});
    } finally {
      pendingCoordinatorCalls.delete(key);
    }
  };
  const abortCoordinatorCalls = (turnId) => {
    for (const entry of pendingCoordinatorCalls.values()) {
      if (turnId === undefined || entry.turnId === turnId) entry.controller.abort();
    }
  };
  const serverRequestMethods = new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "execCommandApproval",
    "applyPatchApproval",
  ]);
  const handleNotification = (message) => {
    const method = message.method;
    const params = message.params || {};
    if (!nativeId && method !== "thread/started" && (typeof params.threadId === "string" || typeof params.conversationId === "string")) {
      deferredNativeMessages.push(message);
      return;
    }
    if (method === "item/tool/call" && message.id !== undefined) {
      void answerCoordinatorCall(message);
      return;
    }
    if (serverRequestMethods.has(method) && message.id !== undefined) {
      registerApproval(message);
      return;
    }
    if (message.id !== undefined && method) {
      void writeNative({
        id: message.id,
        error: { code: -32601, message: "Unsupported client request" },
      }).catch(() => {});
      emit({ type: "error", message: "Codex requested an unsupported host operation." });
      return;
    }
    if (method === "thread/started") {
      const thread = params.thread || {};
      if (nativeId && thread.id === nativeId) {
        nativePath = typeof thread.path === "string" ? thread.path : nativePath;
        if (bindingPublished) emit({ type: "binding", nativeId, ...(nativePath ? { nativePath } : {}) });
      }
      return;
    }
    if (nativeId && typeof params.threadId === "string" && params.threadId !== nativeId) return;
    if (method === "mcpServer/startupStatus/updated") {
      if (params.status === "failed") emit({ type: "error", message: "A Codex MCP server failed to start. Check its native configuration." });
      return;
    }
    if (method === "thread/settings/updated") {
      const settings = params.settings ?? params;
      if (typeof settings.model === "string") currentModel = { id: settings.model, name: settings.model, ...(currentProvider ? { provider: currentProvider } : {}) };
      if (typeof settings.reasoningEffort === "string") thinkingLevel = settings.reasoningEffort;
      if ("serviceTier" in settings) serviceTier = settings.serviceTier === "fast" ? "fast" : "standard";
      return;
    }
    if (method === "thread/name/updated") {
      if (typeof params.threadName === "string") title = params.threadName;
      return;
    }
    if (method === "thread/status/changed") {
      if (params.status?.type === "active") setStatus("running");
      else if (params.status?.type === "idle" || params.status?.type === "notLoaded") setStatus("idle");
      else if (params.status?.type === "systemError") setStatus("failed");
      return;
    }
    if (method === "turn/started") {
      if (params.turn?.id !== lastCompletedTurnId) {
        activeTurnId = params.turn?.id;
        setStatus("running");
      }
      return;
    }
    if (method === "turn/completed") {
      abortCoordinatorCalls(params.turn?.id);
      const completedTurnId = params.turn?.id;
      lastCompletedTurnId = completedTurnId;
      if (!activeTurnId || activeTurnId === completedTurnId) activeTurnId = undefined;
      const finalStatus = params.turn?.status;
      if (typeof completedTurnId === "string" && !completedTurnOutcomes.has(completedTurnId)) {
        completedTurnOutcomes.add(completedTurnId);
        if (finalStatus === "failed" && !reportedTurnErrors.has(completedTurnId)) {
          reportedTurnErrors.add(completedTurnId);
          emit({ type: "error", message: safeCodexErrorMessage(params.turn?.error) });
        }
        emit({
          type: "turnCompleted",
          outcome: finalStatus === "completed" ? "succeeded" : finalStatus === "interrupted" ? "interrupted" : "failed",
        });
      }
      for (const blockId of [`plan-${params.turn?.id}`, `diff-${params.turn?.id}`]) {
        const turnBlock = blocks.get(blockId);
        if (turnBlock) {
          turnBlock.status = mapStatus(finalStatus);
          emit({ type: "block", block: turnBlock });
        }
      }
      if (finalStatus === "failed") emit({ type: "error", message: "The Codex turn failed." });
      if (!activeTurnId) setStatus("idle");
      return;
    }
    if (method === "item/started") {
      putItem(params.item, "streaming");
      return;
    }
    if (method === "item/completed") {
      putItem(params.item);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const blockId = params.itemId;
      if (typeof blockId === "string" && typeof params.delta === "string") {
        if (!blocks.has(blockId)) putItem({ id: blockId, type: "agentMessage", text: "" }, "streaming");
        const block = blocks.get(blockId);
        block.text = `${block.text || ""}${params.delta}`;
        emit({ type: "textDelta", blockId, text: params.delta });
      }
      return;
    }
    if (["item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta"].includes(method)) {
      const blockId = params.itemId;
      if (typeof blockId === "string" && typeof params.delta === "string") {
        if (!blocks.has(blockId)) putItem({ id: blockId, type: method.includes("plan") ? "plan" : "reasoning", text: "" }, "streaming");
        const block = blocks.get(blockId);
        block.text = `${block.text || ""}${params.delta}`;
        emit({ type: "textDelta", blockId, text: params.delta });
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/mcpToolCall/progress") {
      const blockId = params.itemId;
      const delta = method === "item/mcpToolCall/progress" ? params.message : params.delta;
      if (typeof blockId === "string" && typeof delta === "string") {
        if (!blocks.has(blockId)) putItem({ id: blockId, type: method.includes("mcp") ? "mcpToolCall" : "commandExecution" }, "streaming");
        const block = blocks.get(blockId);
        block.text = `${block.text || ""}${delta}`;
        emit({ type: "textDelta", blockId, text: delta });
      }
      return;
    }
    if (method === "item/fileChange/patchUpdated") {
      const block = blocks.get(params.itemId);
      if (block) {
        block.text = fileChangesText(params.changes);
        block.safeSummary = `${Array.isArray(params.changes) ? params.changes.length : 0} pending file changes`;
        emit({ type: "block", block });
      }
      return;
    }
    if (method === "turn/diff/updated") {
      const id = `diff-${params.turnId || ++blockSerial}`;
      const block = { id, kind: "tool", label: "Diff", status: "streaming", text: typeof params.diff === "string" ? params.diff : "", toolName: "file-change", collapsible: true };
      blocks.set(id, block);
      emit({ type: "block", block });
      return;
    }
    if (method === "turn/plan/updated") {
      const id = `plan-${params.turnId || ++blockSerial}`;
      const steps = Array.isArray(params.plan) ? params.plan.map((step) => step?.step || step?.text || "Plan step").join("\n") : "";
      const block = { id, kind: "thinking", label: "Plan", status: "streaming", text: steps || params.explanation || "" };
      blocks.set(id, block);
      emit({ type: "block", block });
      return;
    }
    if (method === "item/commandExecution/terminalInteraction" || method === "item/reasoning/summaryPartAdded") return;
    if (method === "serverRequest/resolved") {
      resolveApproval(params.requestId);
      return;
    }
    if (method === "error") {
      setStatus(params.willRetry ? "running" : "failed");
      if (!params.willRetry && typeof params.turnId === "string") reportedTurnErrors.add(params.turnId);
      emit({ type: "error", message: params.willRetry ? "Codex reported a retryable error." : safeCodexErrorMessage(params.error) });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const native = params.tokenUsage?.total;
      if (native) {
        const usage = { id: "codex-session-total" };
        for (const [source, target] of [["inputTokens","inputTokens"],["outputTokens","outputTokens"],["cachedInputTokens","cacheReadTokens"],["totalTokens","totalTokens"]]) {
          if (Number.isSafeInteger(native[source]) && native[source] >= 0) usage[target] = native[source];
        }
        emit({ type: "usage", usage });
      }
      return;
    }
    if ([ "remoteControl/status/changed", "thread/goal/cleared"].includes(method)) return;
    emitUnknown(method);
  };
  const acceptNativeFrame = (raw) => {
    if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, -1);
    if (raw.length === 0) return;
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      setStatus("failed");
      emit({ type: "error", message: "Codex sent a malformed protocol frame." });
      disposed = true;
      child.kill();
      settleNativeStop(false);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      setStatus("failed");
      emit({ type: "error", message: "Codex sent an invalid protocol message." });
      disposed = true;
      child.kill();
      settleNativeStop(false);
      return;
    }
    const key = String(message.id);
    const hasResult = "result" in message;
    const hasError = "error" in message;
    const responseEnvelope = message.method === undefined && message.id !== undefined && hasResult !== hasError;
    if (responseEnvelope) {
      const waiter = pending.get(key);
      if (!waiter) return;
      pending.delete(key);
      if ("result" in message) waiter.resolve(message.result);
      else waiter.reject(safeNativeError());
      return;
    }
    if (typeof message.method === "string" && !hasResult && !hasError) {
      handleNotification(message);
      return;
    }
    setStatus("failed");
    emit({ type: "error", message: "Codex sent an invalid protocol message." });
    disposed = true;
    child.kill();
    settleNativeStop(false);
  };

  const args = [
    "app-server", "--stdio", "-c", "analytics.enabled=false",
    "--disable", "apps",
    "--disable", "plugins",
    "--disable", "remote_plugin",
    "--disable", "recommended_plugins",
    "--disable", "shell_snapshot",
  ];
  if (coordinationEnabled || config.nativeSubagents === false) args.push("--disable", "multi_agent", "--disable", "multi_agent_v2");
  // Inherit native CODEX_HOME/auth without inspecting or logging it. sessionDir
  // remains host metadata/scratch; it is not substituted for the user's Codex home.
  const child = (openChild ?? spawn)(config.runtimeProgram, [...config.runtimeArgs, ...args], {
    cwd: config.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
    if (stdoutBuffer.length > MAX_FRAME_BYTES && stdoutBuffer.indexOf(0x0a) === -1) {
      setStatus("failed");
      emit({ type: "error", message: "Codex exceeded the protocol frame limit." });
      child.kill();
      return;
    }
    let delimiter;
    while ((delimiter = stdoutBuffer.indexOf(0x0a)) !== -1) {
      const frame = stdoutBuffer.subarray(0, delimiter);
      stdoutBuffer = stdoutBuffer.subarray(delimiter + 1);
      if (frame.length > MAX_FRAME_BYTES) {
        setStatus("failed");
        emit({ type: "error", message: "Codex exceeded the protocol frame limit." });
        child.kill();
        return;
      }
      acceptNativeFrame(frame);
    }
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const settleNativeStop = (spawnFailed) => {
    if (nativeStopSettled) return;
    nativeStopSettled = true;
    const wasDisposed = disposed;
    disposed = true;
    abortCoordinatorCalls();
    for (const waiter of pending.values()) waiter.reject(
      spawnFailed
        ? fail("native-unavailable", "The Codex executable could not be started.")
        : safeNativeError(),
    );
    pending.clear();
    for (const approvalId of [...pendingApprovals.keys()]) retireApproval(approvalId);
    if (!wasDisposed) {
      setStatus("failed");
      emit({ type: "error", message: spawnFailed ? "The Codex executable could not be started." : "The Codex app server stopped unexpectedly." });
    }
  };
  child.once("error", () => settleNativeStop(true));
  child.once("close", () => settleNativeStop(false));
  child.stdin.on("error", () => settleNativeStop(false));

  const cleanupStartupFailure = (error) => {
    disposed = true;
    child.stdin.destroy();
    child.kill();
    settleNativeStop(false);
    return error;
  };
  const callDuringStartup = async (method, params) => {
    try {
      return await callNative(method, params);
    } catch (error) {
      throw cleanupStartupFailure(error);
    }
  };

  const initialize = await callDuringStartup("initialize", {
    clientInfo: { name: "piui", title: "PiUI", version: "0.1.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (!initialize || typeof initialize.codexHome !== "string") {
    throw cleanupStartupFailure(fail("native-handshake-failed", "The Codex app server handshake failed."));
  }
  if (typeof initialize.userAgent !== "string" || !/(?:^|\/)0\.147\.0(?:\s|\(|$)/.test(initialize.userAgent)) {
    throw cleanupStartupFailure(fail("unsupported-native-version", "PiUI requires Codex app-server 0.147.0 for this adapter."));
  }
  try {
    await notifyNative("initialized");
  } catch (error) {
    throw cleanupStartupFailure(error);
  }

  const permissionParams = config.permissionMode === "read-only"
    ? { permissions: ":read-only", approvalPolicy: "never" }
    : config.permissionMode === "workspace-write"
      ? { permissions: ":workspace", approvalPolicy: "never" }
      : config.permissionMode === "full-access"
        ? { permissions: ":danger-full-access", approvalPolicy: "never" }
        : {};
  const workspaceTools = coordinationEnabled ? [{
    type: "namespace",
    name: "workspace",
    description: "Coordinate only with members and predefined steps in the current managed PiUI run.",
    tools: [
      { type: "function", name: "roster", description: "List coordinator-visible run members.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { type: "function", name: "send", description: "Send a message to one coordinator-visible member.", inputSchema: { type: "object", properties: { recipientMemberId: { type: "string" }, body: { type: "string" } }, required: ["recipientMemberId", "body"], additionalProperties: false } },
      { type: "function", name: "observe", description: "Read authorized activity for one coordinator-visible member.", inputSchema: { type: "object", properties: { targetMemberId: { type: "string" } }, required: ["targetMemberId"], additionalProperties: false } },
      { type: "function", name: "wait", description: "Wait for an observed agent's current task and read its result. Use after spawn_agent to collect the child's result before completing your own task. Requires observation permission.", inputSchema: { type: "object", properties: { targetMemberId: { type: "string" } }, required: ["targetMemberId"], additionalProperties: false } },
      { type: "function", name: "spawn_agent", description: "Create an independent agent using an allowed profile from roster. Give it a name and task. It can message its creator; unrelated peers are not granted access.", inputSchema: { type: "object", properties: { profileId: { type: "string" }, name: { type: "string" }, instructions: { type: "string" } }, required: ["profileId", "name", "instructions"], additionalProperties: false } },
      { type: "function", name: "spawn", description: "Lease one ready predefined pipeline step using its snapshotted profile.", inputSchema: { type: "object", properties: { stepId: { type: "string" } }, required: ["stepId"], additionalProperties: false } },
    ],
  }] : undefined;
  const resourceConfig = {};
  for (const rule of config.resourceRules ?? []) {
    if (rule.kind === "skill") {
      if (!path.isAbsolute(rule.id)) throw cleanupStartupFailure(fail("invalid-skill-path", "Codex skill rules require an absolute path."));
      (resourceConfig["skills.config"] ??= []).push({ path: rule.id, enabled: rule.enabled });
    } else if (rule.kind === "mcp" && /^[a-zA-Z0-9_-]+$/.test(rule.id)) {
      resourceConfig[`mcp_servers.${rule.id}.enabled`] = rule.enabled;
    } else throw cleanupStartupFailure(fail("unsupported-resource-policy", "The resource policy is invalid."));
  }
  const threadParams = {
    cwd: config.cwd,
    ...(serviceTier ? { serviceTier: serviceTier === "fast" ? "fast" : "default" } : {}),
    ...(currentModel ? { model: currentModel.id, ...(currentModel.provider ? { modelProvider: currentModel.provider } : {}) } : {}),
    ...(typeof config.baseInstructions === "string" ? { baseInstructions: config.baseInstructions, developerInstructions: config.instructions ?? "" } : typeof config.instructions === "string" ? { developerInstructions: config.instructions } : {}),
    config: { ...resourceConfig, ...(coordinationEnabled || config.nativeSubagents === false ? { "features.multi_agent": false, "features.multi_agent_v2": false } : {}) },
    ...permissionParams,
  };
  const { cwd: _startCwd, ...startThreadParams } = threadParams;
  const opened = nativeId
    ? await callDuringStartup("thread/resume", {
        threadId: nativeId,
        ...threadParams,
        excludeTurns: true,
        initialTurnsPage: { sortDirection: "desc", itemsView: "full" },
      })
    : await callDuringStartup("thread/start", { ...startThreadParams, ephemeral: false, ...(workspaceTools ? { dynamicTools: workspaceTools } : {}) });
  thinkingLevel ??= opened.reasoningEffort ?? undefined;
  serviceTier ??= opened.serviceTier === "fast" ? "fast" : "standard";
  const thread = opened?.thread;
  if (!thread || typeof thread.id !== "string") {
    throw cleanupStartupFailure(fail("native-thread-failed", "Codex could not open the native thread."));
  }
  const effectiveCwd = typeof opened.cwd === "string" ? opened.cwd : undefined;
  const normalizeCwd = (value) => {
    const normalized = path.resolve(value);
    // Rust canonicalization returns extended-length Windows paths, while the
    // native app server may return a drive/UNC path for the same directory.
    return process.platform === "win32" ? path.toNamespacedPath(normalized).toLowerCase() : normalized;
  };
  if (!effectiveCwd || normalizeCwd(effectiveCwd) !== normalizeCwd(config.cwd)) {
    throw cleanupStartupFailure(fail("native-cwd-mismatch", "Codex opened the thread in a different workspace."));
  }
  const effectivePermissionMatches = config.permissionMode === "native"
    || (config.permissionMode === "read-only"
      && opened.activePermissionProfile?.id === ":read-only"
      && opened.sandbox?.type === "readOnly"
      && opened.approvalPolicy === "never")
    || (config.permissionMode === "workspace-write"
      && opened.activePermissionProfile?.id === ":workspace"
      && opened.sandbox?.type === "workspaceWrite"
      && opened.approvalPolicy === "never")
    || (config.permissionMode === "full-access"
      && opened.activePermissionProfile?.id === ":danger-full-access"
      && opened.sandbox?.type === "dangerFullAccess"
      && opened.approvalPolicy === "never");
  if (!effectivePermissionMatches) {
    throw cleanupStartupFailure(fail("unsupported-permission-mode", "Codex did not apply the requested permission mode."));
  }
  nativeId = thread.id;
  nativePath = typeof thread.path === "string" ? thread.path : nativePath;
  for (const message of deferredNativeMessages.splice(0)) handleNotification(message);
  if (typeof opened.modelProvider === "string") currentProvider = opened.modelProvider;
  if (typeof opened.model === "string") {
    const effectiveName = currentModel?.id === opened.model ? currentModel.name : opened.model;
    currentModel = { id: opened.model, ...(currentProvider ? { provider: currentProvider } : {}), name: effectiveName };
  }
  const initialTurns = Array.isArray(opened.initialTurnsPage?.data)
    ? [...opened.initialTurnsPage.data].reverse()
    : thread.turns || [];
  for (const turn of initialTurns) for (const item of turn.items || []) putItem(item);
  const resumedActiveTurn = [...initialTurns].reverse().find((turn) => turn?.status === "inProgress");
  if (resumedActiveTurn?.id) activeTurnId = resumedActiveTurn.id;
  if (thread.status?.type === "active" && !activeTurnId) {
    throw cleanupStartupFailure(fail("native-active-turn-unresolved", "Codex resumed an active thread without an interruptible turn reference."));
  }
  materialized = resumingNativeThread;
  publishBinding();
  if (activeTurnId || thread.status?.type === "active") setStatus("running");
  else if (thread.status?.type === "systemError") {
    setStatus("failed");
    emit({ type: "error", message: "Codex resumed a thread in a system error state." });
  } else setStatus("idle");

  const mapModel = (model) => ({
    id: model.model || model.id,
    ...(currentProvider ? { provider: currentProvider } : {}),
    name: model.displayName || model.model || model.id,
    thinkingLevels: (model.supportedReasoningEfforts || [])
      .map((option) => option.reasoningEffort || option.effort)
      .filter((value) => typeof value === "string"),
  });
  const adapter = {
    async resources() {
      const items = []; const warnings = [];
      try {
        const response = await callNative("skills/list", { cwds: [config.cwd], forceReload: false });
        for (const group of response.data ?? []) for (const skill of group.skills ?? []) {
          if (typeof skill.path === "string") items.push({ kind: "skill", id: skill.path, name: skill.name ?? skill.path, enabled: skill.enabled !== false, configurable: true });
        }
      } catch { warnings.push("Skills could not be loaded from Codex."); }
      try {
        const response = await callNative("config/read", { includeLayers: false, cwd: config.cwd });
        for (const [id, server] of Object.entries(response.config?.mcp_servers ?? {})) items.push({ kind: "mcp", id, name: id, enabled: server.enabled !== false, configurable: true });
      } catch { warnings.push("MCP servers could not be loaded from Codex."); }
      try {
        let cursor;
        do {
          const response = await callNative("mcpServerStatus/list", { ...(cursor ? { cursor } : {}) });
          for (const server of response.data ?? []) for (const [id, tool] of Object.entries(server.tools ?? {})) items.push({ kind: "tool", id, name: tool.name ?? id, enabled: true, configurable: false });
          cursor = response.nextCursor;
        } while (cursor);
      } catch { warnings.push("MCP tools could not be loaded from Codex."); }
      return { items, warnings };
    },
    snapshot() {
  return {
        nativeId,
        thinkingLevel,
        serviceTier,
        materialized,
        ...(bindingPublished && nativePath ? { nativePath } : {}),
        title,
        status,
        ...(currentModel ? { model: currentModel } : {}),
        blocks: [...blocks.values()],
        approvals: [...pendingApprovals.values()].map((entry) => entry.approval),
        capabilities: {
          prompt: { supported: true, enforcement: "native" },
          resume: { supported: true, enforcement: "native" },
          models: { supported: true, enforcement: "native" },
          approvals: { supported: true, enforcement: "native" },
          instructions: { supported: true, enforcement: "native" },
          toolPolicy: { supported: false, enforcement: "unsupported", reason: "Codex app-server 0.147.0 has no restrictive tool allowlist contract." },
          nativeSubagents: coordinationEnabled
            ? { supported: true, enforcement: "coordinator" }
            : { supported: true, enforcement: "native" },
        },
        models: modelCatalog,
      };
    },
    async prompt({ text, mode }) {
      if (typeof text !== "string" || !new Set(["prompt", "steer", "follow-up"]).has(mode)) {
        throw fail("invalid-prompt", "The Codex prompt request is invalid.");
      }
      if (status === "failed" || status === "closed" || status === "stopping") {
        throw fail("native-not-ready", "The Codex thread is not ready for a prompt.");
      }
      if (activeTurnId) {
        if (mode !== "steer") throw fail("turn-active", "Codex is already running a turn.");
        await callNative("turn/steer", {
          threadId: nativeId,
          expectedTurnId: activeTurnId,
          input: [textInput(text)],
        });
        return { accepted: true };
      }
      if (startingTurn) throw fail("turn-active", "Codex is already starting a turn.");
      startingTurn = true;
      try {
        const response = await callNative("turn/start", {
          threadId: nativeId,
          input: [textInput(text)],
          ...(serviceTier ? { serviceTier: serviceTier === "fast" ? "fast" : "default" } : {}),
          ...(currentModel ? { model: currentModel.id } : {}),
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        });
        const acceptedTurnId = response?.turn?.id;
        if (!acceptedTurnId) throw safeNativeError();
        activeTurnId = acceptedTurnId === lastCompletedTurnId ? undefined : acceptedTurnId;
        materialized = true;
        publishBinding();
        if (activeTurnId) setStatus("running");
        if (interruptStartingTurn && activeTurnId) {
          interruptStartingTurn = false;
          await callNative("turn/interrupt", { threadId: nativeId, turnId: activeTurnId });
        }
        return { accepted: true };
      } finally {
        startingTurn = false;
        interruptStartingTurn = false;
      }
    },
    async interrupt() {
      if (startingTurn && !activeTurnId) {
        interruptStartingTurn = true;
        return { interrupted: true };
      }
      if (!activeTurnId) throw fail("no-active-turn", "Codex has no active turn to interrupt.");
      abortCoordinatorCalls(activeTurnId);
      await callNative("turn/interrupt", { threadId: nativeId, turnId: activeTurnId });
      return { interrupted: true };
    },
    async catalogModels() { return (await this.models()).map(model => ({ ...model, supportsFast: true })); },
    async models() {
      const data = [];
      let cursor = null;
      do {
        const page = await callNative("model/list", { cursor, includeHidden: false });
        for (const model of page?.data || []) modelDefaults.set(model.model || model.id, model.defaultReasoningEffort);
        data.push(...(page?.data || []).filter((model) => !model.hidden).map(mapModel));
        cursor = page?.nextCursor || null;
      } while (cursor);
      modelCatalog = data;
      return data;
    },
    async setModel({ model, thinkingLevel: nextThinkingLevel, serviceTier: nextServiceTier }) {
      if (!model || typeof model.id !== "string") throw fail("invalid-model", "The Codex model selection is invalid.");
      if (model.provider && currentProvider && model.provider !== currentProvider) {
        throw fail("unsupported-provider-change", "Codex cannot change model providers on an existing thread.");
      }
      if (nextServiceTier != null && !["standard", "fast"].includes(nextServiceTier)) throw fail("invalid-settings", "Invalid Codex service tier.");
      const candidate = modelCatalog.find((entry) => entry.id === model.id);
      if (!candidate || (nextThinkingLevel && !candidate.thinkingLevels.includes(nextThinkingLevel))) throw fail("invalid-settings", "The model or reasoning level is unavailable.");
      const effectiveEffort = nextThinkingLevel ?? (currentModel?.id !== model.id ? modelDefaults.get(model.id) : thinkingLevel);
      await callNative("thread/settings/update", {
        threadId: nativeId,
        model: model.id,
        ...(nextServiceTier ? { serviceTier: nextServiceTier === "fast" ? "fast" : "default" } : {}),
        ...(typeof effectiveEffort === "string" ? { effort: effectiveEffort } : {}),
      });
      serviceTier = nextServiceTier || serviceTier;
      currentProvider = model.provider || currentProvider;
      currentModel = { id: model.id, ...(currentProvider ? { provider: currentProvider } : {}), name: model.name || model.id };
      thinkingLevel = effectiveEffort;
      return { model: currentModel, ...(thinkingLevel ? { thinkingLevel } : {}) };
    },
    async respond({ requestId, decision, text }) {
      const entry = pendingApprovals.get(requestId);
      if (!entry || entry.responding) throw fail("stale-approval", "The approval request is no longer pending.");
      if ((entry.params.threadId || entry.params.conversationId) && (entry.params.threadId || entry.params.conversationId) !== nativeId) {
        throw fail("approval-origin-mismatch", "The approval request does not belong to this Codex thread.");
      }
      if (!entry.approval.decisions.includes(decision)) {
        throw fail("unsupported-decision", "The selected approval decision is not available.");
      }
      let result;
      if (entry.method === "item/permissions/requestApproval") {
        const approved = decision === "approve-once" || decision === "approve-session";
        result = {
          permissions: approved ? (entry.params.permissions || {}) : {},
          scope: decision === "approve-session" ? "session" : "turn",
        };
      } else if (entry.method === "item/tool/requestUserInput") {
        const questions = Array.isArray(entry.params.questions) ? entry.params.questions : [];
        if (decision === "approve-once" && (questions.length !== 1 || typeof text !== "string")) {
          throw fail("input-required", "Codex requires one text response for this request.");
        }
        result = {
          answers: Object.fromEntries(questions.map((question, index) => [
            question.id,
            { answers: decision === "approve-once" && index === 0 ? [text] : [] },
          ])),
        };
      } else {
        const legacy = entry.method === "execCommandApproval" || entry.method === "applyPatchApproval";
        const mapped = legacy
          ? { "approve-once": "approved", "approve-session": "approved_for_session", deny: { denied: { rejection: "Denied by user" } }, cancel: "abort" }[decision]
          : { "approve-once": "accept", "approve-session": "acceptForSession", deny: "decline", cancel: "cancel" }[decision];
        result = { decision: mapped };
      }
      entry.responding = true;
      try {
        await writeNative({ id: entry.nativeId, result });
      } catch (error) {
        entry.responding = false;
        throw error;
      }
      retireApproval(requestId);
      return { resolved: true };
    },
    async rename({ title: nextTitle }) {
      if (typeof nextTitle !== "string" || nextTitle.trim() === "") throw fail("invalid-title", "The Codex title is invalid.");
      await callNative("thread/name/set", { threadId: nativeId, name: nextTitle });
      title = nextTitle;
      return { title };
    },
    async dispose() {
      if (disposed) return { disposed: true };
      disposed = true;
      abortCoordinatorCalls();
      setStatus("stopping");
      child.stdin.end();
      const cleanupBound = new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000, "timeout");
        timer.unref?.();
      });
      if (await Promise.race([exited.then(() => "exit"), cleanupBound]) === "timeout") child.kill();
      settleNativeStop(false);
      setStatus("closed");
      return { disposed: true };
    },
  };
  return adapter;
}
