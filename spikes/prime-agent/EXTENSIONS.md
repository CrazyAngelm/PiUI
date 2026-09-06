# Pi ↔ Prime Agent extension compatibility

**Compared:** `@earendil-works/pi-coding-agent@0.82.1` and `prime-agent@0.8.1`.

**Verdict:** partially source-compatible, not a shared or guaranteed extension ABI.

## Evidence

| Surface | Finding | Product rule |
|---|---|---|
| Global discovery | Pi and Prime resolve different agent roots. Prime documents `~/.prime/agent/extensions/`. | Show separate inventories. Never merge enablement state. |
| Project discovery | Prime documents `.prime/agent/extensions/`; Pi owns its own project resource discovery. | The selected runtime discovers project code only after project trust. PiUI does not scan or import it. |
| Import names | Prime's loader and virtual-module table alias both `@earendil-works/pi-coding-agent` and legacy `@mariozechner/pi-coding-agent` to Prime's bundled implementation. | A matching import can make a source file load. It does not certify all APIs used by that file. |
| Public extension API | The shared core includes tools, commands, events, message renderers, and UI methods. | Extensions limited to the exact shared subset may work in both runtimes when installed separately. |
| Pi-only surface in this comparison | Pi `0.82.1` includes `project_trust`, `session_info_changed`, `before_provider_headers`, `agent_settled`, `registerEntryRenderer`, `ctx.mode`, `ctx.thinkingLevel`, and `ctx.isProjectTrusted()`. | An extension using any of these is not compatible with Prime `0.8.1` without an extension-owned adapter. |
| Prime-only surface in this comparison | Prime `0.8.1` includes `session_before_refine` and `refine_complete` extension hooks. | A Prime extension using refinement hooks is not a portable Pi extension. |
| Renderers and TUI components | Both runtimes execute their own extension UI contracts. `ctx.hasUI` does not mean PiUI can host a TUI renderer. | PiUI keeps its generic transcript/tool fallback and never loads runtime extension JavaScript into the WebView. |
| Packages and settings | Both packages expose similarly shaped `SettingsManager` and `DefaultPackageManager` APIs, but each instance resolves and writes its own runtime configuration. | PiUI may call the selected installed runtime's manager through the typed host adapter. It never edits either settings file directly. |

The Prime static probe records the separate roots, Pi-named aliases, and Prime refinement hooks in `reports/latest.json`. The public-type comparison above is intentionally version-specific. A later Pi or Prime release must be compared again; a package name or import alias alone is never a compatibility claim.

## Implemented boundary

1. `list_extensions_v10(agentKind)` resolves one runtime package and returns only that runtime's bounded global inventory.
2. `set_extension_enabled_v10(agentKind, extensionId, enabled)` re-resolves the same inventory and accepts an opaque ID that is hashed with the runtime kind.
3. The legacy v9 extension commands remain Pi-only.
4. PiUI contribution manifests remain Pi-only. Prime sessions receive runtime-reported commands and otherwise use generic rendering.
5. Switching the Settings inventory invalidates late responses and clears the previous list.
6. A toggle succeeds only after the selected manager flushes its queued global write and reports no matching persistence errors.
7. No cross-runtime copy, install, enable, or execution path exists.

## Future portability

If portability is later required, the destination runtime must own a versioned adapter or conformance artifact for each resource class. PiUI can present that runtime-issued plan after trust, but it must not translate extension code or become a second extension harness.
