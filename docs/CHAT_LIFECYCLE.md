# Chat lifecycle

Closing a native process does not end the conversation. A restored ordinary
chat exposes **Continue chat**, which uses the existing trusted `openSession`
route and the persisted native resume binding. Reading history at startup
remains process-free. Managed graph runs retain their coordinator-owned lifecycle.

**Session details → Delete chat** opens a keyboard-accessible confirmation.
Deletion removes the PiUI catalog entry and local UI draft; harness-owned history
is retained, as the confirmation states. The additive `workspace_lifecycle_v13`
route accepts only an opaque session ID. It rejects safe mode, managed run
sessions and busy runtimes. It closes an idle runtime before atomically removing
the registry entry. A failed registry write leaves the entry available. Late
runtime events cannot reinsert a successfully deleted entry in the current UI.
The v11 commands and native history formats are unchanged.

Windows release builds use the GUI subsystem so launching the desktop app does
not create a console. Debug builds retain their console for development.

Verification: lifecycle client response/error tests, registry reload/failure
tests, and native WebView reload → continue the same session → close → cancel
deletion → delete → reload, including keyboard focus and safe-mode rejection.
