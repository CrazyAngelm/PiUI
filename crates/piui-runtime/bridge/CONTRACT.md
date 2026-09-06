# Internal native bridge contract (v1)

This is HOST-PRIVATE, not WebView IPC. Runtime-owned session paths/native ids are legal only here. Rust maps them to opaque workspace session IDs. No provider clients/model loop may be implemented in bridge code.

## Embedding and ownership
Rust embeds factory source bytes and common runner, concatenates them into one ESM source, and launches a fixed small `node --input-type=module -e <bootstrap>` inside a Windows Job assigned before resume or Unix process group. To avoid Windows' command-line limit, Rust writes an exact checked 4-byte little-endian source length followed by those trusted source bytes to stdin; the bootstrap reads exactly that prefix and imports it as an in-memory data module, leaving subsequent LF JSON untouched. No writable temp JavaScript files. Each adapter file exports ONLY its unique top-level function; put imports/constants/helpers inside the factory to avoid collisions in concatenation. Native children inherit containment. Script modules must not print to stdout except common runner protocol. Do not expose raw errors, environment, auth or raw native protocol to UI/logs.

Factories: `export async function createPrimeAdapter(config, emit)`, `createCodexAdapter`, `createPiAdapter`. Config: `{cwd: absolute trusted workspace, sessionDir: host-owned native storage directory, nativeId?: string, nativePath?: string, title?: string, model?: {id,provider?,name}, thinkingLevel?:string, instructions?:string, permissionMode:'native'|'read-only'|'workspace-write'|'full-access', allowedTools?:string[], nativeSubagents?:boolean, daemonSocket:explicit nondefault reserved endpoint}`. Runtime resolution is host-side/system install; no arbitrary executable/path from frontend. Prime must avoid default daemon. Do not silently accept unsupported mandatory instructions/tools/permissions.

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
`NativeApproval`: `{id,kind:'command'|'file-change'|'permission'|'input',title,description,decisions:ApprovalDecision[],inputLabel?}`. Internal native request maps stay adapter-owned; do not auto-approve. Validate supported decisions and exact origin. Superseded/resolved requests reject duplicate reply.
`HarnessCapabilities`: keys `prompt,resume,models,approvals,instructions,toolPolicy,nativeSubagents`; each `{supported:boolean,enforcement:'native'|'coordinator'|'advisory'|'unsupported',reason?:string}`. A supported boolean means tested implementation; no silent fallback for mandatory policy.

`emit(event)` events:
- `{type:'block',block:NativeBlock}` (insert/update full block by id)
- `{type:'textDelta',blockId,text}`
- `{type:'status',status}`
- `{type:'approval',approval:NativeApproval}`
- `{type:'approvalResolved',requestId}`
- `{type:'binding',nativeId,nativePath?}` (host-private only)
- `{type:'error',message:safeFixedSummary}`

Runner request LF JSON: `{id:string,method:'initialize'|'snapshot'|'prompt'|'interrupt'|'models'|'setModel'|'respond'|'rename'|'dispose',params:object}`. Initialize params add `harness:'pi'|'prime-agent'|'codex'` to config; exactly once. Return `{id,ok:true,result}` or `{id,ok:false,error:{code,message}}`; event `{event:NativeEvent}`. Buffer raw bytes, split only LF. Pending native operations must not serialize interruption/approval behind an active turn. EOF closes admission, calls dispose, then exits; Rust handles hung descendants. No generic evaluate/exec/file method.

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
