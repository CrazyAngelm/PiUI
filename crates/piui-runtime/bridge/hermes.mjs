// Hermes owns inference, tools, authentication and SQLite history. This adapter
// translates ACP messages only; the containing host Job owns every child.
export async function createHermesAdapter(config, emit, coordinatorRequest) {
  const { spawn } = await import('node:child_process');
  const { realpath } = await import('node:fs/promises');
  const { join, isAbsolute } = await import('node:path');
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const fail = (code, message = 'Hermes could not complete the operation.') => Object.assign(new Error(code), { bridgeCode: code, safeMessage: message });
  if (config.harness !== 'hermes' || !isAbsolute(config.cwd) || !config.runtimeProgram || !isAbsolute(config.agentDir)) throw fail('invalid-configuration');
  if (config.permissionMode !== 'native' || config.baseInstructions != null || config.thinkingLevel || config.serviceTier === 'fast' || config.allowedTools != null || config.resourceRules?.length || config.nativeSubagents != null) throw fail('unsupported-settings', 'Hermes ACP does not support the requested per-session restriction.');
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const nativePath = join(config.agentDir, 'state.db');
  if (config.nativePath && config.nativePath !== nativePath) throw fail('invalid-session');
  // Same frame bound as the host-private runner protocol.
  const frameLimit = 32 * 1024 * 1024;
  const children = new Set();
  const start = args => {
    const child = spawn(config.runtimeProgram, args, { cwd: config.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERMES_HOME: config.agentDir, PYTHONIOENCODING: 'utf-8', ...(config.model?.id ? { PIUI_HERMES_MODEL: config.model.id } : {}) } });
    children.add(child); child.once('exit', () => children.delete(child));
    child.stderr.on('data', () => {}); // Native diagnostics can contain prompt/credential data.
    return child;
  };
  // Native inventory with its documented no-refresh/no-probe flags. In contrast,
  // ACP's named-provider picker probes every endpoint during session creation.
  const inventorySource = `
def piui_model_state(model,provider,base_url):
 from hermes_cli.inventory import build_models_payload,load_picker_context
 from hermes_cli.models import normalize_provider,provider_label
 from acp_adapter.model_catalog import _ModelCatalog,encode_model_choice
 from acp.schema import SessionModelState
 context=load_picker_context().with_overrides(current_provider=normalize_provider(provider),current_model=model,current_base_url=base_url)
 payload=build_models_payload(context,explicit_only=True,include_unconfigured=False,picker_hints=False,canonical_order=True,pricing=False,capabilities=False,refresh=False,probe_custom_providers=False,probe_current_custom_provider=False)
 cat=_ModelCatalog(normalize_provider=normalize_provider,current_model=model,current_choice_provider=provider,current_base_url=base_url)
 from hermes_cli.config import get_compatible_custom_providers,load_config,is_provider_enabled
 from hermes_cli.providers import custom_provider_slug
 from hermes_cli.model_switch import _declared_model_ids
 cfg=load_config()
 named=[]; slugs={}
 for entry in get_compatible_custom_providers(cfg):
  key=str(entry.get('provider_key') or ''); name=str(entry.get('name') or '')
  raw=(cfg.get('providers') or {}).get(key,{})
  if not is_provider_enabled(raw): continue
  slug=custom_provider_slug(name,key)
  slugs[key.lower()]=slug
  declared=list(dict.fromkeys([m for m in [entry.get('model'),*_declared_model_ids(entry.get('models'))] if m]))
  named.append((slug,name,[(m,'') for m in declared]))
 rows=[{**row,'slug':slugs.get(str(row.get('slug','')).lower(),row.get('slug'))} for row in payload.get('providers') or []]
 cat.add_inventory_rows(rows,provider_label)
 cat.add_named_catalogs(named,normalize_provider(provider))
 current=encode_model_choice(provider,model)
 return SessionModelState(current_model_id=current,available_models=cat.models) if cat.models else None
`;
  const catalogSource = `import contextlib,json,sys
with contextlib.redirect_stdout(sys.stderr):
 from hermes_cli.config import load_config
 from acp_adapter.auth import detect_provider
 from acp_adapter.entry import _load_env
 _load_env()
 exec(${JSON.stringify(inventorySource)})
 from tools.skills_tool import _find_all_skills,_is_skill_disabled
 cfg=load_config(); model=cfg.get('model') or {}; model=model if isinstance(model,dict) else {'default':model}
 state=piui_model_state(str(model.get('default') or ''),str(model.get('provider') or detect_provider() or ''),str(model.get('base_url') or ''))
 models=[] if state is None else [{'id':m.model_id,'name':m.name,'supportsFast':False} for m in state.available_models]
 warnings=[]
 items=[{'kind':'skill','id':s['name'],'name':s['name'],'enabled':not _is_skill_disabled(s['name']),'configurable':False} for s in _find_all_skills()]
 items += [{'kind':'mcp','id':n,'name':n,'enabled':not isinstance(v,dict) or v.get('enabled',True) is not False,'configurable':False} for n,v in (cfg.get('mcp_servers') or {}).items()]
 try:
  from model_tools import get_tool_definitions
  items += [{'kind':'tool','id':t['function']['name'],'name':t['function']['name'],'enabled':True,'configurable':False} for t in get_tool_definitions(enabled_toolsets=['hermes-acp'],quiet_mode=True)]
 except Exception: warnings.append('Hermes tool inventory is unavailable.')
print(json.dumps({'models':models,'resources':{'items':items,'warnings':warnings}}))`;
  let catalog;
  async function readCatalog() {
    if (catalog) return catalog;
    const child = start(['-P', '-c', catalogSource]);
    let data = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', part => { data += part; if (Buffer.byteLength(data) > frameLimit) child.kill(); });
    catalog = await new Promise((resolve, reject) => {
      child.once('error', () => reject(fail('catalog-unavailable')));
      child.once('exit', code => { try { if (code !== 0) throw new Error(); resolve(JSON.parse(data)); } catch { reject(fail('catalog-unavailable')); } });
    });
    return catalog;
  }
  const capability = (supported, enforcement = 'native') => ({ supported, enforcement: supported ? enforcement : 'unsupported' });
  const capabilities = { prompt: capability(true), resume: capability(true), models: capability(true), approvals: capability(true), instructions: capability(true, 'coordinator'), toolPolicy: capability(false), nativeSubagents: capability(false) };
  if (config.catalogOnly) { await readCatalog(); return {
    async catalogModels() { return (await readCatalog()).models; },
    async models() { return (await readCatalog()).models.map(({ supportsFast, ...model }) => model); },
    async resources() { return (await readCatalog()).resources; },
    async dispose() { for (const child of children) child.kill(); },
  }; }

  let server;
  const mcpServers = [];
  if (config.coordination) {
    const token = randomUUID();
    server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      try {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > frameLimit) throw fail('frame-too-large'); }
        const message = JSON.parse(raw); let result;
        if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'piui-workspace', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: [{ name: 'workspace', description: 'Read roster before delegating. It describes when each allowed helper is useful, its required input and expected result. Use only authorized routes.', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['roster', 'send', 'observe', 'wait', 'spawn', 'spawnAgent'] }, recipientMemberId: { type: 'string' }, targetMemberId: { type: 'string' }, body: { type: 'string' }, stepId: { type: 'string' }, profileId: { type: 'string' }, name: { type: 'string' }, instructions: { type: 'string' } }, required: ['type'], additionalProperties: false } }] };
        else if (message.method === 'tools/call' && message.params?.name === 'workspace') {
          try { result = { content: [{ type: 'text', text: JSON.stringify(await coordinatorRequest(message.params.arguments)) }] }; }
          catch { result = { isError: true, content: [{ type: 'text', text: 'The workspace coordinator denied or could not complete this operation.' }] }; }
        } else if (message.id === undefined) { res.writeHead(202).end(); return; }
        else throw fail('unknown-method');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      } catch { res.writeHead(400).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    mcpServers.push({ type: 'http', name: 'piui-workspace', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
  }
  const launchSource = `
import os
from acp_adapter.entry import main
from acp_adapter import server,session
${inventorySource}
server.build_model_state=piui_model_state
original=session.SessionManager._make_agent
choice=os.environ.get('PIUI_HERMES_MODEL')
def make_agent(self,**kwargs):
 if choice and not kwargs.get('model'):
  from hermes_cli.config import load_config
  cfg=load_config().get('model') or {}
  provider,model=server.HermesACPAgent._resolve_model_selection(choice,cfg.get('provider','openrouter') if isinstance(cfg,dict) else 'openrouter')
  kwargs.update(model=model,requested_provider=provider)
 agent=original(self,**kwargs)
 native_run=agent.run_conversation
 def run(*args,**kw):
  agent._piui_turn_failed=False
  try:
   result=native_run(*args,**kw)
   agent._piui_turn_failed=bool(result.get('failed') or result.get('error'))
   return result
  except Exception:
   agent._piui_turn_failed=True
   raise
 agent.run_conversation=run
 return agent
session.SessionManager._make_agent=make_agent
native_finish=server.HermesACPAgent._finish_turn
async def finish(self,state,*args,**kwargs):
 response=await native_finish(self,state,*args,**kwargs)
 if getattr(state.agent,'_piui_turn_failed',False):
  response.field_meta={**(response.field_meta or {}),'piuiOutcome':'failed'}
 return response
server.HermesACPAgent._finish_turn=finish
from acp_adapter.entry import main
main()
`;
  const child = start(config.runtimeArgs[0] === '-m' ? ['-P', '-c', launchSource] : config.runtimeArgs);
  const pending = new Map(); const approvals = new Map(); const blocks = new Map();
  let sequence = 0, buffer = '', sessionId, boundNativeId, title = config.title ?? 'Hermes conversation', status = 'starting', currentModel, models = [], turn = 0, streamingId, disposed = false, loading = false;
  // ACP `promptCapabilities.image` and the latest `available_commands_update`.
  let acceptsImages = false, availableCommands = [];
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const promptImages = images => {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images) || images.length > 6 || images.some(image => !image || typeof image !== 'object' || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== 'string' || !image.data)) throw fail('invalid-request', 'The prompt images are invalid.');
    return images.map(image => ({ mimeType: image.mimeType, data: image.data }));
  };
  const send = value => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject, method }); send({ id, method, params }); });
  const put = value => { const block = { label: value.title ?? value.kind, status: 'complete', ...value }; blocks.set(block.id, block); emit({ type: 'block', block }); };
  const setStatus = value => { status = value; emit({ type: 'status', status }); };

  // Hermes ACP has no native follow-up queue. A follow-up that arrives during a
  // turn waits here (FIFO) and becomes the next prompt once that turn ends.
  const followUps = [];
  const rejectFollowUps = () => {
    if (followUps.splice(0).length === 0) return;
    emit({ type: 'error', message: 'Queued Hermes messages were not delivered because the session stopped.' });
  };
  const showTurnError = message => {
    put({ id: `hermes-error-${++sequence}`, kind: 'error', label: 'Error', status: 'failed', safeSummary: message });
    emit({ type: 'error', message });
  };
  // A failed turn does not fail the session: the user can continue, and a
  // queued follow-up starts the next turn directly.
  const finishTurn = () => {
    if (disposed || status !== 'running') return;
    const next = followUps.shift();
    if (next === undefined) setStatus('idle');
    else startTurn(next);
  };
  // A user message lists each image it carried as an `[image]` line.
  const withImageMarkers = (text, images) => {
    if (!images) return text;
    const markers = Array.from({ length: images }, () => '[image]').join('\n');
    return text ? `${text}\n\n${markers}` : markers;
  };
  const startTurn = ({ text, images = [] }) => {
    ++turn;
    streamingId = undefined;
    put({ id: `hermes-user-${turn}`, kind: 'user', text: withImageMarkers(text, images.length), status: 'complete' });
    setStatus('running');
    const input = config.instructions ? `Agent instructions:\n${config.instructions}\n\nTask:\n${text}` : text;
    const usageId = randomUUID();
    // ACP image content blocks, sent only when the agent declared image input.
    const prompt = [{ type: 'text', text: input }, ...images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data }))];
    void request('session/prompt', { sessionId, prompt }).then(result => {
      if (result.usage) {
        const usage = { id: usageId };
        for (const [source, target] of [["inputTokens","inputTokens"],["outputTokens","outputTokens"],["cachedReadTokens","cacheReadTokens"],["totalTokens","totalTokens"]]) {
          if (Number.isSafeInteger(result.usage[source]) && result.usage[source] >= 0) usage[target] = result.usage[source];
        }
        emit({ type: 'usage', usage });
      }
      for (const block of blocks.values()) if (block.status === 'streaming') put({ ...block, status: 'complete' });
      boundNativeId = result?._meta?.hermes?.sessionProvenance?.currentHermesSessionId ?? boundNativeId;
      emit({ type: 'binding', nativeId: boundNativeId, nativePath });
      const outcome = result._meta?.piuiOutcome === 'failed' ? 'failed' : result.stopReason === 'end_turn' ? 'succeeded' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
      if (outcome === 'failed') showTurnError('Hermes could not complete this turn. Check the native provider response.');
      emit({ type: 'turnCompleted', outcome });
      finishTurn();
    }).catch(error => {
      if (!disposed) {
        for (const block of blocks.values()) if (block.status === 'streaming') put({ ...block, status: 'failed' });
        showTurnError(error?.safeMessage ?? 'Hermes could not complete this turn.');
      }
      emit({ type: 'turnCompleted', outcome: 'failed' });
      finishTurn();
    });
  };
  const update = message => {
    const u = message.params?.update; if (!u) return;
    const kind = u.sessionUpdate;
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(kind)) {
      // A user image in replayed history is listed as an `[image]` line.
      const userImage = kind === 'user_message_chunk' && u.content?.type === 'image';
      if (u.content?.type !== 'text' && !userImage) { put({ id: `hermes-media-${++sequence}`, kind: 'custom', title: 'Hermes content', text: 'This native content type is not supported by the current renderer.', fallback: true }); return; }
      const role = kind === 'agent_message_chunk' ? 'assistant' : kind === 'agent_thought_chunk' ? 'thinking' : 'user';
      if (!streamingId || blocks.get(streamingId)?.kind !== role || loading) streamingId = `hermes-${role}-${++sequence}`;
      const previous = blocks.get(streamingId);
      put({ id: streamingId, kind: role, text: userImage ? withImageMarkers(previous?.text ?? '', 1) : (previous?.text ?? '') + u.content.text, status: loading ? 'complete' : 'streaming' });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      streamingId = undefined; const id = `hermes-tool-${u.toolCallId}`; const old = blocks.get(id);
      put({ ...old, id, kind: 'tool', title: u.title ?? old?.title ?? 'Hermes tool', text: u.content?.map(c => c.content?.text ?? '').filter(Boolean).join('\n') || old?.text || '', status: u.status === 'failed' ? 'failed' : u.status === 'completed' ? 'complete' : 'streaming', collapsible: true });
    } else if (kind === 'available_commands_update') {
      // ACP slash commands the agent runs itself when a prompt starts with `/<name>`.
      availableCommands = (Array.isArray(u.availableCommands) ? u.availableCommands : [])
        .filter(command => typeof command?.name === 'string' && command.name.length <= 160)
        .map(command => ({
          name: command.name,
          ...(typeof command.description === 'string' && command.description.trim() ? { description: command.description.slice(0, 600) } : {}),
          ...(typeof command.input?.hint === 'string' && command.input.hint.trim() ? { hint: command.input.hint.slice(0, 240) } : {}),
          source: 'command',
        }));
    } else if (!['usage_update', 'current_mode_update', 'session_info_update', 'config_option_update'].includes(kind)) {
      put({ id: `hermes-event-${++sequence}`, kind: 'custom', title: 'Hermes event', text: String(kind ?? 'Unknown native event'), fallback: true, collapsible: true });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let at;
    if (Buffer.byteLength(buffer) > frameLimit) { for (const slot of pending.values()) slot.reject(fail('frame-too-large')); pending.clear(); setStatus('failed'); child.kill(); return; }
    while ((at = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!raw.trim()) continue;
      try {
        const msg = JSON.parse(raw);
        if (msg.method === 'session/update') update(msg);
        else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
          const id = String(msg.id); const options = msg.params.options ?? [];
          const approval = { id, kind: 'command', title: msg.params.toolCall?.title ?? 'Hermes permission', description: 'Hermes requests permission for this operation.', decisions: ['approve-once', 'deny', 'cancel'] };
          approvals.set(id, { requestId: msg.id, options, approval });
          emit({ type: 'approval', approval });
        } else if (msg.method && msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Client operation unavailable' } });
        else if (pending.has(msg.id)) { const slot = pending.get(msg.id); pending.delete(msg.id); if (msg.error) { const diagnostic = JSON.stringify(msg.error); const category = [['authentication', /API.key|credential|authentication/i], ['database', /database|sqlite|locked/i], ['provider', /provider|model/i], ['dependency', /ImportError|ModuleNotFound|module/i], ['configuration', /validation|argument|TypeError|ValueError/i]].find(([, pattern]) => pattern.test(diagnostic))?.[0] ?? 'native error'; slot.reject(fail('native-request-failed', `Hermes could not complete ${slot.method} (${category}, ${msg.error.code}).`)); } else slot.resolve(msg.result); }
      } catch { for (const slot of pending.values()) slot.reject(fail('invalid-native-protocol')); pending.clear(); setStatus('failed'); child.kill(); }
    }
  });
  const exited = () => { for (const slot of pending.values()) slot.reject(fail('native-exited')); pending.clear(); rejectFollowUps(); if (!disposed) setStatus('failed'); server?.close(); };
  child.once('error', exited); child.once('exit', exited);
  try {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'piui', version: '0.1.1' } });
    if (initialized.protocolVersion !== 1 || initialized.agentInfo?.version !== '0.21.0') throw fail('unsupported-version', 'The Hermes ACP version or protocol is unsupported.');
    acceptsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
    if (config.nativeId) {
      // Never call Hermes resume: its missing-id fallback creates a new session.
      let cursor, found;
      do { const page = await request('session/list', { cwd: config.cwd, ...(cursor ? { cursor } : {}) }); found = page.sessions?.find(item => item.sessionId === config.nativeId); cursor = page.nextCursor; } while (!found && cursor);
      if (!found || !found.cwd || canonical(await realpath(found.cwd)) !== canonical(await realpath(config.cwd))) throw fail('invalid-session', 'The saved Hermes conversation is unavailable in this project.');
      sessionId = config.nativeId;
    }
    loading = true;
    const attached = await request(sessionId ? 'session/load' : 'session/new', { cwd: config.cwd, mcpServers, ...(sessionId ? { sessionId } : {}) });
    loading = false; sessionId ??= attached?.sessionId; boundNativeId = attached?._meta?.hermes?.sessionProvenance?.currentHermesSessionId ?? sessionId;
    if (!sessionId || !attached) throw fail('invalid-session');
    models = (attached.models?.availableModels ?? []).map(m => ({ id: m.modelId, name: m.name }));
    currentModel = models.find(m => m.id === attached.models?.currentModelId);
    if (config.model && config.model.id !== currentModel?.id) { if (!models.some(m => m.id === config.model.id)) throw fail('invalid-model'); await request('session/set_model', { sessionId, modelId: config.model.id }); currentModel = models.find(m => m.id === config.model.id); }
    setStatus('idle');
  } catch (error) { disposed = true; child.kill(); server?.close(); throw error; }
  return {
    snapshot() { return { nativeId: boundNativeId, nativePath, materialized: true, title, status, ...(currentModel ? { model: currentModel } : {}), models, blocks: [...blocks.values()], approvals: [...approvals.values()].map(item => item.approval), capabilities }; },
    async models() { return models; },
    async catalogModels() { return models.map(m => ({ ...m, supportsFast: false })); },
    async resources() { return (await readCatalog()).resources; },
    composerCapabilities() { return { steer: false, compact: false, images: acceptsImages }; },
    // Hermes skills have no mention syntax of their own; its ACP commands do.
    composerCatalog() { return { commands: availableCommands, skills: [] }; },
    async prompt({ text, mode, images: attached }) {
      if (typeof text !== 'string' || !text.trim()) throw fail('invalid-request', 'A non-empty prompt is required.');
      if (mode === 'steer') throw fail('unsupported-method', 'Hermes ACP cannot steer an active turn.');
      if (mode !== 'prompt' && mode !== 'follow-up') throw fail('invalid-request', 'The prompt mode is invalid.');
      const images = promptImages(attached);
      if (images.length && !acceptsImages) throw fail('unsupported-input', 'This Hermes agent does not accept images.');
      if (mode === 'follow-up' && status === 'running') {
        followUps.push({ text, images });
        return { accepted: true };
      }
      if (status !== 'idle') throw fail('busy');
      startTurn({ text, images });
      return { accepted: true };
    },
    async interrupt() { send({ method: 'session/cancel', params: { sessionId } }); },
    async setModel({ model, thinkingLevel, serviceTier }) { if (status !== 'idle' || thinkingLevel || serviceTier === 'fast' || !models.some(m => m.id === model.id)) throw fail('unsupported-settings'); await request('session/set_model', { sessionId, modelId: model.id }); currentModel = models.find(m => m.id === model.id); },
    async respond({ requestId: approvalId, decision }) {
      const approval = approvals.get(approvalId); if (!approval) throw fail('invalid-approval');
      const option = approval.options.find(o => o.kind === (decision === 'approve-once' ? 'allow_once' : 'reject_once'));
      send({ id: approval.requestId, result: { outcome: decision === 'cancel' || !option ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option.optionId } } });
      approvals.delete(approvalId); emit({ type: 'approvalResolved', requestId: approvalId });
    },
    async rename({ title: value }) { title = value; },
    async dispose() { disposed = true; rejectFollowUps(); if (status === 'running') send({ method: 'session/cancel', params: { sessionId } }); server?.close(); for (const item of children) item.kill(); },
  };
}
