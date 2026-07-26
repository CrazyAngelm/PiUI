# 07. Безопасность и модель доверия

## 1. Основная честная формулировка

Pi и его backend extensions запускаются с правами локального пользователя. Project trust контролирует, какие project-local ресурсы загружаются, но **не превращает Pi в sandbox**. PiUI обязан сообщать это до первого запуска агента в новом проекте.

PiUI снижает риск UI и случайных действий, но не может обещать изоляцию malicious Pi tool/extension без отдельной OS/container sandbox architecture.

## 2. Защищаемые активы

- source code и остальные файлы пользователя;
- Pi sessions и branch history;
- provider credentials, OAuth tokens и API keys;
- environment variables;
- clipboard;
- external files, выбранные пользователем;
- extension permission grants;
- update channel и installed binaries;
- integrity UI: permission/trust prompts и safe mode;
- приватность prompt/tool output/logs;
- availability приложения и отсутствие orphan processes.

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

Отдельные trust decisions:

1. доверять проекту для запуска Pi/project-local resources;
2. включить backend Pi extension;
3. включить PiUI declarative contributions;
4. дать permission rich view/worker;
5. выбрать global shell replacement;
6. открыть внешний link/file;
7. передать секрет/clipboard/network access.

Один trust checkbox не заменяет все уровни.

## 4. Threat actors и сценарии

### Malicious project

Репозиторий может содержать project-local Pi extension/skill/instructions, которые выполняют команды или убеждают модель сделать опасное действие.

Меры:

- проект сначала открывается read-only/restricted;
- до trust не запускается Pi в этом cwd и не загружается project-local executable UI code;
- dialog перечисляет категории ресурсов, которые могут активироваться;
- доступны `Open restricted`, `Trust and start`, `Cancel`;
- trust можно отозвать;
- смена canonical path/file identity может потребовать повторного решения.

### Malicious backend extension/tool

Backend code выполняется внутри Pi environment с правами пользователя.

Меры PiUI ограничены:

- показывать source/location/version extension;
- не скрывать tool execution;
- сохранять generic raw view;
- позволять отключить package и открыть safe mode;
- не выдавать backend extension дополнительные PiUI permissions автоматически;
- не заявлять, что PiUI sandboxed этот код.

Будущая container/OS sandbox — отдельный проект и ADR.

### Malicious PiUI rich view

View может пытаться читать filesystem, вызывать host, красть clipboard/token или делать phishing UI.

Меры:

- sandboxed isolated surface;
- без direct Tauri API;
- capability broker и host-side checks;
- network deny by default;
- visible extension identity в frame/header/permission prompt;
- no unrestricted overlays above immutable host prompts;
- rate/payload/time limits;
- CSP и navigation blocking;
- kill/revoke/crash-loop handling.

### Prompt/tool output as active content

Markdown может содержать HTML, links, SVG/data payloads или terminal escapes.

Меры:

- raw HTML disabled or sanitized allowlist;
- scripts, event attributes, iframes, forms, style injection запрещены;
- links открываются через host policy;
- `file:` и custom schemes требуют validation;
- ANSI escape sequences не передаются terminal emulator; text renderer sanitizes controls;
- SVG рассматривается как active content: rasterize/sandbox или block inline;
- code blocks — text only;
- bidi/control characters могут визуально маркироваться в sensitive paths/code.

### Compromised update/package source

Меры:

- signed desktop updates;
- HTTPS insufficient alone; verify signature/hash;
- managed Pi artifacts pinned in signed PiUI release manifest, включая upstream version, target, origin и checksum;
- предпочитать официальный standalone release artifact либо воспроизводимую сборку из versioned release source; не выполнять runtime `npm install` из приложения;
- генерировать SBOM/provenance и проверять upstream hash до упаковки;
- atomic update + rollback;
- no install during running turn;
- extension marketplace отсутствует в 1.0;
- local package source и fingerprint видимы;
- package manifest parsing does not execute scripts;
- shell selection requires explicit trust and restart.

## 5. Project trust UX

