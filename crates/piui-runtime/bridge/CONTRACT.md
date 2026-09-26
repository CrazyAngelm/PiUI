# Internal native bridge contract (v1)

This is HOST-PRIVATE, not WebView IPC. Runtime-owned session paths/native ids are legal only here. Rust maps them to opaque workspace session IDs. No provider clients/model loop may be implemented in bridge code.

## Embedding and ownership
Rust embeds factory source bytes and common runner, concatenates them into one ESM source, and launches a fixed small `node --input-type=module -e <bootstrap>` inside a Windows Job assigned before resume or Unix process group. To avoid Windows' command-line limit, Rust writes an exact checked 4-byte little-endian source length followed by those trusted source bytes to stdin; the bootstrap reads exactly that prefix and imports it as an in-memory data module, leaving subsequent LF JSON untouched. No writable temp JavaScript files. Each adapter file exports ONLY its unique top-level function; put imports/constants/helpers inside the factory to avoid collisions in concatenation. Native children inherit containment. Script modules must not print to stdout except common runner protocol. Do not expose raw errors, environment, auth or raw native protocol to UI/logs.

Factories: `export async function createPrimeAdapter(config, emit)`, `createCodexAdapter`, `createPiAdapter`, `createClaudeAdapter` (see Claude Code below). Config: `{cwd: absolute trusted workspace, sessionDir: host-owned native storage directory, nativeId?: string, nativePath?: string, title?: string, model?: {id,provider?,name}, thinkingLevel?:string, instructions?:string, permissionMode:'native'|'read-only'|'workspace-write'|'full-access', networkAccess?:boolean, allowedTools?:string[], nativeSubagents?:boolean, daemonSocket:explicit nondefault reserved endpoint}`. `networkAccess` is an explicit Codex-only native capability for `read-only` or `workspace-write`; omission is network-denied and child admission cannot widen it. Runtime resolution is host-side/system install; no arbitrary executable/path from frontend. Prime must avoid default daemon. Do not silently accept unsupported mandatory instructions/tools/permissions.

Factory returns adapter:
- `snapshot()` -> NativeSnapshot
- `prompt({text,mode:'prompt'|'steer'|'follow-up'})` -> acceptance only (do not await full turn); reject concurrent unsupported prompt. Native adapter owns underlying turn promise, emits failures and final idle status.
- `interrupt()` -> native turn interrupt
- `models()` -> WorkspaceModel[]
- `setModel({model,thinkingLevel?})`
- `respond({requestId,decision:'approve-once'|'approve-session'|'deny'|'cancel',text?})`
- `rename({title})`
- `dispose()` -> gracefully end own session/process. Rust containment remains authoritative fallback.
Optional `listSessions({cwd})` -> native references for read-only discovery; do not invent persistent history if upstream temporary.

`NativeSnapshot`: `{nativeId:string,nativePath?:string,title:string,status:'starting'|'idle'|'running'|'stopping'|'closed'|'failed',model?:WorkspaceModel,blocks:NativeBlock[],approvals:NativeApproval[],capabilities:HarnessCapabilities,models:WorkspaceModel[]}`.
`WorkspaceModel`: `{id:string,provider?:string,name:string,thinkingLevels?:string[]}`.
`NativeBlock` matches frozen `DesktopTimelineBlock` in contracts/runtime-protocol.ts: `{id,kind:'user'|'assistant'|'thinking'|'tool'|'custom'|'error'|'compaction'|'unknown',label,status:'complete'|'streaming'|'failed'|'interrupted',text?,createdAt?,parentId?,safeSummary?,title?,toolName?,collapsible?,truncated?,fallback?}`. Generic unknown content has safe text, no raw JSON/native private ids. Delta text belongs to a previously emitted block.
Pi tool blocks and Codex MCP/dynamic tool blocks are built from arbitrary native arguments/results. They carry a one-line `title` and at most ~16 KiB of `text`: longer output keeps its head and tail around an explicit `… N characters omitted …` marker and sets `truncated:true`. Cuts never split a UTF-16 surrogate pair. Arguments appear only as a compact bounded summary; nested values, binary content and tool `details` are never forwarded.
`NativeApproval`: `{id,kind:'command'|'file-change'|'permission'|'input',title,description,decisions:ApprovalDecision[],inputLabel?,options?:Array<{id,label}>}`. Internal native request maps stay adapter-owned; do not auto-approve. Validate supported decisions and exact origin. Superseded/resolved requests reject duplicate reply. `options` lists select-style choices with opaque adapter ids and bounded one-line labels; `respond({decision:'approve-once',text})` names one option id (an exact label is also accepted), the adapter maps it back to the exact native value, and any other value is rejected while the request stays pending.
`HarnessCapabilities`: keys `prompt,resume,models,approvals,instructions,toolPolicy,nativeSubagents`; each `{supported:boolean,enforcement:'native'|'coordinator'|'advisory'|'unsupported',reason?:string}`. A supported boolean means tested implementation; no silent fallback for mandatory policy.

