# Shared Nano graph surface

Build with `pnpm --filter @piui/nano-ui build` from this repository. The output
is a versioned browser ES module, stylesheet, the exact portable v5 schema and
a provenance manifest. The consumer copies the entire `dist/` as one artifact;
it never imports a developer's adjacent checkout at runtime. Verify the
manifest's artifact SHA-256 values before installing the bundle.
Source fingerprints use UTF-8 text with LF line endings, matching Git objects
on both Windows and Linux. Artifact hashes cover their exact published bytes.

The graph uses Desktop's actual canvas, node renderers, connection rules,
undo history, layout and v1–v5 portable parser. Its controller only owns an
editable draft. No native transport, Lab transport, provider, credential,
session/history conversion or execution API belongs to this package.

Hosts may observe `onDraftState` and read `getDraftState()` immediately before
executing a saved revision. Identity, revision and dirtiness are presentation
data, never execution authority. Hosts must feature-detect `getDraftState` and
`setCreationProfile` when an older bundle may be cached; absent methods leave
editing available and execution disabled. An optional `creationProfile` (or a
later `setCreationProfile`) comes from the host's current capabilities and model
entitlements. It applies only to newly created nodes. Imported profiles remain
intact; changing their target to Nano Cloud discloses the native settings that
will be replaced and requires an explicit confirmation. Setting the capability
to null removes the cloud choice without rewriting any saved or open graph.

Load `nano-graph.css` from the host's fixed static path, import
`mountGraphEditor` from `nano-graph.js`, and pass an empty DOM element plus
`GraphEditorOptions` from `contracts/graph-drafts-v1.ts`. The host provides
authenticated list/load/save operations fixed to the current workspace and
profile. The host remains responsible for cancelling navigation with unsaved
changes and disposing the island when identity or workspace changes. Dispose
prevents an outstanding response from changing a detached draft.

CSS is scoped to `.nano-graph-root`; popup portals stay inside this root.
Appearance is a root attribute and never changes Blazor's document or theme.
Each mount owns its translation context. English and Russian editors can
coexist without changing one another, document language or desktop preferences.

Saving writes the entire portable document with a compare-and-swap revision.
Import creates a fresh unsaved identity. Unknown fields and invalid documents
are refused before replacing the draft. A conflict preserves local changes;
the person can explicitly reload or keep them under a new identity. Native
harness configuration is portable data here, not a claim of cloud capability.

Unapplied JSON owns editing until Apply or Discard; graph mutations are refused
by the controller during that interval. Focused field edits count as unsaved
immediately. An unconfirmed create can reload its current ID even before its
first revision is known. Render IDs never reserve portable agent identifiers.

`pnpm --filter @piui/nano-ui test:integration` builds and serves the published
module bytes through a static server, without Vite transforms or a Node global
shim. The persistent browser verifies concurrent locales, keyboard editing,
conflicts, uncertain saves, invalid import and host/CSS/portal isolation.

## Remote shell

`pnpm --filter @piui/nano-ui build:remote` builds the desktop workbench
(`apps/desktop/src/app/shell/AppShell.svelte`) as a page for Nano Web: the
person's browser shows the shell of a computer running Nano Desktop. The same
Svelte code is compiled; only `host-api/transport.ts` is replaced at build time
by `src/remote/transport.ts`, which sends the allowlisted host commands and
receives the allowlisted events over the nano-remote v1 WebSocket
(`contracts/nano-remote-v1.ts`, ADR-062). The build fails if Tauri APIs, the UI
Lab host or the original transport reach the bundle.

The bundle holds no token. The host page supplies one thing, in the URL
fragment of a same-origin iframe: `#device=<device id>&lang=ru|en&theme=light|dark|system`.
The page connects to `/api/hermes/remote/devices/<id>/socket` on its own
origin with the browser's session cookie and talks to nothing else (the page's
CSP allows only `'self'`). The browser keeps a non-extractable ECDSA P-256 key
(WebCrypto in IndexedDB), proves it on every connection and shows a six-digit
pairing code that the desktop shows too. The shell mounts only when the
desktop's contract numbers equal the ones compiled in.

Install the bundle as one artifact: copy the whole `dist-remote/` directory to
`NanoAgentProject.HermesWebApp/wwwroot/vendor/nano-remote/` (replace the
directory, never merge it) and check the hashes in `remote-manifest.json`
against the files. The Blazor "Devices" page reads that manifest to build the
iframe address and refuses a bundle whose manifest is missing or wrong.

- `pnpm --filter @piui/nano-ui test:remote:unit` runs the connection,
  transport, pairing-code and key tests in Node.
- `pnpm --filter @piui/nano-ui test:remote` builds the bundle and runs the
  browser test with the persistent test profile. Its relay and desktop are
  scripted in `tests/remote-harness.ts` (the desktop is answered by the UI Lab
  host), so its evidence is synthetic, not a real server, desktop or provider.