Рекомендуемый текст по смыслу:

> Pi и расширения этого проекта могут читать и изменять файлы и запускать процессы с вашими пользовательскими правами. Это не песочница.

Dialog показывает:

- canonical project path;
- найденные project-local Pi resources/packages;
- выбранный Pi executable;
- действия `Открыть без запуска`, `Доверять и запустить`, `Отмена`;
- ссылку на подробности;
- checkbox «запомнить для этого неизменённого пути/source» только при достаточной identity model.

Нельзя использовать только расплывчатое «Этот проект может быть небезопасен».

### Restricted mode

В restricted mode разрешено:

- просматривать проиндексированную историю;
- просматривать project path и session metadata;
- экспортировать существующую session;
- менять глобальные PiUI settings.

Запрещено:

- запускать Pi в project cwd;
- загружать project-local backend/UI code;
- читать произвольные project files через extension API;
- отправлять prompt, который запустит tools в проекте.

## 6. Tauri/WebView boundary

Frontend получает только узкие allowlisted commands. Требования:

- Tauri capability files минимальны и разделены по window/surface;
- extension views не наследуют core window capabilities;
- CSP запрещает remote scripts и `unsafe-eval` в production;
- devtools отключены в production либо доступны через explicit diagnostic build;
- custom protocols проверяют origin и canonical path;
- deep links считаются untrusted input;
- no generic `execute(command: string)` IPC;
- no generic `readFile(path: string)` для extension views;
- IPC DTO size/rate limits;
- every sensitive command checks current window/view identity.

Core frontend тоже не считается полностью доверенным к OS; проверка всегда повторяется в Rust.

## 7. Path policy

Host принимает typed resource references:

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
- project read/write stays within canonical root unless external handle granted;
- package resources stay within immutable/resolved package root;
- Windows reserved devices/alternate data streams tested;
- file size/type limits before reading into memory;
- writes use temp + atomic replace and conflict token;
- extension never receives unrestricted absolute path unless permission contract explicitly requires it and user approves.

## 8. Process execution

- Pi executable resolved by trusted runtime profile, never project-controlled PATH mutation without display;
- args constructed as array, not shell string;
- shell invocation avoided;
- working directory validated;
- environment built from allowlisted inherited variables + Pi-required config;
- secrets not copied into diagnostic env dump;
- process group/job object owns descendants;
- force stop terminates tree;
- output frame limits protect memory;
- stderr ring buffer redacts known secret patterns and paths for export;
- custom executable mode visibly marked.

Tools launched by Pi may create descendants outside controllable tree; PiUI documents this limitation rather than claiming perfect cleanup.

## 9. Secrets и authentication

- Pi owns provider credentials;
- PiUI does not mirror secret values in SQLite/frontend stores;
- platform credential store used only for PiUI extension secrets;
- password inputs disable copy/display by default but permit explicit reveal;
- auth subprocess transcript is not persisted in normal logs;
- screenshots/support bundles exclude secret surfaces where technically possible;
- errors are redacted before crossing IPC;
- environment variables shown only by name unless explicit diagnostic reveal;
- clipboard secret copy clears only if platform support and user chooses; no false guarantee.

Secret redaction is defense-in-depth, not proof that arbitrary tool output cannot echo a key. UI warns before exporting raw logs/tool results.

## 10. Extension permissions

Host checks:

- extension ID + package fingerprint;
- source scope (global/project);
- active project/session;
- requested permission;
- grant scope and expiry;
- user gesture requirement;
- requested resource/origin;
- request rate/size.

Package update/fingerprint change invalidates high-risk grants (`project.write`, `network`, `secrets`, `ui.shell`) unless signature/publisher policy explicitly supports continuity.

Permission prompts cannot be rendered by extension-controlled HTML. Rich view pauses while host prompt is active.

## 11. Network policy

Core Pi network belongs to Pi/provider/tool behavior and is outside PiUI rich-view proxy.

PiUI extension network:

