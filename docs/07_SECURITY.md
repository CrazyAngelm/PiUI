# 07. Security and Trust Model

## 1. Core honest statement

Pi and its backend extensions run with the local user's permissions. Project trust controls which project-local resources are loaded, but **does not turn Pi into a sandbox**. PiUI must communicate this before the first agent launch in a new project.

PiUI reduces UI and accidental-action risk, but cannot promise isolation from a malicious Pi tool/extension without a separate OS/container sandbox architecture.

## 2. Assets to protect

- source code and the user's other files;
- Pi sessions and branch history;
- provider credentials, OAuth tokens, and API keys;
- environment variables;
- clipboard;
- external files selected by the user;
- extension permission grants;
- update channel and installed binaries;
- UI integrity: permission/trust prompts and safe mode;
- privacy of prompts/tool output/logs;
- application availability and absence of orphan processes.

## 3. Trust boundaries

```text
[Untrusted content: Markdown/tool output/project files]
                  |
                  v
[Svelte renderer + sanitizer] --typed IPC--> [Trusted Rust host]
                  ^                               |
                  |                               v
[Sandboxed PiUI views/workers]                [Pi process]
                                                  |
                                       [Tools/backend extensions]
                                                  |
                                      [Filesystem/network/providers]
```

Separate trust decisions:

1. trust the project to launch Pi/project-local resources;
2. enable a backend Pi extension;
3. enable PiUI declarative contributions;
4. grant a rich view/worker permission;
5. select a global shell replacement;
6. open an external link/file;
7. provide a secret/clipboard/network access.

A single trust checkbox does not replace all levels.

## 4. Threat actors and scenarios

### Malicious project

A repository may contain project-local Pi extensions/skills/instructions that execute commands or persuade the model to take a dangerous action.

Mitigations:

- the project initially opens read-only/restricted;
- before trust, Pi is not launched in this cwd and project-local executable UI code is not loaded;
- the dialog lists resource categories that may become active;
- `Open restricted`, `Trust and start`, and `Cancel` are available;
- trust can be revoked;
- a change to canonical path/file identity may require a new decision.

### Malicious backend extension/tool

Backend code executes inside the Pi environment with user permissions.

PiUI mitigations are limited to:

- showing the extension source/location/version;
- not hiding tool execution;
- preserving a generic raw view;
- allowing the package to be disabled and safe mode to be opened;
- not automatically granting a backend extension additional PiUI permissions;
- not claiming that PiUI sandboxes this code.

A future container/OS sandbox is a separate project and ADR.

### Malicious PiUI rich view

A view may try to read the filesystem, call the host, steal the clipboard/token, or create phishing UI.

Mitigations:

- sandboxed isolated surface;
- no direct Tauri API;
- capability broker and host-side checks;
- network denied by default;
- visible extension identity in the frame/header/permission prompt;
- no unrestricted overlays above immutable host prompts;
- rate/payload/time limits;
- CSP and navigation blocking;
- kill/revoke/crash-loop handling.

### Prompt/tool output as active content

Markdown may contain HTML, links, SVG/data payloads, or terminal escapes.

Mitigations:

- raw HTML disabled or restricted to a sanitized allowlist;
- scripts, event attributes, iframes, forms, and style injection prohibited;
- links opened through host policy;
- `file:` and custom schemes require validation;
- ANSI escape sequences are not passed to a terminal emulator; the text renderer sanitizes controls;
- SVG is treated as active content: rasterize/sandbox it or block it inline;
- code blocks are text only;
- bidi/control characters may be visually marked in sensitive paths/code.

### Compromised update/package source

Mitigations:

- signed desktop updates;
- HTTPS alone is insufficient; verify signature/hash;
- managed Pi artifacts pinned in a signed PiUI release manifest, including upstream version, target, origin, and checksum;
- prefer an official standalone release artifact or a reproducible build from versioned release source; do not run runtime `npm install` from the application;
- generate SBOM/provenance and verify the upstream hash before packaging;
- atomic update + rollback;
- no installation during a running turn;
- no extension marketplace in 1.0;
- local package source and fingerprint visible;
- package manifest parsing does not execute scripts;
- shell selection requires explicit trust and restart.

## 5. Project trust UX

Recommended wording in substance:

