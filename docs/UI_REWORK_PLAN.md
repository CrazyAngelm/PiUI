# PiUI usability corrections

The user's latest instruction is to finish the following stages sequentially.
Keep native history intact, preserve harness-specific behavior, and commit the
verified result. Install the final application. Hermes is the last stage.

1. [x] Automatic chat restoration after restart and selection. No Continue gate.
   Preserve errors and history; never replace missing native history with an
   invented empty conversation. Prove same-ID reload/resume and safe-mode behavior.
2. [x] Native settings catalogs: model/provider identity, exact reasoning levels,
   skills, MCP, tools. No manual identifiers for new selections. Unsupported
   controls are explicit; imported unknown settings are not silently discarded.
3. [x] Unified graph inspector: remove separate Advanced settings screen, retain
   instructions, base prompt, permissions, delegation and resources inline.
   Enlarge/expand task editing; resize navigation and both inspectors; remember widths.
   Add a separate Input contract, preserve it in versioned files and native run
   snapshots, and inform upstream result/message senders of recipient requirements.
4. [x] Navigation: project icons and clear selection; Library instead of Advanced;
   meaningful library screens; remove selectable Choose harness placeholders.
5. [x] Write and link shared UI style rules. Apply dark charcoal/burgundy tokens,
   consistent controls, spacing, typography and native dropdown contrast across
   chat, graph, navigation and library editors.
6. [x] Verify native WebView, keyboard, errors, safe mode, reload, graph saves,
   native catalogs and adapter tests. Commit this verified stage. Install the final
   release after Hermes verification, retaining the GUI subsystem.
7. [ ] Discover the user's installed Hermes Agent, inspect native integration
   contracts, implement a separate adapter with truthful capabilities, then verify
   ordinary chats and cross-harness graph execution. No custom inference/tool loop.

Current evidence for the reported old Codex chat: its recorded rollout file is
absent from active and archived native session directories; read-only app-server
thread/read returned `thread not loaded`. This is distinct from the unwanted
Continue gate and must not be hidden by creating a substitute chat.

Stage 1 verified in native WebView: target/piui-evidence/4316-1788720880732/report.json (same-ID automatic restore, no Continue gate, safe-mode no start).

Stage 2 verified in target/piui-evidence/31376-1788722283306/report.json:
Codex/Pi/Prime native catalogs, no provider credentials in the fixture, no
catalog warnings, automatic restore and safe-mode rejection. A separate real
Prime catalog-only SDK probe returned 110 models and 38 resources in 3.37s;
its isolated Job closed with zero active children. No paid inference was used.

Stages 3–6 verified in target/piui-evidence/3144-1788744986945/report.json:
full native WebView CRUD/reload, mixed Codex/Prime graph, exact Codex model and
reasoning/Fast controls, denied policy with no native launch, chat deletion and
automatic resume, themes, Russian, keyboard, safe mode and empty owned Job.
Input/When to call/Expected result and keyboard resizing additionally passed
in target/piui-evidence/24368-1788723620657/report.json. Catalog v14 now returns
per-model Fast capability; unsupported choices stay disabled.

Hermes discovery: installed 0.21.0; `hermes acp --check` passes. The installed
ACP implementation persists sessions in native state.db and supports load.
Implementation and final installation remain pending.