- denied by default;
- manifest declares origin patterns;
- user approves actual origins;
- requests flow through host proxy;
- schemes limited to HTTPS by default;
- localhost/private network ranges require separate high-risk grant;
- redirects revalidated;
- credentials/cookies isolated per extension or absent;
- response size/time limits;
- no raw socket/listener API in v1;
- user-agent identifies PiUI extension request without leaking project path.

## 12. Link/open behavior

- `https:` link: preview domain and open in system browser after policy/user action;
- `mailto:`: explicit user action;
- `file:`: never directly navigate WebView; resolve through host and reveal/open with confirmation;
- `project:`: open internal preview/editor integration, not browser navigation;
- executable file: reveal in folder by default, running it is not a core link action;
- unknown scheme blocked with diagnostic.

Markdown link text cannot hide target domain in confirmation.

## 13. Images и media

- content-sniff MIME, do not trust filename;
- decode limits protect against decompression bombs;
- SVG is not inserted inline as trusted markup;
- EXIF metadata can contain sensitive data; PiUI does not automatically upload media except through explicit send;
- thumbnails stored in cache with quota;
- external image URLs in messages are not fetched automatically by default;
- data/blob URLs bounded;
- image preview uses isolated decoder paths available in system WebView; high-risk formats can be blocked.

## 14. Session integrity

- active writes only through Pi;
- scanner read-only;
- no direct parentId/session mutation;
- before trash/export, verify current file identity;
- concurrent writer detection;
- corruption repair only to a new copy;
- session path not accepted from renderer payload without lookup in registry;
- SQLite cache never overwrites newer file projection based on stale revision.

## 15. Logging и diagnostics

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
- env values;
- auth content;
- extension storage values;
- attachment contents;
- raw RPC frames.

Support bundle workflow:

1. build local bundle;
2. show manifest/size/categories;
3. let user include optional redacted/raw sections;
4. save locally;
5. PiUI does not upload automatically.

## 16. Safe mode

Safe mode activates when:

- user holds documented startup modifier;
- CLI flag/environment is passed;
- previous shell/view caused crash loop;
- integrity check fails;
- Settings requests restart in safe mode.

Safe mode:

- uses core theme/shell;
- disables all PiUI workers/views/shell packages;
- disables project-local Pi resources until explicit re-trust/start;
- can optionally disable all backend extensions via safe runtime profile;
- opens diagnostics/extensions management;
- never edits sessions merely by launching.

Recovery shortcut must work outside extension-controlled DOM, например native menu/global startup handling.

## 17. Update security

- platform code signing where available;
- updater verifies signed metadata and artifact;
- rollback-safe version metadata;
- managed runtime manifest binds PiUI compatibility range, hash and source;
- no silent downgrade;
- update channel stable/beta/dev explicit;
- dev builds visibly marked and do not consume stable grants blindly;
- SBOM and dependency audit generated in CI;
- reproducible build goals tracked even if full reproducibility is not initially achieved;
- compromised key response/revocation process documented before public release.

## 18. Security testing

Minimum suite:

- path traversal/symlink/junction cases;
- malformed JSONL/RPC frames and oversized payloads;
- malicious Markdown/HTML/SVG/ANSI/bidi fixtures;
- extension iframe breakout attempts;
- unauthorized host API calls and forged channel tokens;
- redirect/private-network checks;
- permission revocation during active request;
- package fingerprint change;
- shell crash loop and safe-mode recovery;
- secret redaction snapshots;
- orphan process tests;
- concurrent session writer;
- update signature failure.

Fuzz targets: RPC codec, session line decoder, manifest parser, UiNode validator, resource URI parser.

## 19. Security release gates

Public 1.0 запрещён, пока:

- trust wording не reviewed на точность;
- extension views не изолированы от Tauri IPC;
- arbitrary shell/path IPC отсутствует;
- signed update path не протестирован;
- safe mode не работает при broken shell;
- process tree cleanup не проверен на Windows/Linux;
- diagnostics не проходит secret-content review;
- generic renderers безопасно обрабатывают hostile content;
- high-risk permission grants инвалидируются при package identity change.
