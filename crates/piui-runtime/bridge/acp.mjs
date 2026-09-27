// Generic Agent Client Protocol (ACP v1) adapter. The agent owns inference,
// tools, credentials and history; this bridge only translates JSON-RPC 2.0
// over the agent's stdio (LF-framed) into the native bridge contract. The
// host resolves the agent from a descriptor, clears its environment to an
// allowlist and contains the whole process tree (Job / process group).
export async function createAcpAdapter(config, emit, coordinatorRequest) {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { createHash, randomUUID } = await import('node:crypto');
  const { isAbsolute } = await import('node:path');

  const PROTOCOL_VERSION = 1;
  const FRAME_LIMIT = 32 * 1024 * 1024;
  const TEXT_LIMIT = 16 * 1024;
  const NOISE_LIMIT = 64;
  const AUTH_REQUIRED = -32000;
  const METHOD_NOT_FOUND = -32601;
  const acp = config.acp && typeof config.acp === 'object' ? config.acp : {};
  const name = typeof acp.displayName === 'string' && acp.displayName.trim() ? acp.displayName.trim().slice(0, 64) : 'The agent';
  const disabled = acp.disable && typeof acp.disable === 'object' ? acp.disable : {};
  const fail = (code, message = `${name} could not complete the operation.`, details) =>
    Object.assign(new Error(code), { bridgeCode: code, safeMessage: message, ...(details ? { safeDetails: details } : {}) });

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
  const child = spawn(config.runtimeProgram, config.runtimeArgs, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
  const applyConfigOptions = list => {
    if (!Array.isArray(list)) return;
    for (const option of list) {
      if (option?.type !== 'select' || typeof option.id !== 'string' || typeof option.currentValue !== 'string') continue;
      const values = selectValues(option.options);
      if (option.category === 'model' && !disabled.models) {
        modelControl = { kind: 'config', configId: option.id };
        models = values.map(item => ({ id: item.value, name: item.name, ...(item.group ? { provider: item.group } : {}) }));
        currentModelId = option.currentValue;
      } else if (option.category === 'mode' && !disabled.modes) {
        modeControl = { kind: 'config', configId: option.id };
        modes = values.map(item => ({ id: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) }));
        currentModeId = option.currentValue;
      } else if (option.category === 'thought_level') {
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
      models = state.models.availableModels.filter(item => typeof item?.modelId === 'string').slice(0, 500).map(item => ({ id: item.modelId, name: oneLine(item.name, 80) || item.modelId }));
      currentModelId = typeof state.models.currentModelId === 'string' ? state.models.currentModelId : undefined;
    }
    if (!modeControl && !disabled.modes && Array.isArray(state.modes?.availableModes)) {
      modeControl = { kind: 'legacy' };
      modes = state.modes.availableModes.filter(item => typeof item?.id === 'string').slice(0, 50).map(item => ({ id: item.id, name: oneLine(item.name, 80) || item.id, ...(oneLine(item.description) ? { description: oneLine(item.description) } : {}) }));
      currentModeId = typeof state.modes.currentModeId === 'string' ? state.modes.currentModeId : undefined;
    }
  };
  const workspaceModel = entry => ({ ...entry, ...(thought ? { thinkingLevels: [...thought.values] } : {}) });
  const currentModel = () => models.find(item => item.id === currentModelId);
  const setConfig = async (configId, value) => {
    const result = await request('session/set_config_option', { sessionId, configId, value });
    applyConfigOptions(result?.configOptions);
  };
  const selectModel = async id => {
    if (!modelControl || !models.some(item => item.id === id)) throw fail('invalid-model', `The selected model is not offered by ${name}.`);
    if (id === currentModelId) return;
    if (modelControl.kind === 'config') await setConfig(modelControl.configId, id);
    else await request('session/set_model', { sessionId, modelId: id });
    currentModelId = id;
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
    put({ id: state.blockId, kind: 'tool', label: 'Tool', title: oneLine(state.title) || `${name} tool`, ...(TOOL_NAMES[state.kind] ? { toolName: TOOL_NAMES[state.kind] } : {}), text, ...(truncated ? { truncated: true } : {}), status: statusValue, collapsible: true });
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
    const lines = (Array.isArray(entries) ? entries : []).slice(0, 100).map(entry => `${marks[entry?.status] ?? '[ ]'} ${oneLine(entry?.content, 300)}`);
    const { text, truncated } = bounded(lines.join('\n'));
    streaming = undefined;
    put({ id: `acp-plan-${turn}`, kind: 'custom', label: 'Plan', title: 'Plan', text, ...(truncated ? { truncated: true } : {}), collapsible: true });
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
        commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).filter(item => typeof item?.name === 'string').slice(0, 200).map(item => oneLine(item.name, 80)).filter(Boolean);
        break;
      case 'current_mode_update': if (typeof update.currentModeId === 'string' && modes.some(item => item.id === update.currentModeId)) currentModeId = update.currentModeId; break;
      case 'config_option_update': applyConfigOptions(update.configOptions); break;
      // Context size and agent-side titles are not PiUI turn data.
      case 'usage_update': case 'session_info_update': break;
      default:
        streaming = undefined;
        put({ id: `acp-event-${++sequence}`, kind: 'custom', label: name, title: `${name} event`, text: `Unsupported agent update: ${oneLine(String(kind ?? 'unknown'), 80)}`, fallback: true, collapsible: true });
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
      kind: APPROVAL_KINDS[toolCall.kind ?? known?.kind] ?? 'permission',
      title: oneLine(toolCall.title ?? known?.title) || `${name} asks for permission`,
      description: [`${name} asks before running this tool.`, bounded(detail, 1200).text].filter(Boolean).join('\n\n'),
      decisions: ['approve-once', 'cancel'],
      options: options.map(({ id: optionId, label }) => ({ id: optionId, label })),
    };
    approvals.set(id, { nativeId: message.id, options, approval });
    emit({ type: 'approval', approval });
  };

  // --- Turns -------------------------------------------------------------------
  const finishTurn = () => {
    if (disposed || status !== 'running') return;
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
  const onMessage = message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { failTransport(); return; }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (message.method === 'session/request_permission') onPermission(message);
        // fs/* and terminal/* were never advertised; nothing else is a client method.
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
    onMessage(message);
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
        } else if (message.method === 'tools/list') result = { tools: [tool] };
        else if (message.method === 'tools/call' && message.params?.name === 'workspace') {
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
    const initialized = await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'piui', title: 'PiUI', version: '0.1.1' } });
    if (initialized?.protocolVersion !== PROTOCOL_VERSION) throw fail('unsupported-protocol', `${name} speaks an unsupported ACP protocol version.`);
    agentCapabilities = initialized.agentCapabilities && typeof initialized.agentCapabilities === 'object' ? initialized.agentCapabilities : {};
    authMethods = (Array.isArray(initialized.authMethods) ? initialized.authMethods : []).map(method => oneLine(method?.name ?? method?.id, 80)).filter(Boolean).slice(0, 6);
    if (config.coordination) {
      if (agentCapabilities.mcpCapabilities?.http !== true || disabled.mcpHttp || typeof coordinatorRequest !== 'function') {
        throw fail('unsupported-coordinator', `${name} cannot receive the PiUI workspace tool because it does not accept HTTP MCP servers.`);
      }
      await startCoordinator();
    }
    const signIn = error => error?.nativeCode === AUTH_REQUIRED ? fail('acp-sign-in-required', `Sign in to ${name} first.`, { authMethods }) : undefined;
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
      try { created = await request('session/new', { cwd, mcpServers }); }
      catch (error) { throw signIn(error) ?? error; }
      if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 256) throw fail('invalid-session', `${name} did not create a conversation.`);
      sessionId = created.sessionId;
      applySessionState(created);
    }
    if (config.model?.id && config.model.id !== 'default') await selectModel(config.model.id);
    if (config.thinkingLevel) await selectThought(config.thinkingLevel);
    setStatus('idle');
  } catch (error) {
    disposed = true;
    child.kill();
    server?.close();
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
      if (model.id !== 'default') await selectModel(model.id);
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
    },
  };
}