> Pi and this project's extensions may read and modify files and run processes with your user permissions. This is not a sandbox.

The dialog shows:

- canonical project path;
- discovered project-local Pi resources/packages;
- selected Pi executable;
- `Open without starting`, `Trust and start`, and `Cancel` actions;
- a link to details;
- a “remember for this unchanged path/source” checkbox only with a sufficient identity model.

Do not use only the vague “This project may be unsafe.”

### Restricted mode

Restricted mode permits:

- viewing indexed history;
- viewing the project path and session metadata;
- exporting an existing session;
- changing global PiUI settings.

Prohibited:

- launching Pi in the project cwd;
- loading project-local backend/UI code;
- reading arbitrary project files through the extension API;
- sending a prompt that will launch tools in the project.

## 6. Tauri/WebView boundary

The frontend receives only narrow allowlisted commands. Requirements:

- Tauri capability files are minimal and separated by window/surface;
- extension views do not inherit core window capabilities;
- CSP prohibits remote scripts and `unsafe-eval` in production;
- devtools are disabled in production or available through an explicit diagnostic build;
- custom protocols validate origin and canonical path;
- deep links are treated as untrusted input;
- no generic `execute(command: string)` IPC;
- no generic `readFile(path: string)` for extension views;
- IPC DTO size/rate limits;
- every sensitive command checks current window/view identity.

The core frontend is also not considered fully trusted with the OS; validation is always repeated in Rust.

## 7. Path policy

The host accepts typed resource references:

```ts
type ResourceRef =
  | { scheme: 'project'; projectId: string; relativePath: string }
  | { scheme: 'picked'; handleId: string }
  | { scheme: 'attachment'; attachmentId: string }
  | { scheme: 'package'; extensionId: string; relativePath: string };
```

Rules:

- canonicalize before policy check;
- reject traversal after decoding, not only literal `..`;
- handle symlinks/junctions and TOCTOU where possible;
- project read/write stays within the canonical root unless an external handle is granted;
- package resources stay within the immutable/resolved package root;
- Windows reserved devices/alternate data streams tested;
- file size/type limits before reading into memory;
- writes use temp + atomic replace and a conflict token;
- an extension never receives an unrestricted absolute path unless the permission contract explicitly requires it and the user approves.

## 8. Process execution

- Pi executable resolved by trusted runtime profile, never by a project-controlled PATH mutation without display;
- args constructed as an array, not a shell string;
- shell invocation avoided;
- working directory validated;
- environment built from allowlisted inherited variables + Pi-required config;
- secrets not copied into diagnostic environment dumps;
- process group/job object owns descendants;
- force stop terminates the tree;
- output frame limits protect memory;
- stderr ring buffer redacts known secret patterns and paths for export;
- custom executable mode visibly marked.

Tools launched by Pi may create descendants outside the controllable tree; PiUI documents this limitation rather than claiming perfect cleanup.

## 9. Secrets and authentication

- Pi owns provider credentials;
- PiUI does not mirror secret values in SQLite/frontend stores;
- the platform credential store is used only for PiUI extension secrets;
- password inputs disable copy/display by default but permit explicit reveal;
- auth subprocess transcript is not persisted in normal logs;
- screenshots/support bundles exclude secret surfaces where technically possible;
- errors are redacted before crossing IPC;
- environment variables are shown only by name unless explicitly revealed for diagnostics;
- clipboard secret copy clears only if platform support exists and the user chooses it; no false guarantee.

Secret redaction is defense in depth, not proof that arbitrary tool output cannot echo a key. The UI warns before exporting raw logs/tool results.

## 10. Extension permissions

The host checks:

- extension ID + package fingerprint;
- source scope (global/project);
- active project/session;
- requested permission;
- grant scope and expiry;
- user gesture requirement;
- requested resource/origin;
- request rate/size.

A package update/fingerprint change invalidates high-risk grants (`project.write`, `network`, `secrets`, `ui.shell`) unless signature/publisher policy explicitly supports continuity.

Permission prompts cannot be rendered by extension-controlled HTML. The rich view pauses while a host prompt is active.

## 11. Network policy

Core Pi network belongs to Pi/provider/tool behavior and is outside the PiUI rich-view proxy.

PiUI extension network:

