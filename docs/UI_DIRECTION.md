# PiUI visual direction — Obsidian + Carbon

Selected by the user on 2026-09-06: graph and shell from the first generated Obsidian concept; chat from the second Carbon concept.

## Contract

Make the existing desktop UI compact and coherent, with warm graphite surfaces and restrained crimson accents. Preserve agent settings, mixed-harness workflows, native sessions, safe mode, keyboard access and appearance preferences. Verify native graph/chat/settings screenshots, keyboard inspector access, narrow-window navigation and existing application flows.

## Implementation

- 13 CSS px base UI text; conversation size remains a separate user preference.
- 212 px desktop sidebar, 46 px workspace header, 260 px selected-node inspector. These are layout design choices, not runtime limits.
- 200 px graph nodes; output ports and connection geometry share their dimensions. Dot-grid canvas, restrained connectors and crimson selection.
- Advanced navigation is a compact disclosure. No new decorative or unsupported product controls.
- Chat uses neutral user-message surfaces, less empty vertical space, and a quiet composer.
- Dark palette: graphite #131214, raised #19171a, action #9e354e; readable accent text #e49aab; text #eee9ed. Light mode retains its contrast and uses a wine accent.
- No raster image assets are loaded by the application. Generated concepts are inspiration, not assertions about native tools/models. Their invented capability names are not implemented.
- Local system fonts keep Cyrillic coverage and avoid network/font loading on startup. No dependencies, harness behavior or IPC changed.

## Concept prompts (built-in image generation)

### Obsidian

Use case: ui-mockup. Generate a high fidelity desktop application concept for PiUI, a real native Windows/Svelte app to chat with coding agents and build multi-agent systems. Landscape 16:10, straight-on crisp actual interface, no monitor mockup, no marketing website. Concept: OBSIDIAN / restrained Shadow the Hedgehog inspired black and deep crimson visual language, no character illustrations. Sophisticated productivity software as compact and usable as Codex desktop or Linear. Warm near-black #111012 canvas, graphite #191719 sidebar, oxblood selected surfaces #321c22, dusty crimson #bc4359 small accents, warm white text, muted gray text. NO glowing neon, decorative sci-fi HUD, gamer bevels, huge fonts, oversized cards, gradients, ornaments. Compact 13px UI at logical 1440x900, 32px controls, 210px sidebar, 44px topbar, 270px inspector. App sidebar PiUI logo, small New chat action, Chats and Systems navigation, Projects with PIUI selected, recent chat names 'Improve runtime', 'Review changes', bottom Settings. Main header breadcrumb 'PIUI / Release review', tiny Design and Runs tabs, one restrained red Run action. Main canvas ample room with subtle sparse dot grid, small connected rectangular agent nodes: 'Planner' Codex -> 'Developer' Codex and 'Reviewer' Prime Agent -> 'Summary' Codex. Small nodes with clear input/output handles, subdued orthogonal connections, selected node thin crimson outline. Compact inspector for Reviewer at right, with agent name, Harness Prime Agent, Model, Reasoning High, Instructions collapsed, Tools / Skills toggles, Permissions Native; capability-based actual features, no fake performance metrics. Bottom of canvas tiny toolbar zoom/arrange and subtle edge legend Results / Messages / Delegation. Design has breathing room where work happens while navigation is dense. Display real legible English UI labels. Make it polished and implementable; no descriptive annotations outside the app.

### Carbon

Use case: ui-mockup. High fidelity straight-on desktop screenshot design proposal for PiUI, native agent workspace. Create a DISTINCT alternate visual direction called Carbon: ultra restrained warm charcoal, muted silver text and very small deep wine-red selection accents, more editorial and calm than gamer themed. The user likes compact Codex desktop UI and Shadow/Sonic black/red mood, but wants an elegant daily productivity app, not a themed game launcher. Full desktop viewport landscape 16:10 with crisp readable interface, no outside labels, no physical monitor. Actual software layout: narrow 200px sidebar with PiUI wordmark, subtle small 'New chat' text plus icon, 'Chats' and 'Systems', project PIUI, recent conversations 'Runtime architecture', 'Review agent graph', Settings at bottom. Thin main toolbar with 'Runtime architecture', tiny harness 'Codex' and context panel toggle. Center spacious readable chat transcript with small 14px text at conceptual 1440x900: user 'Review how these agents share results.' Assistant response 'The planner defines the work. Codex implements the changes, and Prime reviews the result.' Below one collapsed tool row 'Read 4 files', then assistant 'Permissions are checked before each agent starts. Children inherit the same or narrower access.' Tiny inline file references. Bottom floating COMPACT composer spanning chat width, modest corner radius, text 'Ask or describe a task…', lower row attachment icon, Codex, High, Standard, discreet crimson send arrow. Right 260px contextual panel with 'Session', 'Codex', model selection and Reasoning High / Speed Standard in compact rows; a small integrated preview of a three-node agent result chain titled 'Linked system' with Planner -> Developer -> Reviewer, and 'Open system' action; bottom collapsed Resources, Changes. No giant cards, huge headings, oversized buttons, decorative colored glow, invented performance stats, gradients, thick strokes, nested borders or repeated helper text. Thin separators, selectively highlighted surfaces, excellent contrast and focused quiet hierarchy. More space for content than chrome; polished software UI not landing page. Palette #151416, #1b1a1d, #242226, warm white #ece8e8, muted #a29ca4, muted wine accent #a63f52.



## Verification

- `pnpm check`: no errors or warnings. `pnpm test`: 156 passing tests.
- Palette tests verify WCAG AA text/control contrast for dark, light and system-light palettes; filled action text has its own contrast pair.
- Native workspace E2E passed: `target/piui-evidence/22600-1788707523614/report.json`. Graph persistence, inspector close/focus restoration/reopen, Russian settings, narrow drawer, safe mode, native session lifecycle and rejected policy are exercised. The harness uses synthetic keyboard events, so native button activation is checked through focusable button semantics and click, not falsely described as OS-level key injection.
- Existing classic/native generic fallback E2E passed: `target/piui-evidence/10324-1788707468142/report.json`.
- Native screenshots were inspected for graph, chat surface and Russian settings. The chat screenshot uses an empty native test session; transcript rendering is covered by existing timeline/generic-fallback tests, not a live model conversation in this UI run.
- Workspace dev shell observed in 297 ms (single harness sample, not a production startup guarantee); owned-process memory snapshots include WebView and Codex and must not be called PiUI-only RSS.
- Frontend asset smoke: 209,247 initial bytes in the final frontend build. No images, font downloads or libraries were added to first paint.
- Generated inspiration files remain local, ignored artifacts: `target/design-concepts/obsidian.png` and `target/design-concepts/carbon.png`. The exact prompts above are the reproducible design brief.