`emit(event)` events:
- `{type:'block',block:NativeBlock}` (insert/update full block by id)
- `{type:'textDelta',blockId,text}`
- `{type:'status',status}`
- `{type:'approval',approval:NativeApproval}`
- `{type:'approvalResolved',requestId}`
- `{type:'binding',nativeId,nativePath?}` (host-private only)
- `{type:'error',message:safeFixedSummary}`

Runner request LF JSON: `{id:string,method:'initialize'|'snapshot'|'prompt'|'interrupt'|'models'|'setModel'|'respond'|'rename'|'dispose',params:object}`. Initialize params add `harness:'pi'|'prime-agent'|'codex'|'hermes'|'claude-code'` to config; exactly once. Return `{id,ok:true,result}` or `{id,ok:false,error:{code,message}}`; event `{event:NativeEvent}`. Buffer raw bytes, split only LF. Pending native operations must not serialize interruption/approval behind an active turn. EOF closes admission, calls dispose, then exits; Rust handles hung descendants. No generic evaluate/exec/file method.

Fixtures may inject fake adapters/transport only via separate test module imports; never production env switches. Runtime proofs use native installed harness with synthetic provider where supported, not a replacement agent loop. Missing package/auth/platform behavior is explicit.


## Authenticated coordinator tool (optional)
A managed run may enable `coordination: true` in host-private config. Ordinary sessions omit it. Factories receive optional third callback `coordinatorRequest(operation, {toolCallId, signal?})`; register a native `workspace` tool only when enabled and the callback exists. This does not replace a native model/tool loop or claim native daemon messaging support.

Strict operation union (reject unknown fields):
- `{type:'roster'}`
- `{type:'send',recipientMemberId:string,body:string}`
- `{type:'observe',targetMemberId:string}`
- `{type:'spawn',stepId:string}`

Spawn leases a ready predefined pipeline step, resolves its exact snapshotted assigned profile, and checks the authenticated caller's allowed spawn templates. It cannot add members or override policy/model/instructions. It is not unrestricted dynamic delegation. Roster and observation are ACL-filtered; observation returns authorized history references, never native filesystem locations.

Runner emits `{type:'coordinatorRequest',requestId:string,operation:CoordinatorOperation}` as a host-private NativeEvent. The host derives workspace/run/member/session from the emitting runtime binding, NEVER caller text or fields. `requestId` is an opaque origin-bound pending ID (native tool call IDs stay adapter-private); it also provides durable send/spawn deduplication. A Rust-only runtime method writes `coordinatorResponse` with `{requestId,response:{ok:true,result:JSON}|{ok:false,error:{code:string,message:safeFixedSummary}}}`. This method is NOT part of workspace WebView IPC. Reject duplicate, unknown, cross-origin or retired replies. On interrupt/EOF/dispose, settle pending tool calls as failures; do not leave a native turn waiting forever. Read/approval/interrupt/dispose must remain independently serviceable while a tool awaits its host response.

