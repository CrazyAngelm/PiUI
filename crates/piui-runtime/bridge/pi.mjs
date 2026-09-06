export async function createPiAdapter(config, emit) {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { stat, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const fail = (code, safeMessage) => Object.assign(new Error(code), { bridgeCode: code, safeMessage });
  const isMaterialized = async (nativePath) => {
    if (!nativePath) return false;
    try { return (await stat(nativePath)).isFile(); }
    catch { return false; }
  };
  if (config.harness !== "pi") throw fail("wrong-harness", "The Pi adapter received an invalid harness configuration.");
  if (typeof config.runtimeProgram !== "string" || !Array.isArray(config.runtimeArgs)) {
    throw fail("runtime-unavailable", "The Pi runtime is not installed.");
  }

  if (config.nativeSubagents === true) throw fail("unsupported-policy", "This Pi adapter cannot enforce native subagent policy.");
  if (config.coordination === true) throw fail("unsupported-policy", "This Pi RPC adapter cannot register the coordinator tool.");
  if (config.permissionMode === "workspace-write") {
    throw fail("unsupported-policy", "This Pi adapter cannot enforce workspace-only writes as an OS boundary.");
  }
  const builtInTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
  if (config.allowedTools !== undefined && (!Array.isArray(config.allowedTools)
    || config.allowedTools.some((name) => typeof name !== "string" || !builtInTools.has(name)))) {
    throw fail("unsupported-policy", "The Pi tool allowlist contains an unsupported tool name.");
  }
  const effectiveAllowedTools = Array.isArray(config.allowedTools)
    ? config.allowedTools.filter((name) => config.permissionMode !== "read-only" || readOnlyTools.has(name))
    : config.permissionMode === "read-only" ? [...readOnlyTools] : undefined;

  const commandArgs = [...config.runtimeArgs, "--mode", "rpc", "--approve", "--session-dir", config.sessionDir];
  if (config.nativePath) commandArgs.push("--session", config.nativePath);
  else if (config.nativeId) commandArgs.push("--session-id", config.nativeId);
  if (config.title) commandArgs.push("--name", config.title);
  if (config.model?.provider) commandArgs.push("--provider", config.model.provider);
  if (config.model?.id) commandArgs.push("--model", config.model.id);
  if (config.thinkingLevel) commandArgs.push("--thinking", config.thinkingLevel);
  if (Array.isArray(effectiveAllowedTools)) {
    if (effectiveAllowedTools.length === 0) commandArgs.push("--no-tools", "--no-extensions");
    else commandArgs.push("--tools", effectiveAllowedTools.join(","), "--no-extensions");
  }

  let instructionDirectory;
  if (typeof config.instructions === "string" && config.instructions.trim()) {
    instructionDirectory = await mkdtemp(join(config.sessionDir, "instructions-"));
    const instructionPath = join(instructionDirectory, "append.md");
    await writeFile(instructionPath, config.instructions, { mode: 0o600 });
    commandArgs.push("--append-system-prompt", instructionPath);
  }
  const child = spawn(config.runtimeProgram, commandArgs, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  child.stderr.on("data", () => {});

  let closed = false;
  let disposing = false;
  let status = "starting";
  let state = {};
  let model;
  let availableModels = [];
  let requestSequence = 0;
  let blockSequence = 0;
  let stdoutBytes = Buffer.alloc(0);
  let admittedTurns = 0;
  let lastTurnOutcome;
  const pending = new Map();
  const blocks = new Map();
  const approvals = new Map();
  const contentBlocks = new Map();

  const opaque = (prefix, value) => `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    emit({ type: "status", status: next });
  };
  const putBlock = (block) => {
    blocks.set(block.id, block);
    emit({ type: "block", block });
  };
  const updateBlock = (id, patch) => {
    const current = blocks.get(id);
    if (current) putBlock({ ...current, ...patch });
  };
  const safeToolName = (name) => typeof name === "string" && name.length <= 160 ? name : "tool";
  const writeNative = (value) => {
    if (closed || !child.stdin.writable) throw fail("not-running", "The Pi runtime is not running.");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const request = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = `piui-native-${++requestSequence}`;
    pending.set(id, { type, resolve, reject });
    try { writeNative({ id, type, ...extra }); }
    catch (error) { pending.delete(id); reject(error); }
  });

  const textOf = (message) => {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  };
  const mapModel = (candidate) => candidate && typeof candidate.id === "string" ? {
    id: candidate.id,
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
    name: typeof candidate.name === "string" ? candidate.name : candidate.id,
    ...(Array.isArray(candidate.thinkingLevels) ? { thinkingLevels: candidate.thinkingLevels.filter((x) => typeof x === "string") } : {}),
  } : undefined;
  const historyBlock = (entry) => {
    if (entry?.type !== "message" || !entry.message) return undefined;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") return undefined;
    const id = opaque("pi-entry", entry.id ?? `${role}-${++blockSequence}`);
    const isError = role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason);
    return {
      id,
      kind: role,
      label: role === "user" ? "You" : "Pi",
      status: isError ? (entry.message.stopReason === "aborted" ? "interrupted" : "failed") : "complete",
      text: textOf(entry.message),
      ...(typeof entry.timestamp === "string" ? { createdAt: entry.timestamp } : {}),
    };
  };

  const handleExtensionRequest = (frame) => {
    if (!["select", "confirm", "input", "editor"].includes(frame.method) || typeof frame.id !== "string") {
      if (typeof frame.id === "string") writeNative({ type: "extension_ui_response", id: frame.id, cancelled: true });
      return;
    }
    const id = `pi-approval-${++blockSequence}`;
    const approval = {
      id,
      kind: frame.method === "confirm" ? "permission" : "input",
      title: typeof frame.title === "string" ? frame.title : "Pi request",
      description: typeof frame.message === "string" ? frame.message : "Pi needs a response to continue.",
      decisions: frame.method === "confirm" ? ["approve-once", "deny", "cancel"] : ["approve-once", "cancel"],
      ...(frame.method === "input" || frame.method === "editor" ? { inputLabel: frame.placeholder ?? "Response" } : {}),
    };
    approvals.set(id, { nativeId: frame.id, method: frame.method, approval });
    emit({ type: "approval", approval });
  };

  const classifyTurnError = (message) => {
    const detail = typeof message?.errorMessage === "string" ? message.errorMessage.toLowerCase() : "";
    if (/api[ _-]?key|authenticat|unauthori[sz]ed|forbidden|credential|log[ -]?in|\b401\b|\b403\b/.test(detail)) {
      return "The Pi runtime could not authenticate the selected model.";
    }
    if (/model[^\n]*(not found|unknown|unavailable)|unsupported[^\n]*model|\b404\b/.test(detail)) {
      return "The selected Pi model is unavailable.";
    }
    if (/rate[ _-]?limit|quota|too many requests|\b429\b|overloaded|capacity/.test(detail)) {
      return "The Pi model provider is temporarily unavailable.";
    }
    if (/network|fetch failed|connection|econn|dns|socket|timed? out|timeout|tls|certificate/.test(detail)) {
      return "The Pi runtime could not reach the model provider.";
    }
    return "The Pi turn failed.";
  };

  const settleTurn = () => {
    if (admittedTurns > 0) {
      admittedTurns -= 1;
      if (lastTurnOutcome) emit({ type: "turnCompleted", outcome: lastTurnOutcome });
    }
    lastTurnOutcome = undefined;
  };

  const handleNativeEvent = (frame) => {
    switch (frame.type) {
      case "agent_start": lastTurnOutcome = undefined; setStatus("running"); break;
      case "agent_settled": case "agent_end": settleTurn(); setStatus("idle"); break;
      case "message_start": {
        if (frame.message?.role === "user") {
          const id = opaque("pi-message", frame.message.id ?? `user-${++blockSequence}`);
          putBlock({ id, kind: "user", label: "You", status: "complete", text: textOf(frame.message) });
        }
        break;
      }
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (!event || typeof event.type !== "string") break;
        const index = Number.isInteger(event.contentIndex) ? event.contentIndex : 0;
        const kind = event.type.startsWith("thinking") ? "thinking" : "assistant";
        const key = `${kind}:${index}`;
        let id = contentBlocks.get(key);
        if (!id) {
          id = `pi-stream-${++blockSequence}`;
          contentBlocks.set(key, id);
          putBlock({ id, kind, label: kind === "thinking" ? "Thinking" : "Pi", status: "streaming", text: "" });
        }
        if (event.type.endsWith("_delta") && typeof event.delta === "string") {
          const current = blocks.get(id);
          if (current) current.text = `${current.text ?? ""}${event.delta}`;
          emit({ type: "textDelta", blockId: id, text: event.delta });
        } else if (event.type.endsWith("_end") || event.type === "done") updateBlock(id, { status: "complete" });
        else if (event.type === "error") updateBlock(id, { status: "failed", safeSummary: "The assistant turn ended with an error." });
        break;
      }
      case "message_end": {
        if (frame.message?.role === "assistant") {
          const interrupted = frame.message.stopReason === "aborted";
          const failed = frame.message.stopReason === "error";
          lastTurnOutcome = interrupted ? "interrupted" : failed ? "failed" : "succeeded";
          if (failed) emit({ type: "error", message: classifyTurnError(frame.message) });
          for (const id of contentBlocks.values()) updateBlock(id, { status: interrupted ? "interrupted" : failed ? "failed" : "complete" });
          contentBlocks.clear();
        }
        break;
      }
      case "tool_execution_start": case "tool_execution_update": case "tool_execution_end": {
        if (typeof frame.toolCallId !== "string") break;
        const id = opaque("pi-tool", frame.toolCallId);
        const toolName = safeToolName(frame.toolName);
        const next = frame.type === "tool_execution_end" ? (frame.isError ? "failed" : "complete") : "streaming";
        const existing = blocks.get(id);
        putBlock({ ...(existing ?? { id, kind: "tool", label: toolName, toolName, collapsible: true }), status: next,
          ...(frame.type === "tool_execution_end" ? { safeSummary: frame.isError ? "The tool failed." : "The tool completed." } : {}) });
        break;
      }
      case "compaction_start": putBlock({ id: `pi-compaction-${++blockSequence}`, kind: "compaction", label: "Compaction", status: "streaming", safeSummary: "Context is being compacted." }); break;
      case "extension_ui_request": handleExtensionRequest(frame); break;
      case "session_info_changed": if (typeof frame.name === "string") state.sessionName = frame.name; break;
      case "thinking_level_changed": state.thinkingLevel = frame.level; break;
    }
  };

  const failNative = () => {
    if (closed) return;
    closed = true;
    for (const slot of pending.values()) slot.reject(fail("runtime-exited", "The Pi runtime exited before responding."));
    pending.clear();
    if (!disposing) {
      setStatus("failed");
      emit({ type: "error", message: "The Pi runtime exited unexpectedly." });
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBytes = Buffer.concat([stdoutBytes, chunk]);
    if (stdoutBytes.length > 32 * 1024 * 1024 && stdoutBytes.indexOf(0x0a) === -1) {
      failNative();
      return;
    }
    let lf;
    while ((lf = stdoutBytes.indexOf(0x0a)) !== -1) {
      let line = stdoutBytes.subarray(0, lf);
      stdoutBytes = stdoutBytes.subarray(lf + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (!line.length) continue;
      let frame;
      try { frame = JSON.parse(line.toString("utf8")); } catch { failNative(); return; }
      if (frame?.type === "response") {
        const slot = typeof frame.id === "string" ? pending.get(frame.id) : undefined;
        if (!slot || slot.type !== frame.command) { failNative(); return; }
        pending.delete(frame.id);
        if (frame.success === true) slot.resolve(frame.data ?? null);
        else slot.reject(fail("native-command-rejected", "The Pi runtime rejected the request."));
      } else handleNativeEvent(frame);
    }
  });
  child.stdout.on("end", () => { if (stdoutBytes.length) failNative(); });
  child.on("error", failNative);
  child.on("exit", failNative);
  const cleanupInstructions = () => { if (instructionDirectory) void rm(instructionDirectory, { recursive: true, force: true }).catch(() => {}); };
  child.on("exit", cleanupInstructions);
  child.on("error", cleanupInstructions);

  state = await request("get_state");
  model = mapModel(state.model);
  const modelResult = await request("get_available_models");
  availableModels = (modelResult?.models ?? []).map(mapModel).filter(Boolean);
  const entriesResult = await request("get_entries").catch(() => ({ entries: [] }));
  for (const entry of entriesResult?.entries ?? []) {
    const block = historyBlock(entry);
    if (block) blocks.set(block.id, block);
  }
  setStatus(state.isStreaming ? "running" : "idle");
  emit({ type: "binding", nativeId: state.sessionId, ...(state.sessionFile ? { nativePath: state.sessionFile } : {}) });

  const capabilities = {
    prompt: { supported: true, enforcement: "native" },
    resume: { supported: true, enforcement: "native" },
    models: { supported: true, enforcement: "native" },
    approvals: { supported: true, enforcement: "native" },
    instructions: { supported: true, enforcement: "native" },
    toolPolicy: { supported: config.permissionMode === "read-only" || Array.isArray(config.allowedTools), enforcement: config.permissionMode === "read-only" || Array.isArray(config.allowedTools) ? "native" : "advisory", reason: config.permissionMode === "native" || config.permissionMode === "full-access" ? "Pi uses its native configured tool policy." : undefined },
    nativeSubagents: { supported: false, enforcement: "unsupported", reason: "Native subagent policy is not exposed by Pi RPC." },
  };

  const cancelApprovals = () => {
    for (const [requestId, item] of approvals) {
      try { writeNative({ type: "extension_ui_response", id: item.nativeId, cancelled: true }); } catch {}
      approvals.delete(requestId);
      emit({ type: "approvalResolved", requestId });
    }
  };

  return {
    async snapshot() {
      if (closed) throw fail("not-running", "The Pi runtime is not running.");
      const latest = await request("get_state");
      state = latest;
      model = mapModel(latest.model);
      const reasoning = await request("get_available_thinking_levels").catch(() => null);
      if (model && Array.isArray(reasoning?.levels)) {
        model.thinkingLevels = reasoning.levels;
        availableModels = availableModels.map((entry) => entry.id === model.id && entry.provider === model.provider ? { ...entry, thinkingLevels: reasoning.levels } : entry);
      }
      return {
        nativeId: latest.sessionId,
        thinkingLevel: latest.thinkingLevel,
        ...(latest.sessionFile ? { nativePath: latest.sessionFile } : {}),
        materialized: await isMaterialized(latest.sessionFile),
        title: latest.sessionName ?? config.title ?? "Pi session",
        status,
        ...(model ? { model } : {}),
        blocks: [...blocks.values()], approvals: [...approvals.values()].map((item) => item.approval),
        capabilities, models: availableModels,
      };
    },
    async prompt({ text, mode }) {
      if (typeof text !== "string" || !text.trim()) throw fail("invalid-request", "A non-empty prompt is required.");
      if (mode === "steer") await request("steer", { message: text });
      else if (mode === "follow-up") await request("follow_up", { message: text });
      else if (mode === "prompt") await request("prompt", { message: text, streamingBehavior: "followUp" });
      else throw fail("invalid-request", "The prompt mode is invalid.");
      admittedTurns += 1;
      return { accepted: true };
    },
    async interrupt() { cancelApprovals(); await request("abort"); },
    async models() {
      const result = await request("get_available_models");
      availableModels = (result?.models ?? []).map(mapModel).filter(Boolean);
      return availableModels;
    },
    async setModel({ model: requested, thinkingLevel, serviceTier }) {
      if (serviceTier != null) throw fail("unsupported-settings", "This harness does not support service tiers.");
      if (!requested?.id || !requested?.provider) throw fail("invalid-request", "Pi model selection requires a provider and model id.");
      model = mapModel(await request("set_model", { provider: requested.provider, modelId: requested.id }));
      if (thinkingLevel) await request("set_thinking_level", { level: thinkingLevel });
    },
    async respond({ requestId, decision, text }) {
      const item = approvals.get(requestId);
      if (!item || !item.approval.decisions.includes(decision)) throw fail("stale-approval", "The approval request is invalid or no longer pending.");
      approvals.delete(requestId);
      let response;
      if (decision === "cancel") response = { type: "extension_ui_response", id: item.nativeId, cancelled: true };
      else if (item.method === "confirm") response = { type: "extension_ui_response", id: item.nativeId, confirmed: decision === "approve-once" };
      else if (decision === "approve-once" && typeof text === "string") response = { type: "extension_ui_response", id: item.nativeId, value: text };
      else throw fail("invalid-response", "This approval response requires text.");
      writeNative(response);
      emit({ type: "approvalResolved", requestId });
    },
    async rename({ title }) {
      if (typeof title !== "string" || !title.trim()) throw fail("invalid-request", "A non-empty session title is required.");
      await request("set_session_name", { name: title.trim() });
      state.sessionName = title.trim();
    },
    async dispose() {
      if (disposing) return;
      disposing = true;
      setStatus("stopping");
      cancelApprovals();
      if (!closed && state.isStreaming) await request("abort").catch(() => undefined);
      if (!closed) child.stdin.end();
      if (!closed) await new Promise((resolve) => child.once("exit", resolve));
      closed = true;
      setStatus("closed");
    },
  };
}
