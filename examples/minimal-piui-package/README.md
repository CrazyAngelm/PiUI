# Minimal dual Pi/PiUI package

This example demonstrates the required separation:

- `pi/extension.ts` registers a backend command through Pi and works without PiUI;
- `piui.manifest.json` describes GUI contributions as data;
- `piui/worker.js` returns only declarative `UiNode` and uses a capability-limited host API.

A production package must:

1. pin compatible dependency versions and engines;
2. add tests for the backend command and render handlers;
3. not use package `private: true` when publishing;
4. validate the manifest with the SDK/JSON Schema command;
5. request only permissions that are actually necessary;
6. provide a generic fallback — PiUI will already display the custom entry without this renderer.

The manifest intentionally contains no rich view or trusted shell. Add them only when declarative nodes are insufficient.
