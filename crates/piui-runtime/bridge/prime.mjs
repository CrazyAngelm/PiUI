export async function createPrimeAdapter(config, emit, coordinatorRequest) {
  const { createHash } = await import("node:crypto");
  const { readFile, stat } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { isAbsolute, join, relative, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");

  const fail = (code, safeMessage) => Object.assign(new Error(code), { bridgeCode: code, safeMessage });
  if (config.harness !== "prime-agent") throw fail("wrong-harness", "The Prime adapter received an invalid harness configuration.");
  if (![config.cwd, config.sessionDir, config.packageRoot, config.agentDir].every((value) => typeof value === "string" && isAbsolute(value))) {
    throw fail("runtime-unavailable", "The Prime runtime configuration is unavailable.");
  }
  if (typeof config.daemonSocket !== "string" || !config.daemonSocket.includes("piui")) {
    throw fail("unsafe-daemon-endpoint", "Prime requires an explicit PiUI-owned non-default daemon endpoint guard.");
  }
  if (config.permissionMode !== "native") {
    throw fail("unsupported-policy", "This Prime adapter currently supports only Prime's native permission policy.");
  }
  if (config.nativeSubagents === false && (!Array.isArray(config.allowedTools) || config.allowedTools.includes("ipython"))) {
    throw fail("unsupported-policy", "Disabling native Prime RLM requires an enforced tool allowlist without ipython.");
  }
  if (config.nativeSubagents === true && Array.isArray(config.allowedTools) && !config.allowedTools.includes("ipython")) {
    throw fail("unsupported-policy", "Native Prime RLM requires the ipython tool in the enforced tool policy.");
  }
  if (config.coordination === true && typeof coordinatorRequest !== "function") {
    throw fail("coordinator-unavailable", "Coordinator tools are not available for this managed session.");
  }
  if (config.coordination === true && Array.isArray(config.allowedTools) && !config.allowedTools.includes("workspace")) {
    throw fail("unsupported-policy", "Managed coordination requires the workspace tool in the enforced tool policy.");
  }
  if (config.kernelPython !== undefined && (typeof config.kernelPython !== "string" || !isAbsolute(config.kernelPython))) {
    throw fail("runtime-unavailable", "The configured Prime kernel runtime is invalid.");
  }

  const packageRoot = resolve(config.packageRoot);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); }
  catch { throw fail("runtime-unavailable", "The Prime SDK package could not be loaded."); }
  if (manifest?.name !== "prime-agent" || !["0.9.2", "0.9.3"].includes(manifest?.version) || manifest?.exports?.["."]?.import !== "./dist/index.js") {
    throw fail("unsupported-version", "The installed Prime Agent version is not supported.");
  }
  if (config.kernelPython) process.env.PRIME_AGENT_KERNEL_PYTHON = config.kernelPython;

  let sdk;
  try { sdk = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href); }
  catch { throw fail("runtime-unavailable", "The Prime SDK package could not be loaded."); }

  let nativeModelFeatures;
  try {
    const requireFromPrime = createRequire(join(packageRoot, "package.json"));
    // This SDK ships an import-only aliased package, so CJS resolve cannot use its root export.
    for (const base of requireFromPrime.resolve.paths("@earendil-works/pi-ai") ?? []) {
      const root = join(base, "@earendil-works/pi-ai");
      let modelManifest;
      try { modelManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { continue; }
      if (modelManifest.exports?.["."]?.import !== "./dist/index.js") break;
      nativeModelFeatures = await import(pathToFileURL(join(root, "dist/index.js")).href);
      break;
    }
  } catch { /* Older SDK packages can still run without optional model feature discovery. */ }
  let workspaceTool;
  if (config.coordination === true) {
    let Type;
    try {
      const requireFromPrime = createRequire(join(packageRoot, "package.json"));
      let typeboxEntry;
      try { typeboxEntry = requireFromPrime.resolve("typebox"); }
      catch {
        const declared = manifest?.dependencies?.typebox;
        if (typeof declared !== "string" || !declared.startsWith("file:")) throw new Error("unresolved typebox");
        typeboxEntry = resolve(packageRoot, declared.slice("file:".length), "build", "index.mjs");
        const typeboxRelative = relative(packageRoot, typeboxEntry);
        if (typeboxRelative.startsWith("..") || isAbsolute(typeboxRelative)) throw new Error("typebox escaped package root");
      }
      ({ Type } = await import(pathToFileURL(typeboxEntry).href));
    } catch {
      throw fail("runtime-unavailable", "Prime's native tool schema dependency is unavailable.");
    }
    const exact = { additionalProperties: false };
    workspaceTool = sdk.defineTool({
      name: "workspace",
      label: "Workspace coordinator",
      description: "Use the authenticated workspace coordinator to list members, send messages, observe results, start a predefined step, or create an agent using an allowed profile from roster. New agents inherit that profile's permissions. Use wait with the returned memberId to collect an observed agent's result before completing your own task.",
      parameters: Type.Union([
        Type.Object({ type: Type.Literal("roster") }, exact),
        Type.Object({ type: Type.Literal("send"), recipientMemberId: Type.String(), body: Type.String() }, exact),
        Type.Object({ type: Type.Literal("observe"), targetMemberId: Type.String() }, exact),
        Type.Object({ type: Type.Literal("wait"), targetMemberId: Type.String() }, exact),
        Type.Object({ type: Type.Literal("spawn"), stepId: Type.String() }, exact),
        Type.Object({ type: Type.Literal("spawnAgent"), profileId: Type.String(), name: Type.String(), instructions: Type.String() }, exact),
      ]),
      async execute(toolCallId, operation, signal) {
        try {
          const result = await coordinatorRequest(operation, { toolCallId, ...(signal ? { signal } : {}) });
          return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: { operation: operation.type, ok: true } };
        } catch (error) {
          const message = typeof error?.safeMessage === "string" ? error.safeMessage : "The workspace coordinator could not complete the request.";
          throw new Error(message);
        }
      },
    });
  }

  const sessionRoot = resolve(config.sessionDir);
  const containedSessionPath = (input) => {
    const target = resolve(input);
    const rel = relative(sessionRoot, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.toLowerCase().endsWith(".jsonl")) {
      throw fail("invalid-session", "The Prime session path is outside the owned session root.");
    }
    return target;
  };
  const isMaterialized = async (sessionFile) => {
    if (typeof sessionFile !== "string" || !sessionFile) return false;
    const target = containedSessionPath(sessionFile);
    try { return (await stat(target)).isFile(); }
    catch (error) {
      if (error?.code === "ENOENT") return false;
      throw fail("runtime-unavailable", "The Prime session materialization state is unavailable.");
    }
  };
  let sessionManager;
  if (config.nativePath) {
    sessionManager = sdk.SessionManager.open(containedSessionPath(config.nativePath), sessionRoot);
  } else if (config.nativeId) {
    const sessions = await sdk.SessionManager.listAll(undefined, sessionRoot);
    const matches = sessions.filter((item) => item.id === config.nativeId);
    if (matches.length !== 1) throw fail("invalid-session", "The selected Prime session is unavailable.");
    sessionManager = sdk.SessionManager.open(containedSessionPath(matches[0].path), sessionRoot);
  } else {
    sessionManager = sdk.SessionManager.create(config.cwd, sessionRoot);
  }

  const authStorage = sdk.AuthStorage.create(join(config.agentDir, "auth.json"), { usePrimeCliConfig: true });
  if (config.catalogOnly === true) {
    const modelRegistry = sdk.ModelRegistry.create(authStorage, join(config.agentDir, 'models.json'));
    const services = await sdk.createAgentSessionServices({ cwd: config.cwd, agentDir: config.agentDir, authStorage, modelRegistry, telemetryDisabled: true });
    const map = candidate => ({ id: candidate.id, provider: candidate.provider, name: candidate.name ?? candidate.id, ...(nativeModelFeatures?.getSupportedThinkingLevels ? { thinkingLevels: nativeModelFeatures.getSupportedThinkingLevels(candidate) } : {}) });
    return {
      async models() { return services.modelRegistry.getAvailable().map(map); },
      async catalogModels() { return services.modelRegistry.getAvailable().map(model => ({ ...map(model), supportsFast: nativeModelFeatures?.supportsFastMode?.(model) === true })); },
      async resources() {
        const tool = sdk.createIpythonTool(config.cwd);
        return { items: [
          ...services.resourceLoader.getSkills().skills.map(skill => ({ kind: 'skill', id: skill.name, name: skill.name, enabled: true, configurable: true })),
          { kind: 'tool', id: tool.name, name: tool.name, enabled: true, configurable: true },
        ], warnings: [] };
      },
      async dispose() { return { disposed: true }; },
    };
  }
  let selectedModel = config.model?.id ? { id: config.model.id, provider: config.model.provider } : undefined;
  if ((config.resourceRules ?? []).some(rule => rule.kind !== "skill")) throw fail("unsupported-resource-policy", "Prime does not expose per-session MCP disabling, including built-in integrations.");
  if (config.pluginMcpServers?.length) throw fail("unsupported-settings", "Prime Agent cannot take a plugin's MCP server for one chat.");
  const createRuntime = async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
    const settingsManager = sdk.SettingsManager.create(cwd, config.agentDir);
    const modelRegistry = sdk.ModelRegistry.create(authStorage, join(config.agentDir, "models.json"));
    let model;
    if (selectedModel) {
      const available = await modelRegistry.getAvailable();
      const matches = available.filter((candidate) => candidate.id === selectedModel.id && (!selectedModel.provider || candidate.provider === selectedModel.provider));
      if (matches.length !== 1) throw fail("model-unavailable", "The selected Prime model is unavailable or not authenticated.");
      model = matches[0];
    }
    if (config.serviceTier === "fast" && nativeModelFeatures?.supportsFastMode?.(model) !== true) throw fail("unsupported-settings", "This Prime model does not support Fast.");
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir: config.agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoaderOptions: {
        ...((config.resourceRules ?? []).length ? { skillsOverride: (base) => {
          if (config.resourceRules.some(rule => rule.enabled && !base.skills.some(skill => skill.name === rule.id))) throw fail("resource-unavailable", "An enabled Prime skill is not available in the native resource loader.");
          return { ...base, skills: base.skills.filter(skill => !config.resourceRules.some(rule => rule.kind === "skill" && rule.id === skill.name && !rule.enabled)) };
        } } : {}),
        ...(typeof config.instructions === "string" && config.instructions.trim() ? { appendSystemPrompt: [config.instructions] } : {}),
      },
    });
    return {
      ...(await sdk.createAgentSessionFromServices({
        services,
        sessionManager: manager,
        sessionStartEvent,
        ...(model ? { model } : {}),
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
        ...(config.serviceTier ? { serviceTier: config.serviceTier === "fast" ? "priority" : "default" } : {}),
        ...(Array.isArray(config.allowedTools) ? { tools: config.allowedTools } : {}),
        ...(workspaceTool ? { customTools: [workspaceTool] } : {}),
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir: config.agentDir,
    sessionManager,
  });
  const connection = new sdk.InProcessAgentConnection(runtime);
  await connection.bindHeadlessExtensions();
  const applyServiceTier = async (tier) => {
    if (!["standard", "fast"].includes(tier) || typeof connection.setServiceTier !== "function") throw fail("unsupported-settings", "Prime service tiers are unavailable.");
    const current = await connection.getState();
    if (tier === "fast" && nativeModelFeatures?.supportsFastMode?.(current.model) !== true) throw fail("unsupported-settings", "This Prime model does not support Fast.");
    await connection.setServiceTier(tier === "fast" ? "priority" : "default");
  };


  let status = "starting";
  let disposed = false;
  let model;
  let modelCatalog = [];
  let title = config.title?.trim() || runtime.session.sessionName || "Prime session";
  let sequence = 0;
  let turnOpen = false;
  let lastAssistantStopReason;
  const blocks = new Map();
  const streamBlocks = new Map();
  const opaque = (prefix, value) => `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
  const textOf = (message) => {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  };
  const safeToolName = (value) => typeof value === "string" && value.length <= 160 ? value : "tool";
  const mapModel = (candidate) => candidate && typeof candidate.id === "string" ? {
    id: candidate.id,
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
    name: typeof candidate.name === "string" ? candidate.name : candidate.id,
    ...(nativeModelFeatures?.getSupportedThinkingLevels ? { thinkingLevels: nativeModelFeatures.getSupportedThinkingLevels(candidate) } : {}),
  } : undefined;
  const putBlock = (block) => {
    blocks.set(block.id, block);
    emit({ type: "block", block });
  };
  const updateBlock = (id, patch) => {
    const current = blocks.get(id);
    if (current) putBlock({ ...current, ...patch });
  };
  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    emit({ type: "status", status: next });
  };
  const addHistory = (messages) => {
    blocks.clear();
    messages.forEach((message, index) => {
      if (!message || !["user", "assistant"].includes(message.role)) return;
      const stopped = message.role === "assistant" ? message.stopReason : undefined;
      const id = opaque("prime-message", `${message.timestamp ?? ""}:${index}:${message.role}`);
      blocks.set(id, {
        id,
        kind: message.role,
        label: message.role === "user" ? "You" : "Prime",
        status: stopped === "aborted" ? "interrupted" : stopped === "error" ? "failed" : "complete",
        text: textOf(message),
        ...(typeof message.timestamp === "number" ? { createdAt: new Date(message.timestamp).toISOString() } : {}),
      });
    });
  };

  const handleSessionEvent = (event) => {
    switch (event?.type) {
      case "agent_start":
        turnOpen = true;
        lastAssistantStopReason = undefined;
        setStatus("running");
        break;
      case "agent_end": {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const terminal = [...messages].reverse().find((message) => message?.role === "assistant");
        const stopReason = terminal?.stopReason ?? lastAssistantStopReason;
        if (turnOpen && typeof stopReason === "string") {
          const outcome = stopReason === "aborted"
            ? "interrupted"
            : stopReason === "error"
              ? "failed"
              : stopReason === "stop" || stopReason === "length"
                ? "succeeded"
                : undefined;
          if (outcome) emit({ type: "turnCompleted", outcome });
        }
        turnOpen = false;
        lastAssistantStopReason = undefined;
        setStatus("idle");
        break;
      }
      case "message_start": {
        if (event.message?.role === "user") {
          const id = opaque("prime-message", `${event.message.timestamp ?? Date.now()}:user:${++sequence}`);
          putBlock({ id, kind: "user", label: "You", status: "complete", text: textOf(event.message) });
        }
        break;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (!delta || typeof delta.type !== "string") break;
        const index = Number.isInteger(delta.contentIndex) ? delta.contentIndex : 0;
        const kind = delta.type.startsWith("thinking") ? "thinking" : "assistant";
        const key = `${kind}:${index}`;
        let id = streamBlocks.get(key);
        if (!id) {
          id = `prime-stream-${++sequence}`;
          streamBlocks.set(key, id);
          putBlock({ id, kind, label: kind === "thinking" ? "Thinking" : "Prime", status: "streaming", text: "" });
        }
        if (delta.type.endsWith("_delta") && typeof delta.delta === "string") {
          const current = blocks.get(id);
          if (current) current.text = `${current.text ?? ""}${delta.delta}`;
          emit({ type: "textDelta", blockId: id, text: delta.delta });
        } else if (delta.type.endsWith("_end") || delta.type === "done") updateBlock(id, { status: "complete" });
        else if (delta.type === "error") updateBlock(id, { status: "failed", safeSummary: "The Prime turn ended with an error." });
        break;
      }
      case "message_end": {
        if (event.message?.role === "assistant" && event.message.usage) {
          const native = event.message.usage;
          const usage = { id: createHash("sha256").update(JSON.stringify(event.message)).digest("hex") };
          for (const [source, target] of [["input","inputTokens"],["output","outputTokens"],["cacheRead","cacheReadTokens"],["cacheWrite","cacheWriteTokens"],["totalTokens","totalTokens"]]) {
            if (Number.isSafeInteger(native[source]) && native[source] >= 0) usage[target] = native[source];
          }
          emit({ type: "usage", usage });
        }

        if (event.message?.role === "assistant") {
          lastAssistantStopReason = event.message.stopReason;
          const next = event.message.stopReason === "aborted" ? "interrupted" : event.message.stopReason === "error" ? "failed" : "complete";
          for (const id of streamBlocks.values()) updateBlock(id, { status: next });
          streamBlocks.clear();
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        if (typeof event.toolCallId !== "string") break;
        const id = opaque("prime-tool", event.toolCallId);
        const toolName = safeToolName(event.toolName);
        const next = event.type === "tool_execution_end" ? (event.isError ? "failed" : "complete") : "streaming";
        putBlock({ id, kind: "tool", label: toolName, toolName, collapsible: true, status: next,
          ...(event.type === "tool_execution_end" ? { safeSummary: event.isError ? "The tool failed." : "The tool completed." } : {}) });
        break;
      }
      case "compaction_start": putBlock({ id: `prime-compaction-${++sequence}`, kind: "compaction", label: "Compaction", status: "streaming", safeSummary: "Context is being compacted." }); break;
      case "compaction_end": {
        const last = [...blocks.values()].reverse().find((block) => block.kind === "compaction" && block.status === "streaming");
        if (last) updateBlock(last.id, { status: "complete" });
        break;
      }
      case "rlm_child_update": {
        const id = opaque("prime-rlm", event.child?.id ?? ++sequence);
        const childStatus = event.child?.status;
        putBlock({ id, kind: "custom", label: "Prime subagent", status: childStatus === "failed" ? "failed" : ["done", "completed", "cancelled"].includes(childStatus) ? "complete" : "streaming", safeSummary: childStatus === "failed" ? "A native Prime subagent failed." : "Native Prime subagent activity." });
        break;
      }
      case "extension_error": emit({ type: "error", message: "A Prime extension failed." }); break;
    }
  };
  const unsubscribe = connection.subscribe(async (event) => {
    if (event?.type === "session_event") handleSessionEvent(event.event);
    else if (event?.type === "extension_error") emit({ type: "error", message: "A Prime extension failed." });
    else if (event?.type === "session_replaced") {
      addHistory(event.messages ?? []);
      title = event.state?.sessionName ?? title;
      emit({ type: "binding", nativeId: event.state.sessionId, ...(event.state.sessionFile ? { nativePath: event.state.sessionFile } : {}) });
    }
  });

  const state = await connection.getState();
  model = mapModel(state.model);
  // Native session construction already performs the authoritative model/auth
  // refresh needed to choose its initial model. Reuse that registry state here
  // so initialize does not repeat environment-dependent network work. Explicit
  // `models()` requests continue to call the native refreshing API below.
  modelCatalog = runtime.services.modelRegistry.getAvailable().map(mapModel).filter(Boolean);
  addHistory(await connection.getMessages());
  setStatus(state.isStreaming ? "running" : "idle");
  emit({ type: "binding", nativeId: state.sessionId, ...(state.sessionFile ? { nativePath: state.sessionFile } : {}) });

  const activeTools = new Set(runtime.session.getActiveToolNames());
  const nativeRlm = activeTools.has("ipython");
  const capabilities = {
    prompt: { supported: true, enforcement: "native" },
    resume: { supported: true, enforcement: "native" },
    models: { supported: true, enforcement: "native" },
    approvals: { supported: false, enforcement: "unsupported", reason: "Prime headless extension UI approval mapping is not implemented." },
    instructions: { supported: true, enforcement: "native" },
    toolPolicy: Array.isArray(config.allowedTools)
      ? { supported: true, enforcement: "native" }
      : { supported: true, enforcement: "native", reason: "Prime uses its native configured tool policy." },
    nativeSubagents: nativeRlm
      ? { supported: true, enforcement: "native", reason: "Native Prime RLM is available; cross-harness coordination and explicit family messaging are separate capabilities." }
      : { supported: false, enforcement: "unsupported", reason: "Native Prime RLM requires the ipython tool." },
  };

  return {
    async snapshot() {
      if (disposed) throw fail("not-running", "The Prime runtime is not running.");
      const current = await connection.getState();
      model = mapModel(current.model);
      if (model && typeof runtime.session.getAvailableThinkingLevels === "function") {
        model.thinkingLevels = runtime.session.getAvailableThinkingLevels();
        modelCatalog = modelCatalog.map((entry) => entry.id === model.id && entry.provider === model.provider ? { ...entry, thinkingLevels: model.thinkingLevels } : entry);
      }
      return {
        nativeId: current.sessionId,
        thinkingLevel: current.thinkingLevel,
        ...(nativeModelFeatures?.supportsFastMode?.(current.model) ? { serviceTier: runtime.session.serviceTier === "priority" ? "fast" : "standard" } : {}),
        ...(current.sessionFile ? { nativePath: current.sessionFile } : {}),
        materialized: await isMaterialized(current.sessionFile),
        title: current.sessionName ?? title,
        status,
        ...(model ? { model } : {}),
        blocks: [...blocks.values()],
        approvals: [],
        capabilities,
        models: modelCatalog,
      };
    },
    // The Prime SDK connection PiUI drives takes text prompts only.
    composerCapabilities() { return { steer: typeof connection.steer === "function", compact: typeof connection.compact === "function", images: false }; },
    // No slash-command or skill-mention discovery is exposed through the SDK.
    composerCatalog() { return { commands: [], skills: [] }; },
    async compact() {
      if (typeof connection.compact !== "function") throw fail("unsupported-method", "This SDK does not support compaction.");
      if (status !== "idle") throw fail("turn-active", "Wait for the current turn before compacting.");
      setStatus("running");
      void connection.compact().catch(() => emit({ type: "error", message: "Context compaction failed." })).finally(() => setStatus("idle"));
      return { accepted: true };
    },
    async prompt({ text, mode, images }) {
      if (disposed) throw fail("not-running", "The Prime runtime is not running.");
      if (typeof text !== "string" || !text.trim()) throw fail("invalid-request", "A non-empty prompt is required.");
      if (images !== undefined && images !== null) throw fail("unsupported-input", "Prime Agent does not accept images in PiUI.");
      if (mode === "prompt") await connection.prompt(text);
      else if (mode === "steer") {
        if (status !== "running") throw fail("no-active-turn", "There is no active turn to steer.");
        await connection.steer(text);
      }
      else if (mode === "follow-up") await connection.followUp(text);
      else throw fail("invalid-request", "The prompt mode is invalid.");
      return { accepted: true };
    },
    async interrupt() {
      if (disposed) return;
      await connection.abort();
      await connection.abortBash();
    },
    async models() {
      if (disposed) throw fail("not-running", "The Prime runtime is not running.");
      modelCatalog = (await connection.getAvailableModels()).map(mapModel).filter(Boolean);
      return modelCatalog;
    },
    async resources() {
      const items = []; const warnings = [];
      try {
        for (const skill of runtime.session.resourceLoader.getSkills().skills) items.push({ kind: "skill", id: skill.name, name: skill.name, enabled: true, configurable: true });
      } catch { warnings.push("Skills could not be loaded from Prime Agent."); }
      try {
        const active = new Set(runtime.session.getActiveToolNames());
        for (const tool of runtime.session.getAllTools()) items.push({ kind: "tool", id: tool.name, name: tool.name, enabled: active.has(tool.name), configurable: ["ipython", "workspace"].includes(tool.name) });
      } catch { warnings.push("Tools could not be loaded from Prime Agent."); }
      return { items, warnings };
    },
    async setModel({ model: requested, thinkingLevel, serviceTier }) {

      if (!requested?.id) throw fail("invalid-request", "A Prime model id is required.");
      const matches = modelCatalog.filter((candidate) => candidate.id === requested.id && (!requested.provider || candidate.provider === requested.provider));
      if (matches.length !== 1 || !matches[0].provider) throw fail("model-unavailable", "The selected Prime model is unavailable or ambiguous.");
      const raw = runtime.services.modelRegistry.getAvailable().find(entry => entry.id === matches[0].id && entry.provider === matches[0].provider);
      if (thinkingLevel && nativeModelFeatures?.getSupportedThinkingLevels && !nativeModelFeatures.getSupportedThinkingLevels(raw).includes(thinkingLevel)) throw fail("invalid-settings", "Unsupported Prime reasoning level.");
      if (serviceTier === "fast" && nativeModelFeatures?.supportsFastMode?.(raw) !== true) throw fail("unsupported-settings", "This Prime model does not support Fast.");
      model = mapModel(await connection.setModel(matches[0].provider, matches[0].id));
      selectedModel = { id: matches[0].id, provider: matches[0].provider };
      if (thinkingLevel) await connection.setThinkingLevel(thinkingLevel);
      if (serviceTier) await applyServiceTier(serviceTier);
    },
    async respond() { throw fail("unsupported-method", "Prime headless approvals are not available."); },
    async rename({ title: nextTitle }) {
      if (typeof nextTitle !== "string" || !nextTitle.trim()) throw fail("invalid-request", "A non-empty session title is required.");
      await connection.setSessionName(nextTitle.trim());
      title = nextTitle.trim();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      setStatus("stopping");
      unsubscribe();
      await connection.abort().catch(() => undefined);
      await connection.abortBash().catch(() => undefined);
      await connection.dispose();
      setStatus("closed");
    },
  };
}
