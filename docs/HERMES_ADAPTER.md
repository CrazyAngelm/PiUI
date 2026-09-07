# Hermes adapter

Hermes 0.21.0 is connected through its native Python ACP implementation. PiUI
contains no Hermes inference loop and does not rewrite global configuration.
The adapter discovers the installed package and venv, verifies ACP protocol 1
and version 0.21.0, and contains its process tree in the host-owned Job.

The portable contract is system-file v3 (v1/v2 import retained); workspace v15,
settings v16, lifecycle v17, catalog v18 and orchestration v5 add the harness
identity without altering the previous contract documents.

The native ACP new-session request has no model parameter. A process-local SDK
shim supplies the explicitly selected model/provider to SessionManager before
native construction. Native no-probe inventory builds the model picker. It does
not change the selected global model, copy credentials, or implement a provider.
New-chat model selection is available before starting the native session.

History remains HERMES_HOME/state.db. Opening validates native session/list and
project identity before session/load; resume_session is deliberately not used
because its missing-ID behavior creates a new conversation. Read-only SQLite
projection selects active messages by registered native ID and verifies the
project from native metadata. Exact assistant SHA-256 references use the common
dependency resolver. Imported graph data never supplies a native history path.

Native ACP handles approvals and cancellation. A session-scoped localhost MCP
endpoint exposes the existing typed workspace coordinator through a random bearer
token. Actor identity remains host-owned and frozen-run permissions still apply.
Resource inventories are read-only: this ACP version does not expose verified
per-session skills/MCP/tool restrictions, reasoning/Fast, native-subagent disabling
or base prompt replacement. Required unsupported settings fail before execution.
Rename is PiUI title metadata, since this ACP has no native rename operation.

Hermes permits 30 seconds for late MCP discovery. The Hermes startup allowance
adds that native phase to the existing 20-second bridge request watchdog. Other
adapter deadlines are unchanged. First paint never waits for this initialization.

Installed-source references: acp_adapter/session.py, server.py, model_catalog.py,
hermes_cli/inventory.py and hermes_state_common.py. Source compatibility is pinned
to the verified version, not guessed for a future Hermes release.

## Verification

The installed native Hermes returned PIUI_NATIVE_RUNTIME_OK via its configured
openai-codex:gpt-5.4-mini provider and restored the same session with that response.
A second real turn called the workspace MCP roster through the host and completed
successfully. Native provider failures were observed separately (Nous credits,
local-proxy request failure); the process-local shim maps Hermes result.failed /
result.error or an exception to failed completion metadata, never by inspecting
assistant prose. Native ACP otherwise returns end_turn even for these failures.

Synthetic ACP tests cover approvals/cancel, native-history replay, missing/wrong
project rejection, generic fallback, transport framing and the coordinator route.
The SQLite fixture proves active-message selection, exact result hashing, project
binding and no database writes. WebView covers mixed graphs, saves/reload,
unsupported native policies, safe mode, theme, keyboard and chat lifecycle.
