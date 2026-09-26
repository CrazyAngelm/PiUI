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
`NativeApproval`: `{id,kind:'command'|'file-change'|'permission'|'input',title,description,decisions:ApprovalDecision[],inputLabel?,options?:Array<{id,label}>,form?:ApprovalForm}`. Internal native request maps stay adapter-owned; do not auto-approve. Validate supported decisions and exact origin. Superseded/resolved requests reject duplicate reply. `options` lists select-style choices with opaque adapter ids and bounded one-line labels; `respond({decision:'approve-once',text})` names one option id (an exact label is also accepted), the adapter maps it back to the exact native value, and any other value is rejected while the request stays pending.
`ApprovalForm` (a native form request, today a Codex MCP elicitation): `{server:string,fields:ApprovalField[],limitation?:'optional-fields-omitted'|'input-unsupported'}` where `ApprovalField` is one of `{type:'text',id,label,description?,required,default?,minLength?,maxLength?,format?:'email'|'uri'|'date'|'date-time'}`, `{type:'number',id,label,description?,required,integer,default?,minimum?,maximum?}`, `{type:'boolean',id,label,description?,required,default?}` or `{type:'choice',id,label,description?,required,default?:optionId,options:Array<{id,label}>}`. Field and option ids are opaque adapter ids; native property names, schemas and choice values never leave the adapter. `approve-once` carries `text` = a JSON object of field id -> value (string, finite number, boolean or option id); the adapter validates every value (required, length, format, bounds, integer, known option) and maps it back, and any other answer is rejected with `invalid-response` while the request stays pending. With `limitation:'input-unsupported'` there are no fields and only deny/cancel.
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

### Composer inputs: images, native commands and skills

- `composerCapabilities()` adds `images:boolean`: the harness protocol and the
  *current* model accept image input. Absent means `false` (older adapters).
- `prompt({text,mode,images?})`: `images` is at most 6 `{mimeType,data}` with
  `mimeType` one of `image/png|image/jpeg|image/gif|image/webp` and base64
  `data` the host sniffed and bounded (5,000,000 bytes each). Malformed images
  reject with `invalid-request`; images the harness or model cannot take reject
  the whole prompt with `unsupported-input` before anything is written, so an
  image is never dropped silently. The host re-checks `images` before it sends
  a queued message (the model may have changed) and keeps the message queued.
- User blocks list every image a message carried as one `[image]` line after
  its text (live prompts, echoes and resumed history alike). Image bytes, data
  URLs and local paths never reach a block, event or log.
- `composerCatalog()` returns `{commands:[{name,description?,hint?,source}],
  skills:[{name,description?,mention}]}`. `commands` are slash commands the
  harness runs itself when a prompt starts with `/<name>`; `source` is
  `command|extension|prompt|skill`. `skills` are mentions the harness resolves
  from its own syntax (`mention` is the exact text). No native path, location
  or id is included; the host bounds, sanitizes and drops ambiguous names.
  An adapter without discovery returns empty lists. PiUI never executes them.
- Per harness:
  - Pi: `images` from `get_state` `model.input` (`image`); RPC `prompt`,
    `steer` and `follow_up` carry `images:[{type:"image",data,mimeType}]`.
    Commands from `get_commands` (`extension`, `prompt`, `skill` — skills are
    `/skill:<name>`); `skills` is empty.
  - Claude Code: `images:true`; the user message content is
    `[{type:"text"},{type:"image",source:{type:"base64",media_type,data}}…]`.
    Commands from the `initialize` `commands` (name, description,
    `argumentHint`) and `commands_changed`; Claude has no `$` syntax.
  - Codex: `images` from `model/list` `inputModalities` of the current model;
    `turn/start` and `turn/steer` input adds `{type:"image",url:"data:<mime>;base64,<data>"}`.
    No slash-command catalog (the TUI expands custom prompts itself). Skills
    from `skills/list` (enabled) with `mention:"$<name>"`; a prompt that
    mentions `$<name>` of exactly one enabled skill also gets the documented
    `{type:"skill",name,path}` input item.
  - Hermes (ACP): `images` from `initialize` `agentCapabilities.promptCapabilities.image`;
    `session/prompt` adds `{type:"image",mimeType,data}` blocks (queued
    follow-ups keep theirs). Commands from `available_commands_update`
    (`input.hint` → `hint`). A generic ACP adapter follows the same mapping.
  - Prime: `images:false` (the SDK connection takes text), empty catalog.


