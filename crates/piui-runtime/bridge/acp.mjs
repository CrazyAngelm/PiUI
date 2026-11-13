// Generic Agent Client Protocol (ACP v1) adapter. The agent owns inference,
// tools, credentials and history; this bridge only translates JSON-RPC 2.0
// over the agent's stdio (LF-framed) into the native bridge contract. The
// host resolves the agent from a descriptor, clears its environment to an
// allowlist and contains the whole process tree (Job / process group).
export async function createAcpAdapter(config, emit, coordinatorRequest, boardRequest) {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { createHash, randomUUID } = await import('node:crypto');
  const { isAbsolute, join } = await import('node:path');
  const { mkdtemp, readFile, rm, rmdir } = await import('node:fs/promises');

  const PROTOCOL_VERSION = 1;
  const FRAME_LIMIT = 32 * 1024 * 1024;
  const TEXT_LIMIT = 16 * 1024;
  const NOISE_LIMIT = 64;
  const AUTH_REQUIRED = -32000;
  const METHOD_NOT_FOUND = -32601;
  const INTERNAL_ERROR = -32603;
  // JSON-RPC errors that mean the agent did not understand a startup request.
  const REJECTED_REQUEST = [-32600, METHOD_NOT_FOUND, -32602];
  // Distinct unsupported-update notices kept per session.
  const NOTICE_LIMIT = 16;
  const acp = config.acp && typeof config.acp === 'object' ? config.acp : {};
  const name = typeof acp.displayName === 'string' && acp.displayName.trim() ? acp.displayName.trim().slice(0, 64) : 'The agent';
  const disabled = acp.disable && typeof acp.disable === 'object' ? acp.disable : {};
  const fail = (code, message = `${name} could not complete the operation.`, details) =>
    Object.assign(new Error(code), { bridgeCode: code, safeMessage: message, ...(details ? { safeDetails: details } : {}) });

  // The host sends only the provider name and entitled modes in the frame.
  const NANO_PROVIDER = 'nano';
  const GOOSE_NANO_PROVIDER = 'nano-goose-subscription';
  const gooseNano = acp.nano?.provider === GOOSE_NANO_PROVIDER;
  const nanoProvider = gooseNano ? GOOSE_NANO_PROVIDER : NANO_PROVIDER;
  let nanoModes;
  if (acp.nano !== undefined) {
    const entries = acp.nano && typeof acp.nano === 'object' && acp.nano.provider === nanoProvider && Array.isArray(acp.nano.modes) ? acp.nano.modes : undefined;
    if (acp.id !== (gooseNano ? 'goose' : 'opencode') || !entries?.length || (gooseNano && entries.length !== 1)
      || !entries.every(mode => typeof mode?.id === 'string' && /^[A-Za-z0-9._-]+$/.test(mode.id) && typeof mode.name === 'string')
      || new Set(entries.map(mode => mode.id)).size !== entries.length) {
      throw fail('invalid-configuration');
    }
    nanoModes = new Map(entries.map(mode => [mode.id, mode.name.trim() || mode.id]));
  }
  // The model source is explicit and never falls back: a Nano mode is started
  // on the Nano source and the Nano source starts with a Nano mode.
  if ((nanoModes && config.model?.provider !== nanoProvider) || (!gooseNano && config.model?.provider === GOOSE_NANO_PROVIDER)) throw fail('invalid-configuration');
  if (nanoModes && !nanoModes.has(config.model?.id)) throw fail('invalid-model', `The selected model is not offered by ${name}.`);

  if (typeof config.harness !== 'string' || !config.harness.startsWith('acp:') || config.harness.slice(4) !== acp.id
    || typeof config.cwd !== 'string' || !isAbsolute(config.cwd)
    || typeof config.runtimeProgram !== 'string' || !isAbsolute(config.runtimeProgram)
    || !Array.isArray(config.runtimeArgs) || !config.runtimeArgs.every(arg => typeof arg === 'string')) {
    throw fail('invalid-configuration');
  }
  if (config.catalogOnly) throw fail('unsupported-method', 'ACP agents list their models only inside a conversation.');
  // Only settings the protocol can enforce; everything else fails before the agent starts.
  if (config.permissionMode !== 'native' || config.baseInstructions != null || (config.serviceTier != null && config.serviceTier !== 'standard')
    || config.allowedTools != null || config.resourceRules?.length || config.nativeSubagents != null || config.networkAccess) {
    throw fail('unsupported-settings', `${name} does not support the requested per-session restriction.`);
  }

  // Plugin MCP servers (plugins v2): stdio servers the host resolved for an
  // ordinary chat. Only added to this session; the user's config is untouched.
  const pluginMcpServers = config.pluginMcpServers ?? [];
  if (!Array.isArray(pluginMcpServers) || pluginMcpServers.length > 16 || pluginMcpServers.some((server) => server === null || typeof server !== 'object'
    || typeof server.name !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(server.name) || server.name === 'piui-workspace'
    || typeof server.command !== 'string' || !isAbsolute(server.command)
    || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))
    || new Set(pluginMcpServers.map((server) => server.name)).size !== pluginMcpServers.length) {
    throw fail('unsupported-settings', 'The plugin MCP servers for this chat are invalid.');
  }
  if (pluginMcpServers.length && config.coordination) throw fail('unsupported-settings', 'Plugin MCP servers are only for ordinary chats.');
  if (nanoModes && (pluginMcpServers.length || config.coordination || config.hostTools?.length)) {
    throw fail('unsupported-settings', 'The Nano source does not allow MCP servers or host tools.');
  }

  // Windows canonical paths are verbatim (`\\?\C:\...`); agents expect the plain spelling.
  const plainPath = value => value.startsWith('\\\\?\\UNC\\') ? `\\\\${value.slice(8)}` : value.startsWith('\\\\?\\') ? value.slice(4) : value;
  const cwd = plainPath(config.cwd);
  const oneLine = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  // Bounded text: head and tail around an explicit marker, never splitting a surrogate pair.
  const bounded = (value, limit = TEXT_LIMIT) => {
    const text = typeof value === 'string' ? value : '';
    if (text.length <= limit) return { text, truncated: false };
    let head = Math.floor(limit / 2), tail = text.length - Math.floor(limit / 2);
    if (/[\ud800-\udbff]/.test(text[head - 1] ?? '')) head -= 1;
    if (/[\udc00-\udfff]/.test(text[tail] ?? '')) tail += 1;
    return { text: `${text.slice(0, head)}\n… ${tail - head} characters omitted …\n${text.slice(tail)}`, truncated: true };
  };
  const safeId = value => {
    const raw = String(value ?? '');
    return /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : createHash('sha256').update(raw).digest('hex').slice(0, 24);
  };

  // --- Process and JSON-RPC transport -------------------------------------
  let readyDirectory, readyPath, gooseStartDirectory, gooseExited;
  const cleanReadiness = async () => {
    if (gooseStartDirectory) {
      // Windows retains the cwd handle until the agent has exited.
      await gooseExited;
      await rmdir(gooseStartDirectory).catch(() => {});
    }
    if (!readyDirectory) return;
    await rm(readyPath, { force: true }).catch(() => {});
    await rmdir(readyDirectory).catch(() => {});
  };
  if (gooseNano) {
    const root = process.env.GOOSE_PATH_ROOT;
    if (process.platform !== 'win32' || !root || !isAbsolute(root)
      || !process.env.GOOSE_SHELL || !isAbsolute(process.env.GOOSE_SHELL)
      || process.env.PIUI_GOOSE_NANO_SHELL !== '1' || !process.env.OPENAI_API_KEY
      || process.env.GOOSE_MODEL !== config.model.id
      || !/^http:\/\/127\.0\.0\.1:\d+\/c\/\d+\/v1$/.test(process.env.OPENAI_BASE_URL ?? '')) {
      throw fail('invalid-configuration');
    }
    try {
      // Goose resolves project hooks from its process cwd, independently of
      // the cwd it uses for ACP tools and history.
      gooseStartDirectory = await mkdtemp(join(plainPath(root), '.goose-nano-'));
    } catch { throw fail('native-start-failed'); }
  } else if (nanoModes) {
    if (typeof config.sessionDir !== 'string' || !isAbsolute(config.sessionDir)) throw fail('invalid-configuration');
    try {
      readyDirectory = await mkdtemp(join(plainPath(config.sessionDir), '.opencode-guard-'));
      readyPath = join(readyDirectory, 'ready');
    } catch { throw fail('native-start-failed'); }
  }
  const childEnvironment = { ...process.env, ...(readyPath ? { PIUI_NANO_OPENCODE_READY: readyPath } : {}) };
  const child = spawn(config.runtimeProgram, config.runtimeArgs, { cwd: gooseStartDirectory ?? cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment });
  if (gooseStartDirectory) gooseExited = new Promise(resolve => child.once('close', resolve));
  // The Nano source's provider configuration (it embeds the lease key) reached
  // this process by environment; once the agent has its copy, only the agent
  // keeps it (read once and removed, as the Nano Pi bridge does).
  if (nanoModes) {
    const leaseEnv = gooseNano ? 'OPENAI_API_KEY' : 'OPENCODE_CONFIG_CONTENT';
    delete process.env[leaseEnv];
    delete childEnvironment[leaseEnv];
  }
  const verifyNanoGuard = async () => {
    if (!readyPath) return;
    const ready = await readFile(readyPath, 'utf8').catch(() => undefined);
    if (ready !== String(child.pid)) throw fail('native-start-failed', 'The Nano shell environment guard did not load.');
  };
  child.stderr.on('data', () => {}); // Native diagnostics can contain prompts or credentials.
  child.stdin.on('error', () => {});
  const pending = new Map();
  let requestSequence = 0, noise = 0, transportFailed = false, exited = false;
  let partial = [], partialSize = 0;
  const write = value => { if (!exited && !transportFailed) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited || transportFailed) { reject(fail('native-exited', `${name} is not running.`)); return; }
    const id = ++requestSequence;
    pending.set(id, { resolve, reject, method });
    write({ id, method, params });
  });
  const notify = (method, params) => write({ method, params });
  const rejectPending = error => { for (const slot of pending.values()) slot.reject(error); pending.clear(); };

  // --- Session state --------------------------------------------------------
  const blocks = new Map();
  const messageKeys = new Map();
  const tools = new Map();
  const approvals = new Map();
  const followUps = [];
  let sessionId, status = 'starting', title = typeof config.title === 'string' && config.title.trim() ? config.title : `${name} conversation`;
  let turn = 0, sequence = 0, streaming, loading = false, disposed = false, bound = Boolean(config.nativeId), instructionsSent = Boolean(config.nativeId);
  let agentCapabilities = {}, authMethods = [], commands = [];
  let modelControl, models = [], currentModelId, thought, currentThought, modeControl, modes = [], currentModeId;
  // Public model id -> the id the agent knows. They differ only on the Nano
  // source, where the public id is the mode (`auto`) and the agent's is `nano/auto`.
  let nativeModelIds = new Map();
  const nativeModel = id => nativeModelIds.get(id) ?? id;

  const setStatus = value => { status = value; emit({ type: 'status', status }); };
  const put = block => { const value = { status: 'complete', ...block }; blocks.set(value.id, value); emit({ type: 'block', block: value }); return value; };
  const showError = message => {
    put({ id: `acp-error-${++sequence}`, kind: 'error', label: 'Error', status: 'failed', safeSummary: message });
    emit({ type: 'error', message });
  };
  const rejectFollowUps = () => {
    if (followUps.splice(0).length) emit({ type: 'error', message: `Queued messages for ${name} were not delivered because the session stopped.` });
  };
  const settleApprovals = () => {
    for (const [id, item] of approvals) {
      write({ id: item.nativeId, result: { outcome: { outcome: 'cancelled' } } });
      approvals.delete(id);
      emit({ type: 'approvalResolved', requestId: id });
    }
  };
  const finishStreaming = (state = 'complete') => {
    for (const block of blocks.values()) if (block.status === 'streaming' && block.kind !== 'tool') put({ ...block, status: state });
    streaming = undefined;
  };

  // --- Catalog: session config options first, legacy models/modes second ---
  const selectValues = options => {
    const values = [];
    for (const option of Array.isArray(options) ? options : []) {
      if (Array.isArray(option?.options)) {
        for (const nested of option.options) if (typeof nested?.value === 'string') values.push({ value: nested.value, name: oneLine(nested.name, 80) || nested.value, group: oneLine(option.name ?? option.group, 80) || undefined, description: oneLine(nested.description, 200) || undefined });
      } else if (typeof option?.value === 'string') {
        values.push({ value: option.value, name: oneLine(option.name, 80) || option.value, description: oneLine(option.description, 200) || undefined });
      }
      if (values.length >= 500) break;
    }
    return values;
  };
  // `entries` are the agent's own rows (`value` is its model id). The Nano source
  // keeps exactly the entitled modes of the `nano` provider, named by the host,
  // and drops everything else the agent lists. Without explicit acp.nano
  // metadata every provider group belongs to the native agent, even `nano`.
  const adoptModels = (entries, currentNative) => {
    const next = [];
    const known = new Map();
    for (const item of entries) {
      if (nanoModes) {
        const mode = gooseNano ? item.value : item.value.startsWith(`${NANO_PROVIDER}/`) ? item.value.slice(NANO_PROVIDER.length + 1) : undefined;
        if (mode === undefined || !nanoModes.has(mode)) continue;
        next.push({ id: mode, name: nanoModes.get(mode), provider: nanoProvider });
        known.set(mode, item.value);
      } else {
        const provider = item.group;
        next.push({ id: item.value, name: item.name, ...(provider ? { provider } : {}) });
      }
    }
    models = next;
    nativeModelIds = known;
    currentModelId = nanoModes
      ? [...known].find(([, native]) => native === currentNative)?.[0]
      : currentNative;
  };
  const applyConfigOptions = list => {
    if (!Array.isArray(list)) return;
    for (const option of list) {
      if (option?.type !== 'select' || typeof option.id !== 'string' || typeof option.currentValue !== 'string') continue;
      const values = selectValues(option.options);
      if (option.category === 'model' && !disabled.models) {
        modelControl = { kind: 'config', configId: option.id };
        adoptModels(values, option.currentValue);
      } else if (option.category === 'mode' && !disabled.modes) {
        modeControl = { kind: 'config', configId: option.id };
        modes = values.filter(item => !gooseNano || item.value === 'approve').map(item => ({ id: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) }));
        currentModeId = option.currentValue;
      } else if (option.category === 'thought_level' && !nanoModes) {
        // Nano modes have no reasoning levels (the server owns the mode's model).
        thought = { configId: option.id, values: values.map(item => item.value) };
        currentThought = option.currentValue;
      }
    }
  };
  const applySessionState = state => {
    if (!state || typeof state !== 'object') return;
    applyConfigOptions(state.configOptions);
    if (!modelControl && !disabled.models && Array.isArray(state.models?.availableModels)) {
      modelControl = { kind: 'legacy' };
      adoptModels(
        state.models.availableModels.filter(item => typeof item?.modelId === 'string').slice(0, 500).map(item => ({ value: item.modelId, name: oneLine(item.name, 80) || item.modelId })),
        typeof state.models.currentModelId === 'string' ? state.models.currentModelId : undefined,
      );
    }
    if (!modeControl && !disabled.modes && Array.isArray(state.modes?.availableModes)) {
      modeControl = { kind: 'legacy' };
      modes = state.modes.availableModes.filter(item => typeof item?.id === 'string' && (!gooseNano || item.id === 'approve')).slice(0, 50).map(item => ({ id: item.id, name: oneLine(item.name, 80) || item.id, ...(oneLine(item.description) ? { description: oneLine(item.description) } : {}) }));
      currentModeId = typeof state.modes.currentModeId === 'string' ? state.modes.currentModeId : undefined;
    }
  };
  const workspaceModel = entry => ({ ...entry, ...(thought ? { thinkingLevels: [...thought.values] } : {}) });
  const currentModel = () => models.find(item => item.id === currentModelId);
  const setConfig = async (configId, value) => {
    const result = await request('session/set_config_option', { sessionId, configId, value });
    applyConfigOptions(result?.configOptions);
  };
  // The model source is part of a model's identity: a model of the other
  // source is refused, never matched by its id alone.
  const selectModel = async (id, provider) => {
    if (nanoModes && provider !== nanoProvider) throw fail('invalid-model', `The selected model is not offered by ${name}.`);
    if (!modelControl || !models.some(item => item.id === id)) throw fail('invalid-model', `The selected model is not offered by ${name}.`);
    if (id === currentModelId) return;
    const target = nativeModel(id);
    if (modelControl.kind === 'config') {
      await setConfig(modelControl.configId, target);
      if (nanoModes && currentModelId !== id) throw fail('invalid-model', `${name} did not select the requested Nano mode.`);
      if (!nanoModes) currentModelId = id;
    } else {
      await request('session/set_model', { sessionId, modelId: target });
      currentModelId = id;
    }
  };
  const selectThought = async level => {
    if (!thought || !thought.values.includes(level)) throw fail('unsupported-settings', `${name} does not offer the selected reasoning level.`);
    if (level === currentThought) return;
    await setConfig(thought.configId, level);
    currentThought = level;
  };
  const selectMode = async id => {
    if (!modeControl || !modes.some(item => item.id === id)) throw fail('invalid-request', `${name} does not offer the selected mode.`);
    if (id === currentModeId) return;
    if (modeControl.kind === 'config') await setConfig(modeControl.configId, id);
    else await request('session/set_mode', { sessionId, modeId: id });
    currentModeId = id;
  };

  // --- Session updates -> native blocks --------------------------------------
  const TOOL_NAMES = { execute: 'command', edit: 'edit', delete: 'edit', move: 'edit', read: 'read', search: 'search', fetch: 'fetch', think: 'think' };
  // Agent-controlled keys never reach inherited properties (`__proto__`, `constructor`).
  const own = (table, key) => typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
  const scalarSummary = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const parts = [];
    for (const [key, item] of Object.entries(value)) {
      if (['string', 'number', 'boolean'].includes(typeof item)) parts.push(`${oneLine(key, 40)}: ${oneLine(String(item), 160)}`);
      if (parts.length >= 6) break;
    }
    return parts.join('\n');
  };
  const unifiedDiff = (path, oldText, newText) => {
    const label = oneLine(path, 300) || 'file';
    const before = typeof oldText === 'string' ? oldText.split('\n') : [];
    const after = typeof newText === 'string' ? newText.split('\n') : [];
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let endBefore = before.length, endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
    const from = Math.max(0, start - 3), toBefore = Math.min(before.length, endBefore + 3), toAfter = Math.min(after.length, endAfter + 3);
    const lines = [`--- ${typeof oldText === 'string' ? `a/${label}` : '/dev/null'}`, `+++ b/${label}`, `@@ -${from + 1},${toBefore - from} +${from + 1},${toAfter - from} @@`];
    for (let index = from; index < start; index += 1) lines.push(` ${before[index]}`);
    for (let index = start; index < endBefore; index += 1) lines.push(`-${before[index]}`);
    for (let index = start; index < endAfter; index += 1) lines.push(`+${after[index]}`);
    for (let index = endBefore; index < toBefore; index += 1) lines.push(` ${before[index]}`);
    return lines.join('\n');
  };
  const toolText = state => {
    const parts = [];
    for (const item of state.content) {
      if (item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') parts.push(item.content.text);
      else if (item?.type === 'diff' && typeof item.newText === 'string') parts.push(unifiedDiff(item.path, item.oldText, item.newText));
      else if (item?.type === 'terminal') parts.push('The agent streamed terminal output that PiUI does not host.');
      else if (item?.type === 'content') parts.push('This tool returned content that the current renderer does not show.');
    }
    if (!parts.length) {
      const summary = scalarSummary(state.rawInput);
      if (summary) parts.push(summary);
      const paths = state.locations.map(location => oneLine(location?.path, 300)).filter(Boolean);
      if (paths.length) parts.push(paths.slice(0, 20).join('\n'));
    }
    return bounded(parts.join('\n\n'));
  };
  const renderTool = state => {
    const { text, truncated } = toolText(state);
    const statusValue = state.status === 'completed' ? 'complete' : state.status === 'failed' ? 'failed' : state.status === 'cancelled' ? 'interrupted' : loading ? 'complete' : 'streaming';
    put({ id: state.blockId, kind: 'tool', label: 'Tool', title: oneLine(state.title) || `${name} tool`, ...(own(TOOL_NAMES, state.kind) ? { toolName: own(TOOL_NAMES, state.kind) } : {}), text, ...(truncated ? { truncated: true } : {}), status: statusValue, collapsible: true });
  };
  const updateTool = (update, created) => {
    const key = String(update.toolCallId ?? '');
    if (!key) return;
    const state = tools.get(key) ?? { blockId: `acp-tool-${safeId(key)}`, title: '', kind: 'other', status: 'pending', content: [], locations: [], rawInput: undefined };
    if (typeof update.title === 'string') state.title = update.title;
    if (typeof update.kind === 'string') state.kind = update.kind;
    if (typeof update.status === 'string') state.status = update.status;
    if (Array.isArray(update.content)) state.content = update.content.slice(0, 50);
    if (Array.isArray(update.locations)) state.locations = update.locations.slice(0, 50);
    if (update.rawInput !== undefined) state.rawInput = update.rawInput;
    if (!created && !tools.has(key) && !update.title) state.title = `${name} tool`;
    tools.set(key, state);
    streaming = undefined;
    renderTool(state);
  };
  const appendText = (role, update) => {
    const content = update.content;
    if (content?.type !== 'text' || typeof content.text !== 'string') {
      streaming = undefined;
      put({ id: `acp-media-${++sequence}`, kind: 'custom', label: name, title: `${name} content`, text: 'This content type is not supported by the current renderer.', fallback: true });
      return;
    }
    const kind = role === 'assistant' ? 'assistant' : role === 'thinking' ? 'thinking' : 'user';
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
    const current = streaming && blocks.get(streaming);
    if (current && current.kind === kind && (messageId === undefined || messageKeys.get(current.id) === messageId)) {
      const block = { ...current, text: `${current.text ?? ''}${content.text}` };
      blocks.set(block.id, block);
      // A replay sends whole blocks: its events may reach the host after the snapshot.
      if (loading) emit({ type: 'block', block });
      else emit({ type: 'textDelta', blockId: block.id, text: content.text });
      return;
    }
    const block = put({ id: `acp-${kind}-${++sequence}`, kind, label: kind === 'assistant' ? name : kind === 'thinking' ? 'Thinking' : 'You', text: content.text, status: loading ? 'complete' : 'streaming' });
    streaming = block.id;
    if (messageId !== undefined) messageKeys.set(block.id, messageId);
  };
  const planBlock = entries => {
    const marks = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
    const lines = (Array.isArray(entries) ? entries : []).slice(0, 100).map(entry => `${own(marks, entry?.status) ?? '[ ]'} ${oneLine(entry?.content, 300)}`);
    const { text, truncated } = bounded(lines.join('\n'));
    streaming = undefined;
    put({ id: `acp-plan-${turn}`, kind: 'custom', label: 'Plan', title: 'Plan', text, ...(truncated ? { truncated: true } : {}), collapsible: true });
  };
  // One generic notice per update kind: an agent that repeats an unknown update
  // must not fill the transcript with copies of the same block.
  const noticed = new Set();
  const unsupportedUpdate = kind => {
    const label = oneLine(String(kind ?? 'unknown'), 80) || 'unknown';
    if (noticed.has(label) || noticed.size >= NOTICE_LIMIT) return;
    noticed.add(label);
    streaming = undefined;
    put({ id: `acp-event-${++sequence}`, kind: 'custom', label: name, title: `${name} event`, text: `Unsupported agent update: ${label}`, fallback: true, collapsible: true });
  };
  const onUpdate = params => {
    if (params?.sessionId !== sessionId && sessionId !== undefined) return;
    const update = params?.update;
    const kind = update?.sessionUpdate;
    switch (kind) {
      case 'agent_message_chunk': appendText('assistant', update); break;
      case 'agent_thought_chunk': appendText('thinking', update); break;
      // Live user text is emitted by PiUI itself; only a replay carries it.
      case 'user_message_chunk': if (loading) appendText('user', update); break;
      case 'tool_call': updateTool(update, true); break;
      case 'tool_call_update': updateTool(update, false); break;
      case 'plan': planBlock(update.entries); break;
      case 'available_commands_update':
        if (!gooseNano) commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).filter(item => typeof item?.name === 'string').slice(0, 200).map(item => oneLine(item.name, 80)).filter(Boolean);
        break;
      case 'current_mode_update': if (typeof update.currentModeId === 'string' && (gooseNano || modes.some(item => item.id === update.currentModeId))) currentModeId = update.currentModeId; break;
      case 'config_option_update': applyConfigOptions(update.configOptions); break;
      // Context size and agent-side titles are not PiUI turn data.
      case 'usage_update': case 'session_info_update': break;
      default: unsupportedUpdate(kind);
    }
  };

  // --- Permission requests -> approvals -------------------------------------
  const APPROVAL_KINDS = { execute: 'command', edit: 'file-change', delete: 'file-change', move: 'file-change' };
  const onPermission = message => {
    if (disposed || status !== 'running') { write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    const params = message.params ?? {};
    const toolCall = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
    const known = tools.get(String(toolCall.toolCallId ?? ''));
    const choices = (Array.isArray(params.options) ? params.options : []).filter(option => typeof option?.optionId === 'string').slice(0, 8);
    if (!choices.length) { write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    const id = `acp-permission-${++sequence}`;
    const options = choices.map((option, index) => ({ id: `option-${index + 1}`, label: oneLine(option.name, 80) || oneLine(option.kind, 40) || `Option ${index + 1}`, native: option.optionId }));
    const detail = known ? toolText(known).text : bounded(scalarSummary(toolCall.rawInput)).text;
    const approval = {
      id,
      kind: own(APPROVAL_KINDS, toolCall.kind ?? known?.kind) ?? 'permission',
      title: oneLine(toolCall.title ?? known?.title) || `${name} asks for permission`,
      description: [`${name} asks before running this tool.`, bounded(detail, 1200).text].filter(Boolean).join('\n\n'),
      decisions: ['approve-once', 'cancel'],
      options: options.map(({ id: optionId, label }) => ({ id: optionId, label })),
    };
    approvals.set(id, { nativeId: message.id, options, approval });
    try { emit({ type: 'approval', approval }); }
    catch (error) { approvals.delete(id); throw error; }
  };

  // --- Turns -------------------------------------------------------------------
  const finishTurn = () => {
    if (disposed || status !== 'running') return;
    if (gooseNano && (currentModeId !== 'approve' || currentModelId !== config.model.id)) {
      rejectFollowUps();
      setStatus('failed');
      showError('Goose changed the Nano session model or approval mode.');
      return;
    }
    const next = followUps.shift();
    if (next === undefined) setStatus('idle');
    else startTurn(next);
  };
  const STOP_FAILURES = {
    max_tokens: `${name} stopped: it reached its output limit.`,
    max_turn_requests: `${name} stopped: it reached its limit of model requests for this turn.`,
    refusal: `${name} refused to continue this turn.`,
  };
  const startTurn = text => {
    turn += 1;
    streaming = undefined;
    put({ id: `acp-user-${turn}`, kind: 'user', label: 'You', text, status: 'complete' });
    setStatus('running');
    if (!bound) { bound = true; emit({ type: 'binding', nativeId: sessionId }); }
    const instructions = typeof config.instructions === 'string' && config.instructions.trim() && !instructionsSent ? config.instructions : undefined;
    instructionsSent = true;
    const input = instructions ? `Agent instructions:\n${instructions}\n\nTask:\n${text}` : text;
    void request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input }] }).then(result => {
      finishStreaming();
      settleApprovals();
      const usage = result?.usage;
      if (usage && typeof usage === 'object') {
        const receipt = { id: randomUUID() };
        for (const [source, target] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cachedReadTokens', 'cacheReadTokens'], ['cachedWriteTokens', 'cacheWriteTokens'], ['totalTokens', 'totalTokens']]) {
          if (Number.isSafeInteger(usage[source]) && usage[source] >= 0) receipt[target] = usage[source];
        }
        emit({ type: 'usage', usage: receipt });
      }
      const reason = result?.stopReason;
      const outcome = reason === 'end_turn' ? 'succeeded' : reason === 'cancelled' ? 'interrupted' : 'failed';
      if (outcome === 'failed') showError(STOP_FAILURES[reason] ?? `${name} ended the turn without a recognised outcome.`);
      emit({ type: 'turnCompleted', outcome });
      finishTurn();
    }, error => {
      // A lost transport proves no terminal outcome: the turn stays uncertain.
      if (error?.bridgeCode === 'native-exited' || error?.bridgeCode === 'invalid-native-protocol') return;
      finishStreaming('failed');
      settleApprovals();
      if (!disposed) showError(error?.nativeCode === AUTH_REQUIRED ? `Sign in to ${name} again, then retry this message.` : `${name} could not complete this turn (${Number.isSafeInteger(error?.nativeCode) ? error.nativeCode : 'error'}).`);
      emit({ type: 'turnCompleted', outcome: 'failed' });
      finishTurn();
    });
  };

  // --- Incoming frames -----------------------------------------------------------
  const failTransport = () => {
    if (transportFailed) return;
    transportFailed = true;
    rejectPending(fail('invalid-native-protocol', `${name} sent an invalid protocol message.`));
    rejectFollowUps();
    if (!disposed) { setStatus('failed'); emit({ type: 'error', message: `${name} sent an invalid protocol message and was stopped.` }); }
    child.kill();
  };
  const interpretationFailed = message => {
    try {
      const method = typeof message?.method === 'string' ? message.method : undefined;
      // A request is answered, never left pending; a permission request is
      // cancelled, never approved.
      if (method !== undefined && message.id !== undefined) {
        if (method === 'session/request_permission') write({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        else write({ id: message.id, error: { code: INTERNAL_ERROR, message: 'Internal error' } });
      }
      unsupportedUpdate(method === 'session/update' ? message.params?.update?.sessionUpdate : method ?? 'response');
    } catch { /* Nothing more can be shown; the session carries on. */ }
  };
  const onMessage = message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { failTransport(); return; }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (message.method === 'session/request_permission') onPermission(message);
        // fs/* and terminal/* were never advertised; nothing else is a client
        // method. Any other request, a lookalike of a permission request
        // included, is answered with method-not-found and never reaches the user as an approval.
        else write({ id: message.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } });
      } else if (message.method === 'session/update') onUpdate(message.params);
      return;
    }
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error && typeof message.error === 'object') {
      const code = Number.isSafeInteger(message.error.code) ? message.error.code : undefined;
      slot.reject(Object.assign(fail('native-request-failed', `${name} could not complete ${slot.method}.`), { nativeCode: code }));
    } else slot.resolve(message.result);
  };
  const onLine = line => {
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    const text = line.toString('utf8');
    if (!text.trim()) return;
    // ACP reserves stdout for protocol frames. A few stray log lines are
    // tolerated; a broken frame is not.
    if (!text.trimStart().startsWith('{')) { if (++noise > NOISE_LIMIT) failTransport(); return; }
    let message;
    try { message = JSON.parse(text); } catch { failTransport(); return; }
    // A well-formed frame that the adapter cannot interpret must not take the
    // bridge down: it is answered and shown once as an unsupported update. A
    // malformed frame never gets here; it stops the agent above.
    try { onMessage(message); } catch { interpretationFailed(message); }
  };
  // Split only on LF bytes (never on Unicode line separators); partial
  // frames are kept as chunks, so a long frame is copied once.
  child.stdout.on('data', chunk => {
    let start = 0, at;
    while (!transportFailed && (at = chunk.indexOf(0x0a, start)) >= 0) {
      const piece = chunk.subarray(start, at);
      const line = partial.length ? Buffer.concat([...partial, piece]) : piece;
      partial = []; partialSize = 0; start = at + 1;
      if (line.length > FRAME_LIMIT) { failTransport(); return; }
      onLine(line);
    }
    if (transportFailed || start >= chunk.length) return;
    const rest = chunk.subarray(start);
    partial.push(rest); partialSize += rest.length;
    if (partialSize > FRAME_LIMIT) failTransport();
  });
  const onExit = () => {
    if (exited) return;
    exited = true;
    rejectPending(fail('native-exited', `${name} stopped.`));
    rejectFollowUps();
    for (const id of approvals.keys()) emit({ type: 'approvalResolved', requestId: id });
    approvals.clear();
    if (!disposed && !transportFailed) { setStatus('failed'); emit({ type: 'error', message: `${name} stopped unexpectedly.` }); }
    server?.close();
  };
  child.once('error', onExit);
  child.once('exit', onExit);

  // --- Workspace tool for managed runs (HTTP MCP) ------------------------------------
  let server;
  // Every ACP agent takes stdio MCP servers; plugin servers join this session only.
  const mcpServers = pluginMcpServers.map(plugin => ({ name: plugin.name, command: plugin.command, args: [...plugin.args], env: [] }));
  // Board host tool: optional and independent of coordination. An agent without
  // HTTP MCP support still starts; the host is told with a notice.
  const boardRequested = Array.isArray(config.hostTools) && config.hostTools.includes('board');
  let boardEnabled = boardRequested && typeof boardRequest === 'function';
  const boardStatuses = ['backlog', 'todo', 'inProgress', 'inReview', 'blocked', 'done', 'cancelled'];
  const boardTool = {
    name: 'board',
    description: "Manage this project's PiUI board: the cards the person tracks. Call op context before create and prefer updating, commenting on or moving the active or a similar card. Moving to done or cancelled only proposes it to the person. Do not retry ALREADY_CLAIMED or FORBIDDEN. The result is JSON.",
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['context', 'search', 'list', 'get', 'create', 'update', 'move', 'comment', 'claim', 'release', 'link', 'roster', 'assign', 'handoff'] },
        card: { type: 'integer', minimum: 1 }, query: { type: 'string', maxLength: 500 }, includeClosed: { type: 'boolean' },
        status: { type: 'string', enum: boardStatuses }, title: { type: 'string', maxLength: 200 }, description: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] }, labels: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        confirmNew: { type: 'boolean' }, to: { type: 'string', enum: boardStatuses }, reason: { type: 'string' }, body: { type: 'string' }, handle: { type: 'string' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  };
  const startCoordinator = async () => {
    const token = randomUUID();
    const tool = { name: 'workspace', description: 'Read roster before delegating. It describes when each allowed helper is useful, its required input and expected result. Use only authorized routes.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['roster', 'send', 'observe', 'wait', 'spawn', 'spawnAgent'] }, recipientMemberId: { type: 'string' }, targetMemberId: { type: 'string' }, body: { type: 'string' }, stepId: { type: 'string' }, profileId: { type: 'string' }, name: { type: 'string' }, instructions: { type: 'string' } }, required: ['type'], additionalProperties: false } };
    server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      try {
        let raw = '';
        for await (const part of req) { raw += part; if (raw.length > FRAME_LIMIT) throw fail('frame-too-large'); }
        const message = JSON.parse(raw);
        if (message?.id === undefined) { res.writeHead(202).end(); return; }
        let result;
        if (message.method === 'initialize') {
          const requested = message.params?.protocolVersion;
          result = { protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'piui-workspace', version: '1' } };
        } else if (message.method === 'tools/list') result = { tools: [...(config.coordination ? [tool] : []), ...(boardEnabled ? [boardTool] : [])] };
        else if (message.method === 'tools/call' && message.params?.name === 'board' && boardEnabled) {
          try {
            const value = await boardRequest(message.params.arguments, {});
            result = { ...(value?.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] };
          } catch (error) {
            const code = typeof error?.bridgeCode === 'string' ? error.bridgeCode : 'board-failed';
            const text = typeof error?.safeMessage === 'string' ? error.safeMessage : 'The board could not complete this operation.';
            result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message: text }) }] };
          }
        } else if (message.method === 'tools/call' && message.params?.name === 'workspace' && config.coordination) {
          try { result = { content: [{ type: 'text', text: JSON.stringify(await coordinatorRequest(message.params.arguments, {})) }] }; }
          catch { result = { isError: true, content: [{ type: 'text', text: 'The workspace coordinator denied or could not complete this operation.' }] }; }
        } else if (message.method === 'ping') result = {};
        else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      } catch { res.writeHead(400).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    mcpServers.push({ type: 'http', name: 'piui-workspace', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
  };

  // --- Start: initialize, then a new or loaded session ------------------------------------
  try {
    // The handshake is the compatibility gate, not the agent's release number.
    // A rejected or malformed handshake is a protocol mismatch, and so is any
    // protocol version other than 1 (version 2 is rejected until implemented).
    const initialized = await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'piui', title: 'PiUI', version: '0.3.1' } }).catch(error => {
      if (error?.bridgeCode !== 'native-request-failed') throw error;
      throw error.nativeCode === AUTH_REQUIRED ? fail('acp-sign-in-required', `Sign in to ${name} first.`, { authMethods: [] }) : fail('native-protocol-mismatch', `${name} rejected the ACP handshake.`);
    });
    if (initialized === null || typeof initialized !== 'object' || Array.isArray(initialized) || !Number.isSafeInteger(initialized.protocolVersion)) {
      throw fail('native-protocol-mismatch', `${name} answered the ACP handshake without a protocol version.`);
    }
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw fail('unsupported-protocol', `${name} speaks an unsupported ACP protocol version.`);
    if (gooseNano && (initialized.agentInfo?.name !== 'goose' || initialized.agentInfo?.version !== '1.59.0')) {
      throw fail('native-protocol-mismatch', 'This Goose release has no verified Nano source.');
    }
    await verifyNanoGuard();
    agentCapabilities = initialized.agentCapabilities && typeof initialized.agentCapabilities === 'object' ? initialized.agentCapabilities : {};
    authMethods = (Array.isArray(initialized.authMethods) ? initialized.authMethods : []).map(method => oneLine(method?.name ?? method?.id, 80)).filter(Boolean).slice(0, 6);
    if (config.coordination) {
      if (agentCapabilities.mcpCapabilities?.http !== true || disabled.mcpHttp || typeof coordinatorRequest !== 'function') {
        throw fail('unsupported-coordinator', `${name} cannot receive the PiUI workspace tool because it does not accept HTTP MCP servers.`);
      }
    }
    if (boardRequested && (!boardEnabled || agentCapabilities.mcpCapabilities?.http !== true || disabled.mcpHttp)) {
      boardEnabled = false;
      emit({ type: 'notice', code: 'unsupported-board-tool' });
    }
    if (config.coordination || boardEnabled) await startCoordinator();
    const signIn = error => error?.nativeCode === AUTH_REQUIRED ? fail('acp-sign-in-required', `Sign in to ${name} first.`, { authMethods }) : undefined;
    // A startup request the agent does not understand (invalid request, unknown method, invalid params).
    const mismatch = (error, what) => error?.bridgeCode === 'native-request-failed' && REJECTED_REQUEST.includes(error.nativeCode) ? fail('native-protocol-mismatch', `${name} rejected the ACP ${what} request.`) : undefined;
    if (config.nativeId) {
      if (agentCapabilities.loadSession !== true || disabled.loadSession) throw fail('resume-unsupported', `${name} cannot reopen saved conversations.`);
      loading = true;
      let loaded;
      try { loaded = await request('session/load', { sessionId: config.nativeId, cwd, mcpServers }); }
      catch (error) { throw signIn(error) ?? (error?.bridgeCode === 'native-request-failed' ? fail('invalid-session', `The saved conversation is no longer available in ${name}.`) : error); }
      loading = false;
      finishStreaming();
      sessionId = config.nativeId;
      applySessionState(loaded);
    } else {
      let created;
      const params = { cwd, mcpServers };
      if (gooseNano) params._meta = { enabledExtensions: [{ type: 'platform', name: 'developer', bundled: true }] };
      try { created = await request('session/new', params); }
      catch (error) { throw signIn(error) ?? mismatch(error, 'session') ?? error; }
      if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 256) throw fail('native-protocol-mismatch', `${name} did not create a conversation.`);
      sessionId = created.sessionId;
      applySessionState(created);
    }
    if (nanoModes) {
      await verifyNanoGuard();
      // Fail closed: the session runs on exactly the Nano mode it was started
      // or recorded with, never the agent's default and never another source.
      await selectModel(config.model.id, config.model.provider);
      if (currentModelId !== config.model.id) throw fail('invalid-model', `The selected model is not offered by ${name}.`);
      if (gooseNano && currentModeId !== 'approve') throw fail('unsupported-settings', 'Goose did not enable approval for the Nano source.');
    } else if (config.model?.id && config.model.id !== 'default') await selectModel(config.model.id, config.model.provider);
    if (config.thinkingLevel) await selectThought(config.thinkingLevel);
    setStatus('idle');
  } catch (error) {
    disposed = true;
    child.kill();
    server?.close();
    await cleanReadiness();
    throw typeof error?.bridgeCode === 'string' ? error : fail('native-start-failed', `${name} could not start.`);
  }

  const capabilities = () => ({
    prompt: { supported: true, enforcement: 'native' },
    resume: agentCapabilities.loadSession === true && !disabled.loadSession ? { supported: true, enforcement: 'native' } : { supported: false, enforcement: 'unsupported', reason: `${name} cannot reopen saved conversations.` },
    models: modelControl ? { supported: true, enforcement: 'native' } : { supported: false, enforcement: 'unsupported', reason: `${name} does not offer model choices.` },
    approvals: { supported: true, enforcement: 'native' },
    instructions: { supported: true, enforcement: 'coordinator', reason: 'Sent with the first prompt; the agent keeps its own system prompt.' },
    toolPolicy: { supported: false, enforcement: 'unsupported', reason: 'ACP does not expose per-session tool restrictions.' },
    nativeSubagents: { supported: false, enforcement: 'unsupported', reason: 'ACP does not expose native delegation restrictions.' },
  });

  return {
    snapshot() {
      const model = currentModel();
      return {
        nativeId: sessionId,
        materialized: Boolean(config.nativeId) || turn > 0,
        title,
        status,
        ...(model ? { model: workspaceModel(model) } : {}),
        ...(thought && currentThought ? { thinkingLevel: currentThought } : {}),
        ...(modeControl && modes.length ? { modes: { current: currentModeId ?? '', available: modes.map(item => ({ ...item })) } } : {}),
        blocks: [...blocks.values()],
        approvals: [...approvals.values()].map(item => item.approval),
        capabilities: capabilities(),
        models: models.map(workspaceModel),
      };
    },
    async models() { return models.map(workspaceModel); },
    async catalogModels() { return models.map(model => ({ ...workspaceModel(model), supportsFast: false })); },
    async resources() { return { items: commands.map(command => ({ kind: 'skill', id: command, name: command, enabled: true, configurable: false })), warnings: [] }; },
    composerCapabilities() { return { steer: false, compact: false }; },
    async prompt({ text, mode } = {}) {
      if (typeof text !== 'string' || !text.trim()) throw fail('invalid-request', 'A non-empty prompt is required.');
      if (gooseNano && (currentModeId !== 'approve' || currentModelId !== config.model.id)) {
        throw fail('unsupported-settings', 'Goose changed the Nano session model or approval mode.');
      }
      if (gooseNano && /^\s*\/[\w-]+(?:\s|$)/u.test(text)) {
        throw fail('unsupported-method', 'Native slash commands are unavailable on the Nano source of Goose.');
      }
      if (mode === 'steer') throw fail('unsupported-method', `${name} cannot steer an active turn.`);
      if (mode !== 'prompt' && mode !== 'follow-up') throw fail('invalid-request', 'The prompt mode is invalid.');
      if (disposed || exited || transportFailed || status === 'failed') throw fail('not-running', `${name} is not running.`);
      if (mode === 'follow-up' && status === 'running') { followUps.push(text); return { accepted: true }; }
      if (status !== 'idle') throw fail('busy', `${name} is already running a turn.`);
      startTurn(text);
      return { accepted: true };
    },
    async interrupt() {
      if (status !== 'running' || !sessionId) return { interrupted: false };
      // ACP: after session/cancel the client answers every pending permission request as cancelled.
      notify('session/cancel', { sessionId });
      settleApprovals();
      return { interrupted: true };
    },
    async setModel({ model, thinkingLevel, serviceTier } = {}) {
      if (status !== 'idle') throw fail('turn-active', 'Wait for the current turn before changing these settings.');
      if (serviceTier != null && serviceTier !== 'standard') throw fail('unsupported-settings', `${name} has no speed setting.`);
      if (!model || typeof model.id !== 'string') throw fail('invalid-request', 'A model is required.');
      // A change of model source needs a new session: refused, never matched by id.
      if (nanoModes && model.provider !== nanoProvider) throw fail('invalid-model', `The selected model is not offered by ${name}.`);
      if (nanoModes || model.id !== 'default') await selectModel(model.id, model.provider);
      if (thinkingLevel != null) await selectThought(thinkingLevel);
      const current = currentModel();
      return { ...(current ? { model: workspaceModel(current) } : {}), ...(currentThought ? { thinkingLevel: currentThought } : {}) };
    },
    async setMode({ modeId } = {}) {
      if (typeof modeId !== 'string' || !modeId) throw fail('invalid-request', 'A mode is required.');
      if (disposed || exited || transportFailed) throw fail('not-running', `${name} is not running.`);
      await selectMode(modeId);
      return { current: currentModeId };
    },
    async respond({ requestId, decision, text } = {}) {
      const item = approvals.get(requestId);
      if (!item) throw fail('stale-approval', 'The approval request is invalid or no longer pending.');
      if (!item.approval.decisions.includes(decision)) throw fail('invalid-request', 'The selected approval decision is not available.');
      let outcome;
      if (decision === 'cancel') outcome = { outcome: 'cancelled' };
      else {
        const option = item.options.find(candidate => candidate.id === text) ?? item.options.find(candidate => candidate.label === text);
        if (!option) throw fail('invalid-request', 'Choose one of the offered options.');
        outcome = { outcome: 'selected', optionId: option.native };
      }
      approvals.delete(requestId);
      write({ id: item.nativeId, result: { outcome } });
      emit({ type: 'approvalResolved', requestId });
    },
    async rename({ title: value } = {}) { if (typeof value === 'string' && value.trim()) title = value; },
    async dispose() {
      disposed = true;
      rejectFollowUps();
      if (status === 'running' && sessionId) notify('session/cancel', { sessionId });
      settleApprovals();
      server?.close();
      child.stdin.end();
      child.kill();
      await cleanReadiness();
    },
  };
}
