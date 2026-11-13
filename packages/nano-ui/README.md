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
