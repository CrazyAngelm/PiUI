// Claude Code adapter. It drives the user's own installed, unmodified `claude`
// executable in headless stream-json mode. Claude Code owns inference, tools,
// approvals, authentication and its JSONL history; this file only translates
// the documented stream-json and control protocol. PiUI accepts a Claude
// subscription login only: API keys and cloud providers are refused.
export async function createClaudeAdapter(config, emit, coordinatorRequest) {
  const { spawn } = await import("node:child_process");
  const { createHash, randomUUID } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { homedir } = await import("node:os");
  const { isAbsolute, join, resolve } = await import("node:path");
  const { mkdtemp, readFile, rm, stat, writeFile } = await import("node:fs/promises");

  const fail = (code, safeMessage) => Object.assign(new Error(code), { bridgeCode: code, safeMessage });
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const SUBSCRIPTION_MESSAGE = "Sign in to Claude Code with your Claude subscription. API keys and cloud providers are not used by PiUI.";
  const subscriptionRequired = () => fail("claude-subscription-required", SUBSCRIPTION_MESSAGE);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
  const COORDINATOR_SERVER = "piui-workspace";
  const COORDINATOR_TOOL = `mcp__${COORDINATOR_SERVER}__workspace`;
  const FRAME_LIMIT = 32 * 1024 * 1024;

  // ---------------------------------------------------------------------------
  // Configuration. Unsupported mandatory settings fail before anything spawns.
  // ---------------------------------------------------------------------------
  if (!isRecord(config) || config.harness !== "claude-code") {
    throw fail("wrong-harness", "The Claude Code adapter received an invalid harness configuration.");
  }
  if (typeof config.cwd !== "string" || !isAbsolute(config.cwd)) {
    throw fail("invalid-configuration", "The Claude Code workspace is invalid.");
  }
  const PERMISSION_MODES = new Map([
    ["native", "default"],
    ["read-only", "plan"],
    ["workspace-write", "acceptEdits"],
    ["full-access", "bypassPermissions"],
  ]);
  const permissionMode = PERMISSION_MODES.get(config.permissionMode);
  if (!permissionMode) throw fail("unsupported-policy", "The requested Claude Code permission mode is not supported.");
  // Approvals must never widen a restrictive profile: they can only be denied.
  const strictPermissions = config.permissionMode === "read-only" || config.permissionMode === "workspace-write";
  if (config.networkAccess === true) {
    throw fail("unsupported-policy", "Claude Code cannot enforce an explicit network policy.");
  }
  if (config.baseInstructions != null) {
    throw fail("unsupported-settings", "Claude Code keeps its own base instructions; only appended instructions are supported.");
  }
  if (Array.isArray(config.resourceRules) ? config.resourceRules.length > 0 : config.resourceRules != null) {
    throw fail("unsupported-resource-policy", "Per-session Claude Code skill and MCP overrides are not supported.");
  }
  if (config.thinkingLevel != null && !EFFORT_LEVELS.has(config.thinkingLevel)) {
    throw fail("unsupported-settings", "The requested Claude Code effort level is not supported.");
  }
  if (config.serviceTier != null && config.serviceTier !== "standard" && config.serviceTier !== "fast") {
    throw fail("unsupported-settings", "The requested Claude Code speed is not supported.");
  }
  // Model values become CLI arguments, so they must never look like a flag.
  const MODEL_PATTERN = /^[A-Za-z0-9][\w.:@[\]/-]{0,127}$/;
  if (config.model != null && (!isRecord(config.model) || typeof config.model.id !== "string"
    || !MODEL_PATTERN.test(config.model.id) || (config.model.provider != null && config.model.provider !== "anthropic"))) {
    throw fail("unsupported-settings", "The requested Claude model is invalid.");
  }
  const coordination = config.coordination === true;
  if (coordination && typeof coordinatorRequest !== "function") {
    throw fail("coordinator-unavailable", "The managed Claude Code coordinator is unavailable.");
  }
  if (coordination && config.nativeSubagents === true) {
    throw fail("unsupported-policy", "Managed Claude Code runs use coordinator-only spawning and cannot also enable native subagents.");
  }
  // `--tools` restricts the built-in tool set; `--allowedTools` would only
  // pre-approve tools, so it is never used to express a restriction.
  let toolAllowlist;
  if (config.allowedTools != null) {
    if (!Array.isArray(config.allowedTools) || config.allowedTools.some((name) => typeof name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith("mcp__") || (name === "workspace" && !coordination))) {
      throw fail("unsupported-policy", "The Claude Code tool allowlist contains an unsupported tool name.");
    }
    // `workspace` names the coordinator tool, which only exists in managed runs.
    toolAllowlist = [...new Set(config.allowedTools.filter((name) => name !== "workspace"))];
  }
  if (config.nativeSubagents === true && toolAllowlist && !toolAllowlist.some((name) => name === "Agent" || name === "Task")) {
    throw fail("unsupported-policy", "Native Claude Code subagents require the Agent tool in the enforced tool policy.");
  }
  const disableSubagents = coordination || config.nativeSubagents === false;
  if (config.nativeId != null && (typeof config.nativeId !== "string" || !UUID_PATTERN.test(config.nativeId))) {
    throw fail("invalid-session", "The saved Claude Code conversation reference is invalid.");
  }
  if (typeof config.runtimeProgram !== "string" || !isAbsolute(config.runtimeProgram)) {
    throw fail("runtime-unavailable", "The Claude Code executable is not available.");
  }
  const runtimeArgs = config.runtimeArgs ?? [];
  if (!Array.isArray(runtimeArgs) || runtimeArgs.some((value) => typeof value !== "string")) {
    throw fail("invalid-configuration", "The Claude Code launch configuration is invalid.");
  }
  const catalogOnly = config.catalogOnly === true;

  // The host may hand over an extended-length Windows path. Claude Code derives
  // its project directory from the plain spelling, so it starts from that.
  const workspace = (() => {
    const value = config.cwd;
    if (process.platform !== "win32") return value;
    if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
    if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return value.slice(4);
    return value;
  })();

  // Only the native subscription login may reach the CLI: provider switches,
  // API keys and PiUI operator credentials are removed from its environment,
  // and so is the coupling a parent Claude Code host injects into its own
  // children (messaging socket and token, host-routed auth, session identity),
  // which would otherwise bind this CLI to an unrelated host session.
  const SCRUBBED_ENVIRONMENT = new Set([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH",
    "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PID",
  ]);
  const childEnvironment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (SCRUBBED_ENVIRONMENT.has(name) || name.startsWith("PIUI_AGENT_API_")) continue;
    childEnvironment[key] = value;
  }

  // Native history location, derived exactly like Claude Code derives it.
  const configHome = (() => {
    const value = process.env.CLAUDE_CONFIG_DIR;
    if (typeof value === "string" && value) return isAbsolute(value) ? value : resolve(workspace, value);
    return join(homedir(), ".claude");
  })();
  const projectKey = (() => {
    const sanitized = workspace.replace(/[^a-zA-Z0-9]/g, "-");
    if (sanitized.length <= 200) return sanitized;
    let hash = 0;
    for (let index = 0; index < workspace.length; index += 1) hash = ((hash << 5) - hash + workspace.charCodeAt(index)) | 0;
    return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
  })();
  const transcriptPath = (id) => join(configHome, "projects", projectKey, `${id}.jsonl`);
  const isFile = async (path) => {
    try { return (await stat(path)).isFile(); } catch { return false; }
  };
  const samePath = (left, right) => (process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right);

  // ---------------------------------------------------------------------------
  // Text helpers. Native tool payloads are bounded and never forwarded raw.
  // ---------------------------------------------------------------------------
  const opaque = (prefix, value) => `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
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
  const boundText = (value, limit = TOOL_TEXT_LIMIT) => {
    const text = value.toWellFormed?.() ?? value;
    if (text.length <= limit) return { text, truncated: false };
    const half = Math.floor(limit / 2);
    const head = headEnd(text, half);
    const tail = tailStart(text, text.length - half);
    const marker = `\n… ${tail - head} characters omitted …\n`;
    return { text: `${text.slice(0, head)}${marker}${text.slice(tail)}`, truncated: true };
  };
  const plain = (value) => (typeof value === "string" && value.trim() ? value : "");
  const compactArgs = (args) => Object.entries(args).slice(0, 8).map(([key, value]) => {
    if (typeof value === "string") return `${key}: ${oneLine(value, 60)}`;
    if (["number", "boolean"].includes(typeof value) || value === null) return `${key}: ${value}`;
    return `${key}: ${Array.isArray(value) ? "[…]" : "{…}"}`;
  }).join(", ");
  const safeToolName = (name) => (typeof name === "string" && name && name.length <= 160 ? name : "tool");
  const toolTitle = (name, input) => {
    let detail = "";
    if (name === "Bash" || name === "PowerShell") detail = plain(input.command);
    else if (["Read", "Edit", "Write", "MultiEdit"].includes(name)) detail = plain(input.file_path);
    else if (name === "NotebookEdit") detail = plain(input.notebook_path);
    else if (name === "Grep" || name === "Glob") detail = [plain(input.pattern), plain(input.path)].filter(Boolean).join(" in ");
    else if (name === "Task" || name === "Agent") detail = plain(input.description);
    else if (name === "WebSearch") detail = plain(input.query);
    else if (name === "WebFetch") detail = plain(input.url);
    return oneLine(detail ? `${name}: ${detail}` : name, 200);
  };
  const toolResultText = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return part?.type === "image" ? "[image]" : "[unsupported content]";
    }).join("\n");
  };
  // Claude Code's own heuristic for internal user entries (command wrappers,
  // reminders and interrupt markers); such entries are not user prompts.
  const INTERNAL_USER_TEXT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
  const userBlockId = (uuid) => opaque("claude-user", uuid);
  const toolBlockId = (toolUseId) => opaque("claude-tool", toolUseId);

  // ---------------------------------------------------------------------------
  // Catalog mapping from the native `initialize` response.
  // ---------------------------------------------------------------------------
  let catalog = [];
  let commands = [];
  const mapModels = (rows) => {
    const seen = new Set();
    const models = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isRecord(row) || typeof row.value !== "string" || !MODEL_PATTERN.test(row.value) || row.disabled === true || seen.has(row.value)) continue;
      seen.add(row.value);
      models.push({
        id: row.value,
        name: plain(row.displayName) ? oneLine(row.displayName, 120) : row.value,
        thinkingLevels: row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
          ? row.supportedEffortLevels.filter((level) => EFFORT_LEVELS.has(level))
          : [],
        supportsFast: row.supportsFastMode === true,
        resolvedModel: typeof row.resolvedModel === "string" ? row.resolvedModel : undefined,
      });
    }
    return models;
  };
  const mapCommands = (rows) => {
    const names = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (isRecord(row) && typeof row.name === "string" && row.name.trim() && row.name.length <= 200) names.add(row.name.trim());
    }
    return [...names];
  };
  const workspaceModel = (entry) => ({ id: entry.id, provider: "anthropic", name: entry.name, thinkingLevels: [...entry.thinkingLevels] });
  const findModel = (id) => catalog.find((entry) => entry.id === id);
  const resourceCatalog = () => ({
    items: commands.map((name) => ({ kind: "skill", id: name, name, enabled: true, configurable: false })),
    warnings: [],
  });

  // Subscription gate, grounded in the Claude Code account report:
  // `subscriptionType` is present only for a claude.ai subscription login;
  // `tokenSource` names a long-lived subscription token or a non-subscription
  // source (bearer token, apiKeyHelper, or `none` when not signed in);
  // `apiKeySource` is present whenever an API key would be used.
  const SUBSCRIPTION_TOKEN_SOURCES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]);
  const REFUSED_TOKEN_SOURCES = new Set(["ANTHROPIC_AUTH_TOKEN", "apiKeyHelper"]);
  const subscriptionVerified = (account) => {
    if (!isRecord(account) || account.apiProvider !== "firstParty") return false;
    if (account.apiKeySource != null && account.apiKeySource !== "none") return false;
    if (REFUSED_TOKEN_SOURCES.has(account.tokenSource)) return false;
    return plain(account.subscriptionType) !== "" || SUBSCRIPTION_TOKEN_SOURCES.has(account.tokenSource);
  };

  // ---------------------------------------------------------------------------
  // Native process and control protocol.
  // ---------------------------------------------------------------------------
  let proc;
  let processSerial = 0;
  let controlSerial = 0;
  let ready = false;
  let disposed = false;
  let sessionFailed = false;
  let restarting = false;
  const pendingControl = new Map();

  const writeFrame = (value) => new Promise((resolveWrite, rejectWrite) => {
    const current = proc;
    if (!current || current.ended || !current.child.stdin.writable) {
      rejectWrite(fail("not-running", "Claude Code is not running."));
      return;
    }
    // LF-delimited JSON; Unicode line separators are escaped for line readers.
    const line = `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
    try {
      current.child.stdin.write(line, (error) => (error ? rejectWrite(fail("not-running", "Claude Code is not running.")) : resolveWrite()));
    } catch {
      rejectWrite(fail("not-running", "Claude Code is not running."));
    }
  });
  const controlRequest = (request) => new Promise((resolveControl, rejectControl) => {
    const requestId = `piui-${++controlSerial}`;
    pendingControl.set(requestId, { resolve: resolveControl, reject: rejectControl });
    writeFrame({ type: "control_request", request_id: requestId, request }).catch((error) => {
      if (pendingControl.delete(requestId)) rejectControl(error);
    });
  });
  const answerControl = (requestId, response) => writeFrame({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  const refuseControl = (requestId, message) => writeFrame({ type: "control_response", response: { subtype: "error", request_id: requestId, error: message } });
  const withTimeout = (promise, ms) => {
    let timer;
    return Promise.race([
      promise.then(() => false, () => false),
      new Promise((resolveTimer) => { timer = setTimeout(resolveTimer, ms, true); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
  };

  const onProcessEnd = (current, spawnFailed) => {
    if (current.ended) return;
    current.ended = true;
    current.resolveExit();
    if (current !== proc) return;
    const reason = current.failure
      ? fail("invalid-native-protocol", current.failure)
      : spawnFailed
        ? fail("native-unavailable", "The Claude Code executable could not be started.")
        : fail("native-exited", "Claude Code exited before responding.");
    for (const [requestId, slot] of pendingControl) {
      pendingControl.delete(requestId);
      slot.reject(reason);
    }
    retireApprovals();
    nativeActive = false;
    if (current.expected || disposed || !ready) return;
    sessionFailed = true;
    setStatus("failed");
    emit({
      type: "error",
      message: current.failure ?? (spawnFailed ? "The Claude Code executable could not be started." : "Claude Code exited unexpectedly."),
    });
  };
  const protocolFailure = (current) => {
    current.failure = "Claude Code sent a malformed protocol frame.";
    try { current.child.kill(); } catch { /* already gone */ }
    onProcessEnd(current, false);
  };
  const onStdout = (current, chunk) => {
    if (current !== proc || current.ended) return;
    current.buffer = Buffer.concat([current.buffer, chunk]);
    let lf;
    while ((lf = current.buffer.indexOf(0x0a)) !== -1) {
      let line = current.buffer.subarray(0, lf);
      current.buffer = current.buffer.subarray(lf + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      // Protocol frames are JSON objects; anything else is not protocol output.
      if (!line.length || line[0] !== 0x7b) continue;
      let message;
      try { message = JSON.parse(line.toString("utf8")); } catch { protocolFailure(current); return; }
      if (!isRecord(message)) { protocolFailure(current); return; }
      try { handleMessage(message); } catch { unsupportedEvent("malformed"); }
      if (current !== proc || current.ended) return;
    }
    if (current.buffer.length > FRAME_LIMIT) protocolFailure(current);
  };

  // Extra launch settings survive a transparent restart.
  const launchSettings = {
    model: config.model?.id,
    effort: config.thinkingLevel ?? undefined,
    fast: config.serviceTier === "fast" ? true : config.serviceTier === "standard" ? false : undefined,
  };
  let staticArgs = [];
  const buildArgs = (sessionArgs) => [
    ...runtimeArgs,
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Replayed user messages acknowledge exactly when a queued message is
    // consumed, which keeps turn accounting exact for steer and follow-up.
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", permissionMode,
    ...sessionArgs,
    ...(launchSettings.model ? ["--model", launchSettings.model] : []),
    ...(launchSettings.effort ? ["--effort", launchSettings.effort] : []),
    // An inline --settings layer is a per-session override, never a file edit.
    ...(launchSettings.fast !== undefined ? ["--settings", JSON.stringify({ fastMode: launchSettings.fast })] : []),
    ...staticArgs,
  ];
  const launch = async (sessionArgs) => {
    let child;
    try {
      child = spawn(config.runtimeProgram, buildArgs(sessionArgs), {
        cwd: workspace,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      throw fail("native-unavailable", "The Claude Code executable could not be started.");
    }
    const current = { child, buffer: Buffer.alloc(0), ended: false, expected: false, serial: ++processSerial };
    current.exited = new Promise((resolveExit) => { current.resolveExit = resolveExit; });
    proc = current;
    child.stdout.on("data", (chunk) => onStdout(current, chunk));
    child.stderr.on("data", () => {}); // Native diagnostics may contain prompts, paths or credentials.
    child.stdin.on("error", () => {});
    const spawned = new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", () => rejectSpawn(fail("native-unavailable", "The Claude Code executable could not be started.")));
    });
    child.once("error", () => onProcessEnd(current, true));
    child.once("close", () => onProcessEnd(current, false));
    await spawned;
    return controlRequest({ subtype: "initialize" });
  };
  const stopProcess = async (current, timeoutMs) => {
    if (!current || current.ended) return;
    current.expected = true;
    try { current.child.stdin.end(); } catch { /* already closed */ }
    if (await withTimeout(current.exited, timeoutMs)) {
      try { current.child.kill(); } catch { /* already gone */ }
      await withTimeout(current.exited, 1000);
    }
  };
  const verifyInitialize = (initialized) => {
    if (!isRecord(initialized)) throw fail("native-handshake-failed", "The Claude Code handshake failed.");
    if (!subscriptionVerified(initialized.account)) throw subscriptionRequired();
    if (!catalogOnly) {
      const mode = initialized.current_permission_mode;
      if (typeof mode === "string" ? mode !== permissionMode : config.permissionMode !== "native") {
        throw fail("unsupported-policy", "Claude Code did not apply the requested permission mode.");
      }
    }
    catalog = mapModels(initialized.models);
    commands = mapCommands(initialized.commands);
  };

  // ---------------------------------------------------------------------------
  // Session state.
  // ---------------------------------------------------------------------------
  const resuming = typeof config.nativeId === "string";
  let nativeId = resuming ? config.nativeId : randomUUID();
  let nativePath = transcriptPath(nativeId);
  let title = plain(config.title) ? config.title.trim() : "Claude Code session";
  let status = "starting";
  // Live block ids stay unique across adapter instances of one session.
  const instance = randomUUID().slice(0, 8);
  let serial = 0;
  const liveId = (prefix) => `claude-${prefix}-${instance}-${++serial}`;
  let currentModelId = config.model?.id;
  let observedModel;
  let currentEffort = config.thinkingLevel ?? undefined;
  let currentTier = config.serviceTier ?? undefined;
  let nativeActive = false;
  let transcriptStarted = resuming;
  let sawConsumptionSignal = false;
  // Set when an interrupt aborted a running native turn whose result is due.
  let interruptedRunPending = false;
  let rateLimitStatus = "allowed";
  let runErrorCategory;
  let compactionId;
  let compactionSettledByStatus = false;
  const blocks = new Map();
  const approvals = new Map();
  const turns = [];
  const messageOwner = new Map();
  const deferredUserBlocks = new Map();
  const runTurns = new Set();
  const runBlocks = new Set();
  const streams = new Map();
  const tools = new Map();
  const unknownTypes = new Set();
  let streamMessageId;

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    emit({ type: "status", status: next });
  };
  const putBlock = (block) => {
    blocks.set(block.id, block);
    emit({ type: "block", block });
  };
  const updateStatus = () => {
    if (disposed || sessionFailed || !ready || restarting) return;
    setStatus(turns.length > 0 || nativeActive ? "running" : "idle");
  };
  const showError = (message) => {
    putBlock({ id: liveId("error"), kind: "error", label: "Error", status: "failed", safeSummary: message });
    emit({ type: "error", message });
  };
  const retireApprovals = () => {
    for (const requestId of [...approvals.keys()]) {
      approvals.delete(requestId);
      emit({ type: "approvalResolved", requestId });
    }
  };

  // Turn accounting. Every admitted PiUI turn owns the native user messages
  // written for it. A message is consumed when Claude Code acknowledges it
  // (command_lifecycle `started` or a replayed user message); a turn completes
  // once its messages are consumed or cancelled and its native run returned a
  // result. A steer that the running turn did not pick up runs as the next
  // native turn and stays part of the same admitted turn.
  const completeReadyTurns = () => {
    for (const turn of [...turns]) {
      if (turn.pending.size > 0 || turn.inRun) continue;
      turns.splice(turns.indexOf(turn), 1);
      for (const uuid of turn.uuids) {
        messageOwner.delete(uuid);
        deferredUserBlocks.delete(uuid);
      }
      emit({ type: "turnCompleted", outcome: turn.interrupted || !turn.ran ? "interrupted" : turn.failed ? "failed" : "succeeded" });
    }
  };
  const consumeMessage = (uuid) => {
    const turn = messageOwner.get(uuid);
    if (!turn || !turn.pending.delete(uuid)) return;
    sawConsumptionSignal = true;
    transcriptStarted = true;
    // Claude Code runs one native turn at a time: a newly consumed message
    // means any previously aborted run has already ended.
    interruptedRunPending = false;
    turn.ran = true;
    turn.inRun = true;
    runTurns.add(turn);
    const deferred = deferredUserBlocks.get(uuid);
    if (deferred) {
      deferredUserBlocks.delete(uuid);
      putBlock(deferred);
    }
    nativeActive = true;
    updateStatus();
  };
  const cancelMessage = (uuid) => {
    const turn = messageOwner.get(uuid);
    if (!turn || !turn.pending.delete(uuid)) return;
    deferredUserBlocks.delete(uuid);
    completeReadyTurns();
    updateStatus();
  };
  const markNativeActive = () => {
    if (nativeActive) return;
    nativeActive = true;
    updateStatus();
  };

  // A policy breach stops the native process immediately, before any model
  // request of the current turn can be sent.
  const stopForPolicy = (message) => {
    const current = proc;
    if (current && !current.ended) {
      current.expected = true;
      try { current.child.kill(); } catch { /* already gone */ }
    }
    sessionFailed = true;
    showError(message);
    for (const turn of turns) {
      turn.failed = true;
      turn.pending.clear();
      turn.inRun = false;
    }
    completeReadyTurns();
    retireApprovals();
    nativeActive = false;
    setStatus("failed");
  };

  // ---------------------------------------------------------------------------
  // Streaming transcript mapping.
  // ---------------------------------------------------------------------------
  const labelFor = (kind) => (kind === "thinking" ? "Thinking" : "Claude");
  const ensureTextBlock = (entry) => {
    if (entry.blockId) return entry.blockId;
    const kind = entry.type === "thinking" ? "thinking" : "assistant";
    entry.blockId = liveId(kind);
    runBlocks.add(entry.blockId);
    putBlock({ id: entry.blockId, kind, label: labelFor(kind), status: "streaming", text: "" });
    return entry.blockId;
  };
  const appendText = (entry, delta) => {
    if (typeof delta !== "string" || !delta) return;
    const id = ensureTextBlock(entry);
    const block = blocks.get(id);
    if (block) block.text = `${block.text ?? ""}${delta}`;
    emit({ type: "textDelta", blockId: id, text: delta });
  };
  const startTool = (toolUseId, name, input) => {
    const toolName = safeToolName(name);
    tools.set(toolUseId, { name: toolName });
    const id = toolBlockId(toolUseId);
    runBlocks.add(id);
    const existing = blocks.get(id);
    putBlock({
      ...(existing ?? { id, kind: "tool", label: toolName, toolName, collapsible: true, status: "streaming" }),
      title: toolTitle(toolName, isRecord(input) ? input : {}),
    });
  };
  const finishTool = (toolUseId, content, isError) => {
    const toolName = tools.get(toolUseId)?.name ?? "tool";
    const id = toolBlockId(toolUseId);
    const output = boundText(toolResultText(content));
    putBlock({
      ...(blocks.get(id) ?? { id, kind: "tool", label: toolName, toolName, collapsible: true, title: toolName }),
      status: isError ? "failed" : "complete",
      text: output.text,
      truncated: output.truncated,
      safeSummary: isError ? "The tool failed." : "The tool completed.",
    });
  };
  const handleStreamEvent = (message) => {
    if (message.parent_tool_use_id != null || !isRecord(message.event)) return;
    const event = message.event;
    markNativeActive();
    if (event.type === "message_start") {
      streamMessageId = isRecord(event.message) && typeof event.message.id === "string" ? event.message.id : `stream-${++serial}`;
      streams.set(streamMessageId, []);
      return;
    }
    if (streamMessageId === undefined) {
      streamMessageId = `stream-${++serial}`;
      streams.set(streamMessageId, []);
    }
    const entries = streams.get(streamMessageId);
    if (event.type === "content_block_start" && isRecord(event.content_block) && Number.isInteger(event.index)) {
      const block = event.content_block;
      const entry = { index: event.index, type: block.type, matched: false };
      entries.push(entry);
      if (block.type === "tool_use" && typeof block.id === "string") {
        entry.toolId = block.id;
        startTool(block.id, block.name, {});
      } else if (block.type === "text") appendText(entry, block.text);
      else if (block.type === "thinking") appendText(entry, block.thinking);
      return;
    }
    const entry = entries.find((candidate) => candidate.index === event.index);
    if (!entry) return;
    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && entry.type === "text") appendText(entry, event.delta.text);
      else if (event.delta.type === "thinking_delta" && entry.type === "thinking") appendText(entry, event.delta.thinking);
    } else if (event.type === "content_block_stop" && entry.blockId && (entry.type === "text" || entry.type === "thinking")) {
      const block = blocks.get(entry.blockId);
      if (block?.status === "streaming") putBlock({ ...block, status: "complete" });
    }
  };
  const finalizeText = (entry, kind, text, aborted) => {
    let id = entry?.blockId;
    if (!id) {
      if (!text) return;
      id = liveId(kind);
      if (entry) entry.blockId = id;
      runBlocks.add(id);
    }
    const existing = blocks.get(id) ?? { id, kind, label: labelFor(kind) };
    const next = { ...existing, text: text || existing.text || "", status: aborted ? "interrupted" : "complete" };
    if (existing.text === next.text && existing.status === next.status) return;
    putBlock(next);
  };
  const handleAssistant = (message) => {
    if (message.parent_tool_use_id != null || !isRecord(message.message)) return;
    markNativeActive();
    // API failures arrive as synthetic assistant messages; their raw text can
    // contain provider details, so only the category is kept.
    if (typeof message.error === "string" || message.is_api_error_message === true || message.isApiErrorMessage === true) {
      runErrorCategory = typeof message.error === "string" ? message.error : "unknown";
      return;
    }
    const payload = message.message;
    const entries = typeof payload.id === "string" ? streams.get(payload.id) : undefined;
    const aborted = message.aborted === true;
    for (const part of Array.isArray(payload.content) ? payload.content : []) {
      if (!isRecord(part)) continue;
      if (part.type === "text" || part.type === "thinking") {
        const entry = entries?.find((candidate) => !candidate.matched && candidate.type === part.type);
        if (entry) entry.matched = true;
        const text = part.type === "text" ? part.text : part.thinking;
        finalizeText(entry, part.type === "text" ? "assistant" : "thinking", typeof text === "string" ? text : "", aborted);
      } else if (part.type === "tool_use" && typeof part.id === "string") {
        const entry = entries?.find((candidate) => candidate.toolId === part.id);
        if (entry) entry.matched = true;
        startTool(part.id, part.name, part.input);
      } else if (part.type !== "redacted_thinking") {
        unsupportedEvent(`content:${typeof part.type === "string" ? part.type : "unknown"}`);
      }
    }
  };
  const handleUser = (message) => {
    // Replays acknowledge the exact moment a written message was consumed.
    if (message.isReplay === true) {
      if (typeof message.uuid === "string") consumeMessage(message.uuid);
      return;
    }
    if (message.parent_tool_use_id != null || !isRecord(message.message) || !Array.isArray(message.message.content)) return;
    // Other main-thread user entries are native tool results or internal
    // markers; only the tool results belong in the timeline.
    for (const part of message.message.content) {
      if (isRecord(part) && part.type === "tool_result" && typeof part.tool_use_id === "string") {
        finishTool(part.tool_use_id, part.content, part.is_error === true);
      }
    }
  };
  const resultErrorMessage = (message) => {
    const httpStatus = Number.isInteger(message.api_error_status) ? message.api_error_status : undefined;
    const category = runErrorCategory;
    if (message.subtype === "error_max_turns") return "Claude Code reached the turn limit for this request.";
    if (message.subtype === "error_max_budget_usd") return "Claude Code reached the budget limit for this request.";
    if (["authentication_failed", "oauth_org_not_allowed"].includes(category) || httpStatus === 401 || httpStatus === 403) {
      return "Claude Code could not authenticate. Sign in to Claude Code with your Claude subscription again.";
    }
    if (category === "rate_limit" || httpStatus === 429) return "Your Claude subscription usage limit was reached.";
    if (category === "billing_error" || category === "account_on_hold") return "Your Claude account needs attention before Claude Code can continue.";
    if (["overloaded", "server_error"].includes(category) || (httpStatus !== undefined && httpStatus >= 500)) return "The Claude service is temporarily unavailable.";
    if (category === "model_not_found") return "The selected Claude model is unavailable for this account.";
    if (category === "max_output_tokens") return "Claude reached its output limit for this response.";
    if (category === "invalid_request" || httpStatus === 400) return "Claude rejected the request.";
    return "Claude Code could not complete this turn.";
  };
  const emitUsage = (message) => {
    const native = message.usage;
    if (!isRecord(native)) return;
    const usage = { id: opaque("claude-usage", typeof message.uuid === "string" ? message.uuid : `${nativeId}:${++serial}`) };
    for (const [source, target] of [
      ["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cacheReadTokens"], ["cache_creation_input_tokens", "cacheWriteTokens"],
    ]) {
      if (Number.isSafeInteger(native[source]) && native[source] >= 0) usage[target] = native[source];
    }
    const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter((value) => value !== undefined);
    if (parts.length === 0) return;
    usage.totalTokens = parts.reduce((sum, value) => sum + value, 0);
    emit({ type: "usage", usage });
  };
  const handleResult = (message) => {
    nativeActive = false;
    emitUsage(message);
    if (runTurns.size === 0 && turns.length > 0) {
      const echoed = typeof message.user_message_uuid === "string" ? message.user_message_uuid : undefined;
      if (echoed && messageOwner.has(echoed)) consumeMessage(echoed);
      else if (!sawConsumptionSignal) {
        // A CLI without consumption acknowledgements: settle in admission order.
        const [oldest] = turns;
        for (const uuid of [...oldest.pending]) consumeMessage(uuid);
      }
      nativeActive = false;
    }
    const interrupted = interruptedRunPending || [...runTurns].some((turn) => turn.interrupted);
    interruptedRunPending = false;
    const failed = !(message.subtype === "success" && message.is_error !== true);
    const settled = interrupted ? "interrupted" : failed ? "failed" : "complete";
    for (const id of runBlocks) {
      const block = blocks.get(id);
      if (block?.status === "streaming") putBlock({ ...block, status: settled });
    }
    runBlocks.clear();
    streams.clear();
    streamMessageId = undefined;
    if (failed && !interrupted) showError(resultErrorMessage(message));
    for (const turn of runTurns) {
      turn.inRun = false;
      if (failed) turn.failed = true;
    }
    runTurns.clear();
    runErrorCategory = undefined;
    completeReadyTurns();
    updateStatus();
  };

  const rebind = (sessionId) => {
    nativeId = sessionId;
    nativePath = transcriptPath(sessionId);
    emit({ type: "binding", nativeId, nativePath });
  };
  const observeModel = (model) => {
    const selected = currentModelId ? findModel(currentModelId) : undefined;
    if (selected && (selected.id === model || selected.resolvedModel === model)) return;
    const match = catalog.find((entry) => entry.id === model) ?? catalog.find((entry) => entry.resolvedModel === model);
    if (match) {
      currentModelId = match.id;
      observedModel = undefined;
    } else {
      currentModelId = undefined;
      observedModel = { id: oneLine(model, 160), provider: "anthropic", name: oneLine(model, 160) };
    }
  };
  const handleInit = (message) => {
    markNativeActive();
    if (message.apiKeySource != null && message.apiKeySource !== "none") {
      stopForPolicy(SUBSCRIPTION_MESSAGE);
      return;
    }
    if (config.permissionMode !== "native" && typeof message.permissionMode === "string" && message.permissionMode !== permissionMode) {
      stopForPolicy("Claude Code left the requested permission mode; the session was stopped.");
      return;
    }
    if (typeof message.session_id === "string" && UUID_PATTERN.test(message.session_id) && message.session_id !== nativeId) {
      rebind(message.session_id);
    }
    if (typeof message.model === "string" && message.model) observeModel(message.model);
  };
  const startCompaction = () => {
    if (compactionId) return;
    compactionId = liveId("compaction");
    compactionSettledByStatus = false;
    putBlock({ id: compactionId, kind: "compaction", label: "Compaction", status: "streaming", safeSummary: "Context is being compacted." });
  };
  const finishCompaction = (next, summary) => {
    const block = blocks.get(compactionId);
    compactionId = undefined;
    if (block) putBlock({ ...block, status: next, safeSummary: summary });
  };
  const handleSystem = (message) => {
    switch (message.subtype) {
      case "init":
        handleInit(message);
        return;
      case "status":
        if (message.status === "compacting") startCompaction();
        else if (compactionId) {
          const failedCompaction = message.compact_error !== undefined && message.compact_error !== null;
          finishCompaction(failedCompaction ? "failed" : "complete", failedCompaction ? "Context compaction failed." : "Context was compacted.");
          compactionSettledByStatus = !failedCompaction;
        }
        return;
      case "compact_boundary":
        if (compactionId) finishCompaction("complete", "Context was compacted.");
        else if (compactionSettledByStatus) compactionSettledByStatus = false;
        else putBlock({ id: liveId("compaction"), kind: "compaction", label: "Compaction", status: "complete", safeSummary: "Context was compacted." });
        return;
      case "informational": {
        if (!transcriptStarted || !plain(message.content)) return;
        const output = boundText(message.content, 4096);
        putBlock({
          id: liveId("notice"), kind: "custom", label: "Claude Code", status: "complete",
          title: message.level === "warning" ? "Warning" : "Notice", text: output.text, truncated: output.truncated,
        });
        return;
      }
      case "commands_changed":
        commands = mapCommands(message.commands);
        return;
      default:
        // Hooks, tasks, retries and other native metadata are not transcript content.
    }
  };
  const handleRateLimit = (message) => {
    const info = message.rate_limit_info;
    if (!isRecord(info)) return;
    if (info.status !== "allowed_warning" && info.status !== "rejected") {
      if (info.status === "allowed") rateLimitStatus = "allowed";
      return;
    }
    if (info.status === rateLimitStatus) return;
    rateLimitStatus = info.status;
    if (!transcriptStarted) return;
    let resets = "";
    if (Number.isFinite(info.resetsAt) && info.resetsAt > 0) {
      const date = new Date(info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000);
      if (!Number.isNaN(date.getTime())) resets = ` It resets at ${date.toISOString()}.`;
    }
    const text = info.status === "rejected"
      ? `${info.errorCode === "credits_required" ? "Your Claude subscription usage is exhausted." : "Your Claude subscription usage limit was reached."}${resets}`
      : `Your Claude subscription usage is close to its limit.${resets}`;
    putBlock({
      id: liveId("limit"), kind: "custom", label: "Usage limit", title: "Claude usage limit",
      status: info.status === "rejected" ? "failed" : "complete", text,
    });
  };
  const unsupportedEvent = (type) => {
    const name = oneLine(typeof type === "string" && type ? type : "unknown", 80);
    // Nothing is added before the conversation exists: a block would make the
    // host treat an unused draft as materialized native history.
    if (unknownTypes.has(name) || !transcriptStarted) return;
    unknownTypes.add(name);
    putBlock({
      id: liveId("unknown"), kind: "unknown", label: "Claude Code event", status: "complete",
      safeSummary: `Unsupported Claude Code event: ${name}`, fallback: true,
    });
  };

  // ---------------------------------------------------------------------------
  // Native approvals (can_use_tool).
  // ---------------------------------------------------------------------------
  const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
  const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const MAX_OPTIONS = 200;
  let approvalSerial = 0;
  const approvalDescription = (toolName, input, request) => {
    const lines = [];
    if (plain(request.description)) lines.push(oneLine(request.description, 300));
    if (COMMAND_TOOLS.has(toolName) && plain(input.command)) lines.push(`Command: ${boundText(input.command, 4096).text}`);
    else if (FILE_TOOLS.has(toolName)) {
      const path = plain(input.file_path) || plain(input.notebook_path);
      if (path) lines.push(`File: ${path}`);
      if (toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
        lines.push(`Replace:\n${boundText(input.old_string, 2048).text}`, `With:\n${boundText(input.new_string, 2048).text}`);
      } else if (toolName === "Write" && typeof input.content === "string") lines.push(`Content:\n${boundText(input.content, 4096).text}`);
      else if (toolName === "MultiEdit" && Array.isArray(input.edits)) lines.push(`${input.edits.length} edits`);
    } else if (toolName === "ExitPlanMode" && plain(input.plan)) lines.push(`Plan:\n${boundText(input.plan, 8192).text}`);
    else {
      const summary = compactArgs(input);
      if (summary) lines.push(`Arguments: ${oneLine(summary, 400)}`);
    }
    if (plain(request.blocked_path)) lines.push(`Outside the workspace: ${oneLine(request.blocked_path, 300)}`);
    if (plain(request.decision_reason)) lines.push(`Reason: ${oneLine(request.decision_reason, 300)}`);
    if (plain(request.agent_id)) lines.push("Requested by a Claude Code subagent.");
    return boundText(lines.join("\n") || "Claude Code requires a decision before it can continue.").text;
  };
  const approvalTitle = (toolName, request) => {
    if (COMMAND_TOOLS.has(toolName)) return "Run command";
    if (toolName === "Write") return "Write file";
    if (toolName === "NotebookEdit") return "Edit notebook";
    if (FILE_TOOLS.has(toolName)) return "Edit file";
    if (toolName === "ExitPlanMode") return "Approve plan";
    return oneLine(`Allow ${plain(request.display_name) || toolName}`, 120);
  };
  // AskUserQuestion is answered by allowing the tool with `answers` keyed by
  // the question text (multi-select answers are comma-separated), which is the
  // documented Claude Code headless contract.
  const registerQuestion = (nativeRequestId, input) => {
    const questions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
    const question = questions[0];
    if (questions.length !== 1 || !plain(question?.question)) {
      void answerControl(nativeRequestId, { behavior: "deny", message: "PiUI can answer one question at a time. Ask the questions one by one." }).catch(() => {});
      emit({ type: "error", message: "Claude Code asked several questions at once; PiUI asked it to ask them one at a time." });
      return;
    }
    const offered = (Array.isArray(question.options) ? question.options : []).filter((option) => isRecord(option) && plain(option.label));
    const select = question.multiSelect !== true && offered.length > 0;
    const choices = select ? offered.slice(0, MAX_OPTIONS).map((option, index) => ({
      id: `option-${index + 1}`, label: oneLine(option.label, 200), value: option.label,
    })) : undefined;
    const lines = [];
    if (plain(question.header)) lines.push(`Question: ${oneLine(question.header, 120)}`);
    lines.push(boundText(question.question, 4096).text);
    for (const option of offered.slice(0, MAX_OPTIONS)) {
      lines.push(`Option: ${oneLine(option.label, 200)}${plain(option.description) ? ` — ${oneLine(option.description, 300)}` : ""}`);
    }
    if (question.multiSelect === true && offered.length) lines.push("Answer with one or more options, separated by commas.");
    const id = `claude-approval-${instance}-${++approvalSerial}`;
    const approval = {
      id, kind: "input", title: "Claude Code needs input", description: boundText(lines.join("\n")).text,
      decisions: ["approve-once", "deny", "cancel"],
      ...(choices ? { options: choices.map(({ id: optionId, label }) => ({ id: optionId, label })) } : { inputLabel: "Answer" }),
    };
    approvals.set(id, { nativeRequestId, input, question: { text: question.question, choices }, approval });
    emit({ type: "approval", approval });
  };
  const registerApproval = (nativeRequestId, request) => {
    // A redelivered request stays one pending approval.
    for (const item of approvals.values()) if (item.nativeRequestId === nativeRequestId) return;
    const toolName = safeToolName(request.tool_name);
    const input = isRecord(request.input) ? request.input : {};
    if (toolName === "AskUserQuestion") {
      registerQuestion(nativeRequestId, input);
      return;
    }
    const kind = COMMAND_TOOLS.has(toolName) ? "command" : FILE_TOOLS.has(toolName) ? "file-change" : "permission";
    const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions.filter(isRecord) : [];
    const decisions = strictPermissions
      ? ["deny", "cancel"]
      : ["approve-once", ...(suggestions.length ? ["approve-session"] : []), "deny", "cancel"];
    const id = `claude-approval-${instance}-${++approvalSerial}`;
    const approval = { id, kind, title: approvalTitle(toolName, request), description: approvalDescription(toolName, input, request), decisions };
    approvals.set(id, { nativeRequestId, input, suggestions, approval });
    emit({ type: "approval", approval });
  };
  const handleControlRequest = (message) => {
    const requestId = message.request_id;
    if (typeof requestId !== "string") return;
    if (isRecord(message.request) && message.request.subtype === "can_use_tool" && typeof message.request.tool_name === "string") {
      registerApproval(requestId, message.request);
      return;
    }
    void refuseControl(requestId, "PiUI does not support this control request.").catch(() => {});
  };
  const handleControlCancel = (message) => {
    for (const [requestId, item] of approvals) {
      if (item.nativeRequestId !== message.request_id) continue;
      approvals.delete(requestId);
      emit({ type: "approvalResolved", requestId });
    }
  };
  const handleControlResponse = (message) => {
    const response = message.response;
    if (!isRecord(response) || typeof response.request_id !== "string") return;
    const slot = pendingControl.get(response.request_id);
    // Echoes of PiUI's own replies (replay mode) and retired requests are ignored.
    if (!slot) return;
    pendingControl.delete(response.request_id);
    if (response.subtype === "success") slot.resolve(isRecord(response.response) ? response.response : {});
    else slot.reject(fail("native-command-rejected", "Claude Code rejected the request."));
  };
  const handleLifecycle = (message) => {
    if (typeof message.command_uuid !== "string") return;
    if (message.state === "started") consumeMessage(message.command_uuid);
    else if (message.state === "cancelled" || message.state === "discarded") cancelMessage(message.command_uuid);
  };
  const handleMessage = (message) => {
    // Until the handshake is verified only control replies are meaningful;
    // startup output (for example a startup-failure result) is not transcript.
    if (!ready && message.type !== "control_response") return;
    switch (message.type) {
      case "control_response": handleControlResponse(message); return;
      case "control_request": handleControlRequest(message); return;
      case "control_cancel_request": handleControlCancel(message); return;
      case "system": handleSystem(message); return;
      case "stream_event": handleStreamEvent(message); return;
      case "assistant": handleAssistant(message); return;
      case "user": handleUser(message); return;
      case "result": handleResult(message); return;
      case "command_lifecycle": handleLifecycle(message); return;
      case "rate_limit_event": handleRateLimit(message); return;
      case "keep_alive": case "tool_progress": case "tool_use_summary": case "prompt_suggestion": case "auth_status":
        return;
      default:
        unsupportedEvent(message.type);
    }
  };

  // ---------------------------------------------------------------------------
  // Native history. Claude Code does not replay history on --resume, so the
  // transcript JSONL is read best-effort. The format is internal and versioned:
  // unknown lines are skipped and the file is never written.
  // ---------------------------------------------------------------------------
  const HISTORY_FILE_LIMIT = 32 * 1024 * 1024;
  const HISTORY_BLOCK_LIMIT = 2000;
  const HISTORY_TEXT_BUDGET = 8 * 1024 * 1024;
  const readHistory = async (path) => {
    let raw;
    try {
      const info = await stat(path);
      if (!info.isFile()) return [];
      if (info.size > HISTORY_FILE_LIMIT) {
        return [{ id: opaque("claude-history", `${path}:too-large`), kind: "custom", label: "Claude Code", status: "complete", safeSummary: "This Claude Code conversation is too large to display here." }];
      }
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const value = JSON.parse(trimmed);
        if (isRecord(value)) entries.push(value);
      } catch { /* a partial or corrupted line is skipped */ }
    }
    // Follow the active branch back from the newest entry; compaction links the
    // summary to the earlier history through logicalParentUuid.
    const byUuid = new Map();
    for (const entry of entries) if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
    const conversational = entries.filter((entry) => (entry.type === "user" || entry.type === "assistant") && entry.isSidechain !== true);
    const leaf = conversational.at(-1);
    let chain = conversational;
    if (leaf && typeof leaf.uuid === "string") {
      chain = [];
      const seen = new Set();
      let cursor = leaf;
      while (cursor && !seen.has(cursor.uuid)) {
        seen.add(cursor.uuid);
        chain.push(cursor);
        const parent = typeof cursor.parentUuid === "string" ? cursor.parentUuid
          : typeof cursor.logicalParentUuid === "string" ? cursor.logicalParentUuid : undefined;
        cursor = parent ? byUuid.get(parent) : undefined;
      }
      chain.reverse();
    }
    const result = [];
    const toolIndex = new Map();
    let lineSerial = 0;
    for (const entry of chain) {
      const key = typeof entry.uuid === "string" ? entry.uuid : `line-${++lineSerial}`;
      const createdAt = typeof entry.timestamp === "string" ? { createdAt: entry.timestamp } : {};
      if (entry.type === "system") {
        if (entry.subtype === "compact_boundary") {
          result.push({ id: opaque("claude-history", `${key}:compaction`), kind: "compaction", label: "Compaction", status: "complete", safeSummary: "Context was compacted.", ...createdAt });
        }
        continue;
      }
      if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true || !isRecord(entry.message)) continue;
      const content = entry.message.content;
      if (entry.type === "user") {
        const texts = [];
        if (typeof content === "string") texts.push(content);
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (!isRecord(part)) continue;
            if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
            else if (part.type === "tool_result" && typeof part.tool_use_id === "string" && toolIndex.has(part.tool_use_id)) {
              const index = toolIndex.get(part.tool_use_id);
              const output = boundText(toolResultText(part.content));
              const failedTool = part.is_error === true;
              result[index] = { ...result[index], status: failedTool ? "failed" : "complete", text: output.text, truncated: output.truncated, safeSummary: failedTool ? "The tool failed." : "The tool completed." };
            }
          }
        }
        const text = texts.filter((value) => !INTERNAL_USER_TEXT.test(value)).join("\n");
        if (text.trim()) result.push({ id: userBlockId(key), kind: "user", label: "You", status: "complete", text, ...createdAt });
        continue;
      }
      if (entry.isApiErrorMessage === true || typeof entry.error === "string") {
        result.push({ id: opaque("claude-history", `${key}:error`), kind: "error", label: "Error", status: "failed", safeSummary: "Claude Code could not complete this turn.", ...createdAt });
        continue;
      }
      if (!Array.isArray(content)) continue;
      content.forEach((part, index) => {
        if (!isRecord(part)) return;
        if ((part.type === "text" && plain(part.text)) || (part.type === "thinking" && plain(part.thinking))) {
          const kind = part.type === "text" ? "assistant" : "thinking";
          result.push({ id: opaque("claude-history", `${key}:${index}`), kind, label: labelFor(kind), status: "complete", text: part.type === "text" ? part.text : part.thinking, ...createdAt });
        } else if (part.type === "tool_use" && typeof part.id === "string") {
          const toolName = safeToolName(part.name);
          toolIndex.set(part.id, result.length);
          // A call without a recorded result never finished.
          result.push({ id: toolBlockId(part.id), kind: "tool", label: toolName, toolName, collapsible: true, status: "interrupted", title: toolTitle(toolName, isRecord(part.input) ? part.input : {}), ...createdAt });
        }
      });
    }
    // Snapshots are single host frames: keep the newest history within budget.
    let budget = HISTORY_TEXT_BUDGET;
    let start = result.length;
    while (start > 0 && result.length - start < HISTORY_BLOCK_LIMIT) {
      const cost = (result[start - 1].text?.length ?? 0) + 256;
      if (cost > budget) break;
      budget -= cost;
      start -= 1;
    }
    const kept = result.slice(start);
    if (start > 0) kept.unshift({ id: opaque("claude-history", `${path}:omitted`), kind: "custom", label: "Claude Code", status: "complete", safeSummary: "Earlier Claude Code history is not shown." });
    return kept;
  };

  // ---------------------------------------------------------------------------
  // Session-scoped coordinator MCP endpoint (managed runs only).
  // ---------------------------------------------------------------------------
  let server;
  let scratchDirectory;
  const cleanupScratch = async () => {
    const directory = scratchDirectory;
    scratchDirectory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  };
  // Instructions and the coordinator token stay off the process command line.
  const scratchFile = async (name, contents) => {
    if (!scratchDirectory) {
      if (typeof config.sessionDir !== "string" || !isAbsolute(config.sessionDir)) {
        throw fail("invalid-configuration", "The Claude Code session directory is invalid.");
      }
      scratchDirectory = await mkdtemp(join(config.sessionDir, "claude-"));
    }
    const path = join(scratchDirectory, name);
    await writeFile(path, contents, { mode: 0o600 });
    return path;
  };
  const MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
  const WORKSPACE_TOOL = {
    name: "workspace",
    description: "Read roster before delegating. It describes when each allowed helper is useful, its required input and expected result. Use only authorized routes.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["roster", "send", "observe", "wait", "spawn", "spawnAgent"] },
        recipientMemberId: { type: "string" }, targetMemberId: { type: "string" }, body: { type: "string" },
        stepId: { type: "string" }, profileId: { type: "string" }, name: { type: "string" }, instructions: { type: "string" },
      },
      required: ["type"],
      additionalProperties: false,
    },
  };
  const mcpToken = randomUUID();
  const handleMcp = async (request, response) => {
    if (request.headers.authorization !== `Bearer ${mcpToken}`) { response.writeHead(403).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    let message;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > FRAME_LIMIT) throw new Error("frame too large");
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!isRecord(message)) { response.writeHead(400).end(); return; }
    if (message.id === undefined || message.id === null) { response.writeHead(202).end(); return; }
    const reply = (payload) => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
    };
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      reply({ result: {
        protocolVersion: MCP_PROTOCOL_VERSIONS.has(requested) ? requested : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: COORDINATOR_SERVER, version: "1" },
      } });
    } else if (message.method === "ping") reply({ result: {} });
    else if (message.method === "tools/list") reply({ result: { tools: [WORKSPACE_TOOL] } });
    else if (message.method === "tools/call" && message.params?.name === "workspace") {
      try {
        const result = await coordinatorRequest(message.params.arguments, { toolCallId: `mcp-${String(message.id)}` });
        reply({ result: { content: [{ type: "text", text: JSON.stringify({ ok: true, result: result ?? null }) }] } });
      } catch (error) {
        const code = typeof error?.bridgeCode === "string" ? error.bridgeCode : "coordinator-failed";
        const text = typeof error?.safeMessage === "string" ? error.safeMessage : "The workspace coordinator could not complete this operation.";
        reply({ result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: text } }) }] } });
      }
    } else reply({ error: { code: -32601, message: "Method not found" } });
  };

  const closeServer = () => {
    if (!server) return;
    server.close();
    server.closeAllConnections?.();
    server = undefined;
  };
  const cleanupStartup = async () => {
    disposed = true;
    await stopProcess(proc, 1000);
    closeServer();
    await cleanupScratch();
  };

  // ---------------------------------------------------------------------------
  // Catalog-only mode: read the native catalog, then stop the process.
  // ---------------------------------------------------------------------------
  if (catalogOnly) {
    try {
      verifyInitialize(await launch([]));
    } finally {
      await stopProcess(proc, 500);
    }
    return {
      async models() { return catalog.map(workspaceModel); },
      async catalogModels() { return catalog.map((entry) => ({ ...workspaceModel(entry), supportsFast: entry.supportsFast })); },
      async resources() { return resourceCatalog(); },
      async dispose() { return { disposed: true }; },
    };
  }

  try {
    if (resuming) {
      // A missing transcript is reported, never replaced by a new conversation.
      if (typeof config.nativePath === "string" && !samePath(config.nativePath, nativePath)) {
        throw fail("invalid-session", "The saved Claude Code conversation belongs to another project.");
      }
      if (!(await isFile(nativePath))) {
        throw fail("invalid-session", "The saved Claude Code conversation is no longer available in this project.");
      }
      for (const block of await readHistory(nativePath)) blocks.set(block.id, block);
    }
    if (coordination) {
      server = createServer((request, response) => {
        void handleMcp(request, response).catch(() => { try { response.writeHead(500).end(); } catch { /* closed */ } });
      });
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
    }
    const args = [];
    if (typeof config.instructions === "string" && config.instructions.trim()) {
      args.push("--append-system-prompt-file", await scratchFile("instructions.md", config.instructions));
    }
    if (server) {
      const mcpConfig = { mcpServers: { [COORDINATOR_SERVER]: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer ${mcpToken}` } } } };
      // The coordinator enforces its own ACL, so its tool runs without prompts.
      args.push("--mcp-config", await scratchFile("mcp.json", JSON.stringify(mcpConfig)), "--allowed-tools", COORDINATOR_TOOL);
    }
    if (toolAllowlist) args.push("--tools", toolAllowlist.join(","), "--strict-mcp-config");
    const denied = [...(disableSubagents ? ["Agent"] : []), ...(toolAllowlist && !coordination ? ["mcp__*"] : [])];
    if (denied.length) args.push("--disallowed-tools", denied.join(","));
    staticArgs = args;

    verifyInitialize(await launch(resuming ? ["--resume", nativeId] : ["--session-id", nativeId]));
    if (config.model?.id && !findModel(config.model.id)) {
      throw fail("model-unavailable", "The selected Claude model is unavailable for this account.");
    }
    const effective = findModel(currentModelId ?? "default") ?? catalog[0];
    if (config.thinkingLevel && !effective?.thinkingLevels.includes(config.thinkingLevel)) {
      throw fail("unsupported-settings", "The selected Claude model does not support this effort level.");
    }
    if (config.serviceTier === "fast" && !effective?.supportsFast) {
      throw fail("unsupported-settings", "The selected Claude model does not support fast mode.");
    }
    currentModelId ??= effective?.id;
  } catch (error) {
    await cleanupStartup();
    throw error;
  }
  ready = true;
  emit({ type: "binding", nativeId, nativePath });
  updateStatus();

  // Effort changes use the native runtime setting. A CLI without it is
  // restarted transparently on the same conversation with the new --effort.
  const restartWithSettings = async () => {
    restarting = true;
    try {
      await stopProcess(proc, 3000);
      const sessionArgs = (await isFile(transcriptPath(nativeId))) ? ["--resume", nativeId] : ["--session-id", nativeId];
      verifyInitialize(await launch(sessionArgs));
    } catch (error) {
      restarting = false;
      sessionFailed = true;
      setStatus("failed");
      emit({ type: "error", message: "Claude Code could not restart with the new settings." });
      throw typeof error?.bridgeCode === "string" ? error : fail("native-restart-failed", "Claude Code could not restart with the new settings.");
    }
    restarting = false;
    updateStatus();
  };

  const capabilities = {
    prompt: { supported: true, enforcement: "native" },
    resume: { supported: true, enforcement: "native" },
    models: { supported: true, enforcement: "native" },
    approvals: { supported: true, enforcement: "native" },
    instructions: { supported: true, enforcement: "native" },
    toolPolicy: toolAllowlist
      ? { supported: true, enforcement: "native" }
      : { supported: true, enforcement: "native", reason: "Claude Code uses its native configured tool policy." },
    nativeSubagents: coordination
      ? { supported: true, enforcement: "coordinator" }
      : disableSubagents
        ? { supported: true, enforcement: "native", reason: "Native Claude Code subagents are disabled for this session." }
        : { supported: true, enforcement: "native" },
  };
  const currentModel = () => {
    const entry = currentModelId ? findModel(currentModelId) : undefined;
    return entry ? workspaceModel(entry) : observedModel;
  };
  const running = () => turns.length > 0 || nativeActive;
  const interruptTurns = async () => {
    if (!running()) throw fail("no-active-turn", "Claude Code has no active turn to interrupt.");
    // A second interrupt after an acknowledged one settles turns whose
    // aborted native run never reported a result.
    if (turns.length > 0 && turns.every((turn) => turn.interruptAcknowledged)) {
      for (const turn of turns) {
        turn.pending.clear();
        turn.inRun = false;
      }
      nativeActive = false;
      runTurns.clear();
      completeReadyTurns();
      updateStatus();
      return { interrupted: true };
    }
    const marked = turns.filter((turn) => !turn.interrupted);
    for (const turn of marked) turn.interrupted = true;
    const abortingRun = nativeActive;
    for (const [requestId, item] of approvals) {
      approvals.delete(requestId);
      void answerControl(item.nativeRequestId, { behavior: "deny", message: "The user interrupted this turn.", interrupt: true }).catch(() => {});
      emit({ type: "approvalResolved", requestId });
    }
    let receipt;
    try {
      // cancel_queued drops messages still waiting in the native queue, so
      // nothing written for this turn starts after the interrupt.
      receipt = await controlRequest({ subtype: "interrupt", cancel_queued: true });
    } catch (error) {
      for (const turn of marked) turn.interrupted = false;
      throw error;
    }
    if (abortingRun && nativeActive) interruptedRunPending = true;
    for (const turn of turns) if (turn.interrupted) turn.interruptAcknowledged = true;
    for (const uuid of Array.isArray(receipt?.cancelled) ? receipt.cancelled : []) {
      if (typeof uuid === "string") cancelMessage(uuid);
    }
    completeReadyTurns();
    updateStatus();
    return { interrupted: true };
  };

  return {
    async snapshot() {
      const model = currentModel();
      return {
        nativeId,
        nativePath,
        materialized: await isFile(nativePath),
        title,
        status,
        ...(currentEffort ? { thinkingLevel: currentEffort } : {}),
        ...(currentTier ? { serviceTier: currentTier } : {}),
        ...(model ? { model } : {}),
        blocks: [...blocks.values()],
        approvals: [...approvals.values()].map((item) => item.approval),
        capabilities,
        models: catalog.map(workspaceModel),
      };
    },
    async models() { return catalog.map(workspaceModel); },
    async catalogModels() { return catalog.map((entry) => ({ ...workspaceModel(entry), supportsFast: entry.supportsFast })); },
    async resources() { return resourceCatalog(); },
    // Claude Code folds a message written during a turn into that turn at the
    // next tool boundary, which is native steering. Compaction is only a
    // `/compact` prompt in headless mode, so it is not offered.
    composerCapabilities() { return { steer: true, compact: false }; },
    async prompt({ text, mode } = {}) {
      if (typeof text !== "string" || !text.trim()) throw fail("invalid-request", "A non-empty prompt is required.");
      if (mode !== "prompt" && mode !== "steer" && mode !== "follow-up") throw fail("invalid-request", "The prompt mode is invalid.");
      if (disposed || sessionFailed || !proc || proc.ended) throw fail("not-running", "Claude Code is not running.");
      if (restarting) throw fail("turn-active", "Claude Code is applying new settings.");
      const busy = running();
      let turn;
      let priority;
      if (mode === "steer") {
        turn = turns[0];
        if (!turn || turn.interrupted) throw fail("no-active-turn", "There is no active turn to steer.");
      } else {
        if (mode === "prompt" && busy) throw fail("turn-active", "Claude Code is already running a turn.");
        turn = { uuids: [], pending: new Set(), ran: false, inRun: false, interrupted: false, failed: false };
        // A follow-up written during a turn must wait for it: the `later`
        // priority keeps Claude Code from folding it into the running turn.
        if (busy) priority = "later";
      }
      const uuid = randomUUID();
      const block = { id: userBlockId(uuid), kind: "user", label: "You", status: "complete", text };
      const immediate = !busy;
      // Admission precedes the write: native acknowledgements may arrive first.
      const admitted = !turns.includes(turn);
      if (admitted) turns.push(turn);
      turn.uuids.push(uuid);
      turn.pending.add(uuid);
      messageOwner.set(uuid, turn);
      if (immediate) putBlock(block);
      else deferredUserBlocks.set(uuid, block);
      updateStatus();
      try {
        await writeFrame({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
          session_id: nativeId,
          uuid,
          ...(priority ? { priority } : {}),
        });
      } catch (error) {
        turn.pending.delete(uuid);
        turn.uuids = turn.uuids.filter((value) => value !== uuid);
        messageOwner.delete(uuid);
        deferredUserBlocks.delete(uuid);
        if (admitted && turn.uuids.length === 0 && turns.includes(turn)) turns.splice(turns.indexOf(turn), 1);
        if (immediate) putBlock({ ...block, status: "failed", safeSummary: "Claude Code did not receive this message." });
        updateStatus();
        throw error;
      }
      return { accepted: true };
    },
    async interrupt() { return interruptTurns(); },
    async setModel({ model, thinkingLevel, serviceTier } = {}) {
      if (!isRecord(model) || typeof model.id !== "string") throw fail("invalid-request", "A Claude model id is required.");
      if (model.provider != null && model.provider !== "anthropic") throw fail("unsupported-settings", "Claude Code only runs Anthropic models.");
      if (disposed || sessionFailed || !proc || proc.ended || restarting) throw fail("not-running", "Claude Code is not running.");
      const entry = findModel(model.id);
      if (!entry) throw fail("model-unavailable", "The selected Claude model is unavailable for this account.");
      if (thinkingLevel != null && !entry.thinkingLevels.includes(thinkingLevel)) {
        throw fail("unsupported-settings", "The selected Claude model does not support this effort level.");
      }
      if (serviceTier != null && serviceTier !== "standard" && serviceTier !== "fast") throw fail("unsupported-settings", "The requested Claude Code speed is not supported.");
      if (serviceTier === "fast" && !entry.supportsFast) throw fail("unsupported-settings", "The selected Claude model does not support fast mode.");
      if (entry.id !== currentModelId) {
        await controlRequest({ subtype: "set_model", model: entry.id });
        currentModelId = entry.id;
        observedModel = undefined;
        launchSettings.model = entry.id;
      }
      const settings = {};
      if (thinkingLevel != null && thinkingLevel !== currentEffort) settings.effortLevel = thinkingLevel;
      if (serviceTier != null && serviceTier !== currentTier) settings.fastMode = serviceTier === "fast";
      if (Object.keys(settings).length > 0) {
        try {
          await controlRequest({ subtype: "apply_flag_settings", settings });
        } catch (error) {
          if (error?.bridgeCode !== "native-command-rejected") throw error;
          if (running() || approvals.size > 0) throw fail("turn-active", "Wait for the current turn before changing these settings.");
          if (settings.effortLevel) launchSettings.effort = settings.effortLevel;
          if (settings.fastMode !== undefined) launchSettings.fast = settings.fastMode;
          await restartWithSettings();
        }
        if (settings.effortLevel) { currentEffort = settings.effortLevel; launchSettings.effort = settings.effortLevel; }
        if (settings.fastMode !== undefined) { currentTier = serviceTier; launchSettings.fast = settings.fastMode; }
      }
      return { model: workspaceModel(entry), ...(currentEffort ? { thinkingLevel: currentEffort } : {}) };
    },
    async respond({ requestId, decision, text } = {}) {
      const item = approvals.get(requestId);
      if (!item || item.responding) throw fail("stale-approval", "The approval request is invalid or no longer pending.");
      if (!item.approval.decisions.includes(decision)) throw fail("invalid-request", "The selected approval decision is not available.");
      let response;
      if (decision === "deny") {
        response = { behavior: "deny", message: item.question ? "The user declined to answer." : "The user denied this action." };
      } else if (decision === "cancel") {
        response = { behavior: "deny", message: "The user cancelled this action.", interrupt: true };
      } else if (item.question) {
        // The reply is validated before the request retires, so an invalid
        // answer keeps the question pending.
        let answer;
        if (item.question.choices) {
          const choice = item.question.choices.find((option) => option.id === text)
            ?? item.question.choices.find((option) => option.label === text || option.value === text);
          if (!choice) throw fail("invalid-response", "Choose one of the offered options.");
          answer = choice.value;
        } else {
          if (typeof text !== "string" || !text.trim()) throw fail("invalid-response", "This question requires a text answer.");
          answer = text;
        }
        response = { behavior: "allow", updatedInput: { ...item.input, answers: { [item.question.text]: answer } } };
      } else if (decision === "approve-session") {
        // Session approvals stay in memory: suggestions that would persist to
        // the user's settings files are rewritten to the session destination.
        response = {
          behavior: "allow",
          updatedInput: item.input,
          updatedPermissions: item.suggestions.map((suggestion) => ({ ...suggestion, destination: "session" })),
        };
      } else {
        response = { behavior: "allow", updatedInput: item.input };
      }
      item.responding = true;
      // Cancel is deny-and-interrupt. The turn is marked before the reply is
      // written, because the aborted native result may follow immediately.
      const cancelled = decision === "cancel" ? turns.filter((turn) => !turn.interrupted) : [];
      for (const turn of cancelled) turn.interrupted = true;
      try {
        await answerControl(item.nativeRequestId, response);
      } catch (error) {
        item.responding = false;
        for (const turn of cancelled) turn.interrupted = false;
        throw error;
      }
      approvals.delete(requestId);
      emit({ type: "approvalResolved", requestId });
      // The interrupt control also drops input still queued for this turn.
      if (decision === "cancel" && running()) await interruptTurns().catch(() => undefined);
      return { resolved: true };
    },
    async rename({ title: nextTitle } = {}) {
      if (typeof nextTitle !== "string" || !nextTitle.trim()) throw fail("invalid-request", "A non-empty session title is required.");
      // PiUI metadata only; the native conversation keeps its own summary.
      title = nextTitle.trim();
      return { title };
    },
    async dispose() {
      if (disposed) return { disposed: true };
      disposed = true;
      setStatus("stopping");
      for (const [requestId, item] of approvals) {
        approvals.delete(requestId);
        void answerControl(item.nativeRequestId, { behavior: "deny", message: "The session was closed.", interrupt: true }).catch(() => {});
        emit({ type: "approvalResolved", requestId });
      }
      if (running() && proc && !proc.ended) await withTimeout(controlRequest({ subtype: "interrupt", cancel_queued: true }), 1000);
      await stopProcess(proc, 3000);
      closeServer();
      await cleanupScratch();
      setStatus("closed");
      return { disposed: true };
    },
  };
}