Codex implementation uses negotiated experimental dynamic tools and `item/tool/call` requests bound to native thread/turn/call/namespace/tool; no MCP server or global config changes. Prime/Pi use native SDK custom tool registration when supported; retain their generic tool-call timeline projection. If a runtime cannot implement this seam, reject mandatory coordinator-tool launches, not silent prompt-only fallback.


## Terminal turn outcome
`idle` is a session readiness state, NOT proof of task success. Native providers may end failed/interrupted turns by returning to idle. Each adapter MUST emit `{type:'turnCompleted',outcome:'succeeded'|'failed'|'interrupted'}` exactly once after an admitted turn reaches its native terminal outcome, before final idle. Native stop reasons/turn status determine outcome, not absence of transport errors. A failed command that was never admitted rejects normally; a transport loss with no terminal proof stays uncertain. Host tracks outcome with turn generation; initial idle or later idle cannot overwrite it. Scheduler success requires explicit succeeded, never status-only idle. This is host-private metadata, not a persisted replacement transcript.


## Composer operations

`composerCapabilities()` returns `{steer:boolean,compact:boolean}`. `compact()`
accepts an idle native context compaction and never emits a literal `/compact`
user prompt. Unsupported methods reject before execution. Native completion or
error updates the session state. `prompt({mode:"steer"})` requires an active
native turn and must not create a new turn when it races completion.

The workspace host owns the durable user Follow up outbox. Native adapters do
not add a second persistent message format or model loop. Pi and Codex expose
compact and steer, Prime reports actual SDK methods, Hermes ACP reports neither.

Hermes ACP has no native follow-up queue. `prompt({mode:"follow-up"})` starts a
turn while idle; during a turn the adapter keeps an in-memory FIFO and sends each
item as the next native prompt once the running turn reaches any terminal
outcome, without an intermediate idle. Dispose or native exit reports undelivered
items with a safe `error` event. A failed native prompt emits
`turnCompleted:"failed"`, keeps an `error` block visible and returns to idle.


## Claude Code (`claude.mjs`, harness `claude-code`)

Drives the user's own installed, unmodified `claude` executable (`runtimeProgram`,
resolved by the host; `shell:false`, never `--bare`) as
`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--permission-mode <mode>]`
plus `--session-id <uuid>` (new) or `--resume <uuid>` (open) and
`--settings {"fastMode":false}`. Protocol verified against Claude Code 2.1.232;
the host accepts `>=2.1.0 <3.0.0` from `claude --version`. No provider client or
model loop.

- Subscription only. The child environment drops API keys, bearer, identity and
  federation tokens (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_IDENTITY_TOKEN*`, `AWS_BEARER_TOKEN_BEDROCK`, ...), every provider
  switch (`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,MANTLE,ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD,GATEWAY}`
  and their `SKIP_*_AUTH`), API routing (`ANTHROPIC_BASE_URL`, `ANTHROPIC_*_BASE_URL`,
  `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_API_BASE_URL`),
  billing/account overrides (`CLAUDE_CODE_EXTRA_BODY`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`,
  `CLAUDE_CODE_RATE_LIMIT_TIER`, account ids), `PIUI_AGENT_API_*`, and the coupling
  a parent Claude Code host injects into its children (`CLAUDECODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`, session ids, messaging
  socket/token, host auth refresh, host proxies). The Rust launcher removes the
  same list before the bridge starts (a host test keeps both lists identical).
  The `initialize` `account` must report `apiProvider:"firstParty"`, no
  `apiKeySource`, no bearer/`apiKeyHelper` token source, and either
  `subscriptionType` (claude.ai login) or a `CLAUDE_CODE_OAUTH_TOKEN*` token
  source (`tokenSource:"none"` means signed out). Every `system/init` must report
  `apiKeySource:"none"`. Violations fail with `claude-subscription-required` and
  the fixed sign-in message (the host maps it to a typed `SIGN_IN_REQUIRED`
  status); a breach during a turn kills the CLI before its model request and
  fails the turn and the session. Credentials are never read, copied or logged;
  stderr is discarded.
