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
  if (config.resourceRules?.length) throw fail("unsupported-resource-policy", "Pi RPC does not expose per-session skill or MCP filtering.");
  if (typeof config.runtimeProgram !== "string" || !Array.isArray(config.runtimeArgs)) {
    throw fail("runtime-unavailable", "The Pi runtime is not installed.");
  }

  let nativeModelFeatures;
  try {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    const { isAbsolute } = await import("node:path");
    const entry = config.runtimeArgs.find(value => typeof value === "string" && isAbsolute(value) && value.endsWith(".js"));
    if (entry) for (const base of createRequire(entry).resolve.paths("@earendil-works/pi-ai") ?? []) {
      const root = join(base, "@earendil-works/pi-ai");
      let manifest;
      try { manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { continue; }
      if (manifest.exports?.["."]?.import !== "./dist/index.js") break;
      nativeModelFeatures = await import(pathToFileURL(join(root, "dist/index.js")).href);
      break;
    }
  } catch { /* Older Pi builds may only report reasoning for the current model through RPC. */ }

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
  let compactionId;
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

  // Tool arguments and results are arbitrary native values. Blocks carry only a
  // one-line title and bounded output text, never the raw objects.
  const TOOL_TEXT_LIMIT = 16 * 1024;
  const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
  const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;
  // Cuts never split a surrogate pair: the host rejects lone surrogates.
  const headEnd = (text, end) => (isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end);
  const tailStart = (text, start) => (isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
  const oneLine = (value, limit) => {
    const line = String(value).replace(/\s+/g, " ").trim();
    return line.length <= limit ? line : `${line.slice(0, headEnd(line, limit - 1))}…`;
  };
  const boundToolText = (value) => {
    const text = value.toWellFormed?.() ?? value;
    if (text.length <= TOOL_TEXT_LIMIT) return { text, truncated: false };
    const half = Math.floor(TOOL_TEXT_LIMIT / 2);
    const head = headEnd(text, half);
    const tail = tailStart(text, text.length - half);
    const marker = `\n… ${tail - head} characters omitted …\n`;
    return { text: `${text.slice(0, head)}${marker}${text.slice(tail)}`, truncated: true };
  };
  const compactArgs = (args) => Object.entries(args).slice(0, 8).map(([key, value]) => {
    if (typeof value === "string") return `${key}: ${oneLine(value, 60)}`;
    if (["number", "boolean"].includes(typeof value) || value === null) return `${key}: ${value}`;
    return `${key}: ${Array.isArray(value) ? "[…]" : "{…}"}`;
  }).join(", ");
  const toolTitle = (toolName, args) => {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const text = (value) => (typeof value === "string" && value.trim() ? value : "");
    let detail;
    if (toolName === "bash") detail = text(input.command);
    else if (["read", "edit", "write", "ls"].includes(toolName)) detail = text(input.path);
    else if (toolName === "grep" || toolName === "find") {
      detail = [text(input.pattern), text(input.path)].filter(Boolean).join(" in ");
    } else detail = compactArgs(input);
    return oneLine(detail ? `${toolName}: ${detail}` : toolName, 200);
  };
  const toolResultText = (result) => {
    const parts = Array.isArray(result?.content) ? result.content : [];
    return parts.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return part?.type === "image" ? "[image]" : "[unsupported content]";
    }).join("\n");
  };

  // Completes the in-flight compaction block. Native end events are
  // authoritative; turn settlement and the compact response are fallbacks.
  const finishCompaction = (nextStatus, safeSummary) => {
    if (!compactionId) return;
    updateBlock(compactionId, { status: nextStatus, safeSummary });
    compactionId = undefined;
  };
  // The native summary and error text stay private; only the outcome is shown.
  const compactionOutcome = (frame) => {
    if (frame.aborted === true) return { status: "interrupted", summary: "Context compaction was cancelled." };
    if (frame.result) return { status: "complete", summary: "Context was compacted." };
    return { status: "failed", summary: "Context compaction failed." };
  };

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
    ...(nativeModelFeatures?.getSupportedThinkingLevels ? { thinkingLevels: nativeModelFeatures.getSupportedThinkingLevels(candidate) } : Array.isArray(candidate.thinkingLevels) ? { thinkingLevels: candidate.thinkingLevels.filter((x) => typeof x === "string") } : {}),
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

  // Select values stay adapter-private. The host sees opaque option ids with
  // bounded one-line labels and answers with an id (or label) in `text`.
  const MAX_SELECT_OPTIONS = 200;
  const selectChoices = (values) => values.slice(0, MAX_SELECT_OPTIONS).map((value, index) => ({
    id: `option-${index + 1}`,
    label: oneLine(value, 200) || `Option ${index + 1}`,
    value,
  }));

  const handleExtensionRequest = (frame) => {
    if (!["select", "confirm", "input", "editor"].includes(frame.method) || typeof frame.id !== "string") {
      if (typeof frame.id === "string") writeNative({ type: "extension_ui_response", id: frame.id, cancelled: true });
      return;
    }
    const id = `pi-approval-${++blockSequence}`;
    const offered = frame.method === "select" && Array.isArray(frame.options)
      ? frame.options.filter((value) => typeof value === "string")
      : [];
    const choices = frame.method === "select" ? selectChoices(offered) : undefined;
    let description = typeof frame.message === "string" ? frame.message : "Pi needs a response to continue.";
    if (offered.length > MAX_SELECT_OPTIONS) {
      description = `${description} Only the first ${MAX_SELECT_OPTIONS} options can be chosen here.`;
    }
    let decisions = ["approve-once", "cancel"];
    if (frame.method === "confirm") decisions = ["approve-once", "deny", "cancel"];
    else if (choices?.length === 0) decisions = ["cancel"];
    const approval = {
      id,
      kind: frame.method === "confirm" ? "permission" : "input",
      title: typeof frame.title === "string" ? frame.title : "Pi request",
      description,
      decisions,
      ...(frame.method === "input" || frame.method === "editor" ? { inputLabel: frame.placeholder ?? "Response" } : {}),
      ...(choices ? { options: choices.map((choice) => ({ id: choice.id, label: choice.label })) } : {}),
    };
    approvals.set(id, { nativeId: frame.id, method: frame.method, approval, choices });
    emit({ type: "approval", approval });
  };

  // Builds the native reply before the request is retired, so an invalid
  // answer is rejected and the dialog stays answerable.
  const extensionResponse = (item, decision, text) => {
    const id = item.nativeId;
    if (decision === "cancel") return { type: "extension_ui_response", id, cancelled: true };
    if (item.method === "confirm") return { type: "extension_ui_response", id, confirmed: decision === "approve-once" };
    if (item.method === "select") {
      const choice = item.choices.find((option) => option.id === text)
        ?? item.choices.find((option) => option.label === text || option.value === text);
      if (!choice) throw fail("invalid-response", "Choose one of the offered options.");
      return { type: "extension_ui_response", id, value: choice.value };
    }
    if (typeof text === "string") return { type: "extension_ui_response", id, value: text };
    throw fail("invalid-response", "This approval response requires text.");
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
      case "agent_settled": case "agent_end":
        finishCompaction("complete", "Context compaction ended.");
        settleTurn();
        setStatus("idle");
        break;
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
        if (frame.message?.role === "assistant" && frame.message.usage) {
          const native = frame.message.usage;
          const usage = { id: createHash("sha256").update(JSON.stringify(frame.message)).digest("hex") };
          for (const [source, target] of [["input","inputTokens"],["output","outputTokens"],["cacheRead","cacheReadTokens"],["cacheWrite","cacheWriteTokens"],["totalTokens","totalTokens"]]) {
            if (Number.isSafeInteger(native[source]) && native[source] >= 0) usage[target] = native[source];
          }
          emit({ type: "usage", usage });
        }

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
        const existing = blocks.get(id);
        const toolName = existing?.toolName ?? safeToolName(frame.toolName);
        const ended = frame.type === "tool_execution_end";
        // Updates carry the accumulated partial result, so each replaces the text.
        const result = ended ? frame.result : frame.partialResult;
        const output = result === undefined ? undefined : boundToolText(toolResultText(result));
        putBlock({
          ...(existing ?? { id, kind: "tool", label: toolName, toolName, collapsible: true }),
          status: ended ? (frame.isError ? "failed" : "complete") : "streaming",
          ...(frame.args !== undefined ? { title: toolTitle(toolName, frame.args) } : {}),
          ...(output ? { text: output.text, truncated: output.truncated } : {}),
          ...(ended ? { safeSummary: frame.isError ? "The tool failed." : "The tool completed." } : {}),
        });
        break;
      }
      // Older Pi builds report automatic compaction with the auto_ prefix.
      case "compaction_start": case "auto_compaction_start":
        finishCompaction("complete", "Context compaction ended.");
        compactionId = `pi-compaction-${++blockSequence}`;
        putBlock({
          id: compactionId, kind: "compaction", label: "Compaction", status: "streaming",
          safeSummary: "Context is being compacted.",
        });
        break;
      case "compaction_end": case "auto_compaction_end": {
        const outcome = compactionOutcome(frame);
        if (compactionId) finishCompaction(outcome.status, outcome.summary);
        else if (outcome.status === "failed") {
          // Overflow recovery can report a failure without a matching start.
          putBlock({
            id: `pi-compaction-${++blockSequence}`, kind: "compaction", label: "Compaction",
            status: "failed", safeSummary: outcome.summary,
          });
        }
        break;
      }
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
    async resources() {
      const items = [...builtInTools].map(id => ({ kind: "tool", id, name: id, enabled: true, configurable: true }));
      const warnings = [];
      try {
        const result = await request("get_commands");
        for (const command of result.commands ?? []) if (command.source === "skill") items.push({ kind: "skill", id: command.name, name: command.name.replace(/^skill:/, ""), enabled: true, configurable: false });
      } catch { warnings.push("Skills could not be loaded from Pi."); }
      return { items, warnings };
    },
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
    composerCapabilities() { return { steer: true, compact: true }; },
    async compact() {
      if (status !== "idle") throw fail("turn-active", "Wait for the current turn before compacting.");
      setStatus("running");
      void request("compact", {})
        .then(() => finishCompaction("complete", "Context was compacted."))
        .catch(() => {
          finishCompaction("failed", "Context compaction failed.");
          emit({ type: "error", message: "Context compaction failed." });
        })
        .finally(() => setStatus("idle"));
      return { accepted: true };
    },
    async prompt({ text, mode }) {
      if (typeof text !== "string" || !text.trim()) throw fail("invalid-request", "A non-empty prompt is required.");
      if (mode === "steer") {
        if (status !== "running") throw fail("no-active-turn", "There is no active turn to steer.");
        await request("steer", { message: text });
      } else {
        if (!["prompt", "follow-up"].includes(mode)) throw fail("invalid-request", "The prompt mode is invalid.");
        // Admission must precede native events, which may arrive before ACK.
        admittedTurns += 1;
        try {
          if (mode === "follow-up") await request("follow_up", { message: text });
          else await request("prompt", { message: text, streamingBehavior: "followUp" });
        } catch (error) { admittedTurns = Math.max(0, admittedTurns - 1); throw error; }
      }
      return { accepted: true };
    },
    async interrupt() { cancelApprovals(); await request("abort"); },
    async catalogModels() { return (await this.models()).map(model => ({ ...model, supportsFast: false })); },
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
      const response = extensionResponse(item, decision, text);
      approvals.delete(requestId);
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