- denied by default;
- manifest declares origin patterns;
- user approves actual origins;
- requests flow through the host proxy;
- schemes limited to HTTPS by default;
- localhost/private network ranges require a separate high-risk grant;
- redirects revalidated;
- credentials/cookies isolated per extension or absent;
- response size/time limits;
- no raw socket/listener API in v1;
- user-agent identifies a PiUI extension request without leaking the project path.

## 12. Link/open behavior

- `https:` link: preview the domain and open in the system browser after policy/user action;
- `mailto:`: explicit user action;
- `file:`: never navigate the WebView directly; resolve through the host and reveal/open with confirmation;
- `project:`: open internal preview/editor integration, not browser navigation;
- executable file: reveal in folder by default; running it is not a core link action;
- unknown scheme blocked with diagnostics.

Markdown link text cannot hide the target domain in confirmation.

## 13. Images and media

- content-sniff MIME; do not trust filename;
- decode limits protect against decompression bombs;
- SVG is not inserted inline as trusted markup;
- EXIF metadata can contain sensitive data; PiUI does not automatically upload media except through explicit send;
- thumbnails stored in cache with quota;
- external image URLs in messages are not fetched automatically by default;
- data/blob URLs bounded;
- image preview uses isolated decoder paths available in the system WebView; high-risk formats can be blocked.

## 14. Session integrity

- active writes only through Pi;
- scanner read-only;
- no direct parentId/session mutation;
- before trash/export, verify current file identity;
- concurrent writer detection;
- corruption repair only to a new copy;
- session path not accepted from renderer payload without lookup in registry;
- SQLite cache never overwrites a newer file projection based on a stale revision.

## 15. Logging and diagnostics

Production logs include:

- timestamp, level, component, event code;
- runtime ID pseudonym;
- exit code/protocol error category;
- capability names;
- durations and sizes.

Excluded by default:

- prompt/assistant text;
- tool args/results;
- full absolute paths;
- environment values;
- auth content;
- extension storage values;
- attachment contents;
- raw RPC frames.

Support bundle workflow:

1. build local bundle;
2. show manifest/size/categories;
3. let the user include optional redacted/raw sections;
4. save locally;
5. PiUI does not upload automatically.

## 16. Safe mode

Safe mode activates when:

- the user holds the documented startup modifier;
- a CLI flag/environment is passed;
- the previous shell/view caused a crash loop;
- an integrity check fails;
- Settings requests a restart in safe mode.

Safe mode:

- uses the core theme/shell;
- disables all PiUI workers/views/shell packages;
- disables project-local Pi resources until explicit re-trust/start;
- can optionally disable all backend extensions via a safe runtime profile;
- opens diagnostics/extensions management;
- never edits sessions merely by launching.

The recovery shortcut must work outside extension-controlled DOM, for example through native menu/global startup handling.

## 17. Update security

- platform code signing where available;
- updater verifies signed metadata and artifact;
- rollback-safe version metadata;
- managed runtime manifest binds PiUI compatibility range, hash, and source;
- no silent downgrade;
- stable/beta/dev update channel explicit;
- dev builds visibly marked and do not blindly consume stable grants;
- SBOM and dependency audit generated in CI;
- reproducible-build goals tracked even if full reproducibility is not initially achieved;
- compromised-key response/revocation process documented before public release.

## 18. Security testing

Minimum suite:

- path traversal/symlink/junction cases;
- malformed JSONL/RPC frames and oversized payloads;
- malicious Markdown/HTML/SVG/ANSI/bidi fixtures;
- extension iframe breakout attempts;
- unauthorized host API calls and forged channel tokens;
- redirect/private-network checks;
- permission revocation during an active request;
- package fingerprint change;
- shell crash loop and safe-mode recovery;
- secret redaction snapshots;
- orphan process tests;
- concurrent session writer;
- update signature failure.

Fuzz targets: RPC codec, session line decoder, manifest parser, UiNode validator, resource URI parser.

## 19. Security release gates

Public 1.0 is prohibited until:

- trust wording has been reviewed for accuracy;
- extension views are isolated from Tauri IPC;
- arbitrary shell/path IPC is absent;
- signed update path has been tested;
- safe mode works with a broken shell;
- process-tree cleanup has been verified on Windows/Linux;
- diagnostics passes secret-content review;
- generic renderers safely handle hostile content;
- high-risk permission grants are invalidated on package identity change.