- No paid extra usage. Fast mode is unsupported: `serviceTier:"fast"` fails with
  `unsupported-settings` before anything spawns (`standard` is accepted and is
  what every launch pins), the child runs with `CLAUDE_CODE_DISABLE_FAST_MODE=1`
  and `--settings {"fastMode":false}` (an inline per-session layer, never a file
  edit), the catalog reports `supportsFast:false`, and an `initialize`
  `fast_mode_state` other than `off` refuses a session start. A
  `rate_limit_event` with `isUsingOverage:true` stops the CLI, fails the turn and
  the session; the request that reported it may already have been billed.
- Permission modes: native passes no `--permission-mode` (the user's own
  configured default applies and is not verified); read-only→`plan`,
  workspace-write→`acceptEdits`, full-access→`bypassPermissions` are verified
  from `current_permission_mode` and every `system/init`. This is Claude Code's
  permission engine, not an OS sandbox. Read-only and workspace-write approvals
  offer only deny/cancel, so such a session can never approve a Bash command or
  any other prompted tool.
- Tool policy: `allowedTools` → `--tools` + `--strict-mcp-config` (and
  `--disallowed-tools mcp__*` without coordination). `--allowedTools` is only
  pre-approval and never expresses a restriction. `nativeSubagents:false` and
  managed runs add `--disallowed-tools Agent`. Resource rules, network policy,
  base-instruction replacement and unknown effort/speed values are rejected
  before spawning.
- Instructions use `--append-system-prompt-file`; the coordinator is a
  session-scoped HTTP MCP server (`piui-workspace`, bearer token) passed with
  `--mcp-config <file>` and pre-approved by `--allowed-tools
  mcp__piui-workspace__workspace`. Both files live in a 0600 directory under
  `sessionDir` (removed on dispose), so neither the token nor the instructions
  appear on the process command line.
- Turns: each written user message carries a uuid. Claude Code acknowledges
  consumption with `command_lifecycle` `started` or a replayed user message; an
  admitted turn completes once its messages are consumed or cancelled and the
  native run returned `result`, which yields exactly one `turnCompleted`. Steer
  uses the default queue priority, so Claude Code folds it into the running turn
  at the next tool boundary; if the turn ends first, the steer runs as the next
  native turn inside the same admitted turn. A follow-up during a turn uses
  `priority:"later"`. `interrupt` sends `{subtype:"interrupt",cancel_queued:true}`.
  `composerCapabilities` is `{steer:true,compact:false}` (compaction is only a
  literal `/compact` prompt headlessly).
- Settings: `set_model`; effort uses `apply_flag_settings {effortLevel}`. If the
  CLI rejects that request (older CLIs) while idle, the adapter restarts it
  transparently on the same conversation (`--resume`, or `--session-id` for an
  unmaterialized draft) with the new `--effort`. An explicit PiUI effort drops an
  inherited `CLAUDE_CODE_EFFORT_LEVEL` override, which would otherwise win; a
  later effort change with that override present restarts the CLI without it.
- Approvals map `can_use_tool` (Bash/PowerShell → command, Edit/Write/
  MultiEdit/NotebookEdit → file-change, AskUserQuestion → input, others →
  permission). approve-once → `allow` with the original input; approve-session →
  `allow` with the native suggestions rewritten to `destination:"session"` (never
  persisted to settings files); deny → `deny`; cancel → `deny` with `interrupt`
  plus the interrupt control. AskUserQuestion supports one question: options
  answer with the native label, multi-select takes comma-separated text, and
  several questions are declined with guidance. `control_cancel_request`
  retires the approval.
- History: the CLI does not replay on resume, so the adapter reads
  `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, non-alphanumerics → '-'>/<id>.jsonl`
  read-only and best-effort (active branch, compaction via `logicalParentUuid`;
  meta, sidechain and internal entries skipped; newest 2000 blocks within 8 MiB).
  A missing transcript fails with `invalid-session`; a new conversation is never
  substituted. `rename` is PiUI metadata only.
- Catalog: models map `value`/`displayName`/`supportedEffortLevels` (disabled
  rows dropped, provider `anthropic`, `supportsFast` always `false`); commands
  map to `skill` resources. Subagent types are omitted (no matching resource kind).