## Codex (`codex.mjs`, harness `codex`)

Drives the user's installed `@openai/codex` (`node bin/codex.js app-server --stdio
-c analytics.enabled=false --disable apps --disable plugins --disable remote_plugin
--disable recommended_plugins --disable shell_snapshot`, plus `--disable multi_agent
--disable multi_agent_v2` for managed runs and `nativeSubagents:false`) with the
inherited `CODEX_HOME`. Frames are LF JSON without a `jsonrpc` member; `initialize`
negotiates `experimentalApi:true, requestAttestation:false`.

### Verified version range

- One range, `minimum <= version < ceiling`, currently `0.147.0 <= v < 0.158.0`:
  `CODEX_APP_SERVER` in `crates/piui-runtime/src/native_version.rs`, mirrored by
  `VERIFIED_CODEX_VERSIONS` in `codex.mjs`; the Rust test
  `bridge_mirrors_the_codex_range` keeps the two equal.
- Grammar: `MAJOR.MINOR.PATCH[-pre][+build]` (leading `v` tolerated). A pre-release
  precedes its release (`0.147.0-alpha.1` is older than the minimum); a
  pre-release at or above the ceiling previews an untested line
  (`0.158.0-alpha.2` is newer than tested). Anything else is unrecognized.
- Host discovery reads `@openai/codex/package.json` and reports the found
  `version`. Inside the range it is `available` (on verified platforms); above it
  `unverified` with "Unverified: newer than the versions tested with PiUI.";
  below it "Older than the oldest version supported by PiUI."; unparseable
  "The installed version could not be recognized.". Launch refuses every
  version outside the range (`HarnessUnavailable`); nothing newer is accepted
  silently.
- The bridge checks the running app-server itself: the first token of the
  `initialize` `userAgent` (`<originator>/<version> (<os>; <arch>) <terminal>
  (<client name>; <client version>)`, originator = our `clientInfo.name`) must be
  in range, else `unsupported-native-version` before `initialized`. The trailing
  client version is never read.
- Why 0.158.0: 0.147.0, 0.153.4 and 0.157.1 were audited (table below). Patch
  releases do not change the protocol: `codex-rs/app-server` and
  `codex-rs/app-server-protocol` are identical at 0.157.0 and 0.157.1 (and at
  0.156.0 and 0.156.1), so the ceiling admits the 0.157.x line and nothing after
  it. On 2026-09-26 0.158.0 and 0.159.0 exist only as unaudited alphas.
- Raising the ceiling: generate the new version's bindings
  (`codex app-server generate-ts --experimental --out <dir>` and
  `codex app-server generate-json-schema --experimental --out <schema-dir>`),
  re-check every row below, run
  `node apps/desktop/scripts/codex-protocol-audit.mjs <schema-dir>` (every frame
  the bridge sends in the fixture flows must validate, with no undeclared
  fields), check that `codex features list` still registers each `--disable`
  flag (an unknown name is a hard CLI error), extend the fixture
  (`--codex-version=`) and tests for any change, run the live handshake
  (`PIUI_CODEX_LIVE_HANDSHAKE=<abs path to bin/codex.js> node --test
  --test-name-pattern live: crates/piui-runtime/bridge/codex.test.mjs`; it
  forwards only `initialize`), then raise both constants.

### Protocol compatibility (0.147.0 / 0.153.4 / 0.157.1)

Evidence: 0.157.1 from bindings generated by the installed CLI (every frame the
bridge sends in the fixture suite validates against its JSON Schema with no
unknown fields) and a real initialize-only handshake; 0.147.0 and 0.153.4 from
the protocol source at tags `rust-v0.147.0` and `rust-v0.153.4` plus the
`--codex-version` fixtures (their binaries were not rerun for this audit). The
notification set grew 72 → 83 → 85 with nothing removed; the server-request set
is identical.

| Surface the bridge uses | Changes 0.147.0 → 0.153.4 → 0.157.1 | Bridge |
|---|---|---|
| `initialize` / `initialized`, `userAgent` | Unchanged for every field the bridge sends or reads | Version gate above |
| `--disable` feature flags | All seven registered with the same stage/default at every version | Unchanged |
| `thread/start` (`model`, `modelProvider`, `serviceTier`, `cwd` omitted, `baseInstructions`, `developerInstructions`, `config`, `permissions`, `approvalPolicy`, `ephemeral`, `dynamicTools`) | Additive only (`projectId`; `daybreakEnabled`; `personality` deprecated) | Unchanged |
| `thread/resume` (`excludeTurns`, `initialTurnsPage{sortDirection,itemsView}`) | `excludeTurns` stable from 0.153.4; still no `dynamicTools` | Unchanged; managed resume stays `unsupported-coordinator-resume` |
| Thread responses (`thread`, `model`, `modelProvider`, `serviceTier`, `cwd`, `sandbox`, `activePermissionProfile.id` `:read-only`/`:workspace`/`:danger-full-access`, `approvalPolicy`, `reasoningEffort`, `initialTurnsPage`) | Additive (`disabledPluginIds`, resume `collaborationMode`) | Unchanged; still verifies cwd and effective permissions |
| `turn/start` (`input` text with snake_case `text_elements`, `model`, `serviceTier`, `effort`, `sandboxPolicy`), `turn/steer{expectedTurnId}`, `turn/interrupt`, `thread/compact/start`, `thread/name/set`, `thread/unsubscribe`, `thread/settings/update` | Additive only (`turnTrigger`, `toolOutput`, `serviceTierForTurn`; `disabledPluginIds`) | Unchanged |
| `model/list{cursor,includeHidden}`, `skills/list`, `config/read`, `mcpServerStatus/list` | Params unchanged; additive response fields only (`Model.multiAgentVersion`; `Model.availableAccessPrograms`, …) | Unchanged |
| `thread/settings/updated` | `{threadId, threadSettings{model, modelProvider, serviceTier, effort, …}}` at every version | **Fixed**: the bridge read flat fields and `reasoningEffort`, so settings changed outside `setModel` were ignored on every version |
| Turn/item stream (`turn/*`, `item/*`, deltas, `turn/diff\|plan/updated`, `thread/tokenUsage/updated`, `thread/status/changed`, `serverRequest/resolved`, `error`) | Unchanged | Unchanged |
| `configWarning`, `deprecationNotice` | Present at every version; 0.157.1 sends startup `configWarning`s right after `initialize` (the real handshake emitted one for an unrecognized key in the user's config) | **Fixed**: fixed `resources().warnings` text instead of an "Unsupported Codex event" block; native text and paths dropped |
| `account/gatewayOAuth/changed` | New in 0.157.1 (gateway sign-in state, no thread) | Ignored as control plane, like `account/rateLimits/updated` |
| `thread/attachment/updated` | New in 0.157.1, only after client attachment calls | Never triggered (generic fallback) |
| `remoteControl/status/changed` | 0.157.1 sends it right after `initialize` | Ignored (unchanged) |
| `mcpServer/startupStatus/updated` | `{threadId\|null, name, status: starting\|ready\|failed\|cancelled, …}` at every version | **Fixed**: `cancelled` clears a failure; deferred until the thread is known |
| `item/commandExecution/requestApproval` | 0.153.4 adds `kind: command\|writeStdin`; `writeStdin` needs the off-by-default `write_stdin_approval` feature (0.157.1: `command` is the shell-joined `write_stdin --session-id <id> <input>`, decisions accept/cancel) | **Added**: `writeStdin` is titled "Send input to a running command" with a "Terminal input:" line; decisions unchanged |
| File-change, permissions, user-input approvals, `item/tool/call` | Unchanged | Unchanged |
| `currentTime/read` | Present at every version; 0.157.1 sends it only when the user config selects `features.current_time_reminder.clock_source = "external"` and treats an error reply as a fatal native error | **Fixed**: answered with `{currentTimeAt}` (Unix seconds) instead of `-32601` |
| `mcpServer/elicitation/request` | Present at every version; MCP tool-call approvals use it (`mode:"form"`, `_meta.codex_approval_kind:"mcp_tool_call"`, `tool_call_mcp_elicitation` on by default); 0.157.1 modes `form`, `url`, `openai/userVerification`, `openai/form`, `openaiForm`; reply `{action:"accept"\|"decline"\|"cancel",content}` | **Added**: form requests become approvals with typed fields (below); every other shape is declined at once. All 11 reply frames of the audit flows validate against the 0.157.1 schema |
| `attestation/generate` | Sent only when `requestAttestation` is true | Never negotiated; rejected if received |
| `ThreadItem` types | 0.153.4 adds `functionCallOutput`, `agentMessage.delivery/questions`; 0.157.1 adds `mcpToolCall.mcpAppUi` | Projections unchanged; unprojected types use the generic fallback |
| `CodexErrorInfo` | 0.153.4 adds `rateLimitExceeded`, `misalignmentPolicyViolation` | **Fixed**: mapped to the usage-limit and provider-policy summaries |
| Not used | `thread/rollback` removed in 0.157.1; `turn/settings/update` added in 0.153.4; `item/fileChange/outputDelta` and `thread/compacted` are never emitted | — |

### MCP elicitations (`mcpServer/elicitation/request`)

Codex forwards an MCP server's `elicitation/create` and asks MCP tool-call
approvals through the same request. Shape (0.157.1 bindings from
`generate-json-schema`/`generate-ts`): `{threadId, turnId|null, serverName,
mode, message, requestedSchema, _meta}`; a request without `mode` (MCP before
2025-11-25) is treated as a form.

- Form requests (`mode:"form"`) become an approval with `form`. Primitive
  properties become fields: `string` (with `minLength`, `maxLength`, `format`
  email/uri/date/date-time), `number`/`integer` (`minimum`, `maximum`),
  `boolean` and single-select `choice` (`enum`, `enum`+`enumNames` or `oneOf`
  of `{const,title}`), at most 24 fields and 100 choices, with bounded one-line
  labels. Arrays, objects, unknown formats and other shapes are not shown: an
  optional one is left empty (`limitation:"optional-fields-omitted"`), a
  required one allows only deny/cancel (`limitation:"input-unsupported"`).
  Accept never sends content that violates the requested schema.
- `_meta.codex_approval_kind:"mcp_tool_call"` is an MCP tool approval: title
  "Allow an MCP tool", kind `permission`, the message plus `tool_title` and a
  compact argument summary of `tool_params` (nested values are `{…}`).
  Read-only and workspace-write sessions offer only deny/cancel. `persist`
  (always/session scopes) is never offered: accept is for this call only.
- Decisions map exactly: approve-once -> `{action:"accept",content}` (the
  validated values under their native names, `{}` without fields), deny ->
  `{action:"decline",content:null}`, cancel -> `{action:"cancel",content:null}`.
- Declined at once with a fixed `error` event, never left waiting: `url` mode
  (PiUI does not open pages), `openai/userVerification`, `openai/form` and
  `openaiForm` (never negotiated), any other `codex_approval_kind`, and
  malformed params or schemas. A descendant thread's request is answered
  `cancel` like its approvals.
- Interrupt answers every pending elicitation `cancel` before `turn/interrupt`;
  `turn/completed` dismisses the elicitations correlated with that turn;
  `serverRequest/resolved` and dispose clear the card. Managed runs follow the
  same path (the request reaches the Inbox like any native approval); nothing
  is accepted automatically.


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
  stderr is discarded. The refusal comes before any user message is written,
  so a managed pipeline step refused this way fails with the task code
  `harness-sign-in-required` instead of an uncertain outcome. The host's cached
  verdict (the catalog `reason`) is shown in the UI but never blocks a start:
  every start and every "Check again" (a catalog-only `initialize`) verifies
  the login anew.
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
  before spawning. An `llm` pipeline step (orchestration v6.2) passes an empty
  allowlist, so it runs as `--tools "" --strict-mcp-config` in `plan` mode: no
  built-in tool and no MCP server can run.
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
  results of parallel tool calls, which Claude Code hangs off each call beside
  the branch, are matched by call id; meta, sidechain and internal entries
  skipped; newest 2000 blocks within 8 MiB). A missing transcript fails with
  `invalid-session`; a new conversation is never substituted. `rename` is PiUI
  metadata only. Closed sessions use the host's own read-only projection
  (`WorkspaceHistoryFormat::ClaudeCode`) with the same branch rules.
- Catalog: models map `value`/`displayName`/`supportedEffortLevels` (disabled
  rows dropped, provider `anthropic`, `supportsFast` always `false`); commands
  map to `skill` resources. Subagent types are omitted (no matching resource kind).
