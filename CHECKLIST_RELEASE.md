# PiUI — release readiness checklist

Этот чек-лист является блокирующим для public 1.0. Отметка ставится только при наличии ссылки на автоматический тест, артефакт CI, ADR или подписанный manual-test report.

## 1. Product scope

- [ ] Реализованы только функции, входящие в `docs/01_PRODUCT.md`; scope creep вынесен в extensions или backlog.
- [ ] Пользователь может добавить существующую папку, создать и продолжить Pi-сессию, закрыть PiUI и открыть ту же историю в CLI Pi.
- [ ] Проекты и сессии не зависят от облачного аккаунта или сети.
- [ ] Empty, loading, offline, permission-denied, missing-runtime, crashed-runtime и corrupted-index states имеют явный UX.
- [ ] Все необратимые действия имеют предупреждение или восстановимый trash flow.

## 2. Pi runtime и совместимость

- [ ] Пройдены все Phase 0 spikes из `docs/09_ROADMAP_AND_TASKS.md`.
- [ ] Зафиксированы минимальная, рекомендуемая и максимальная проверенная версии Pi.
- [ ] Capability negotiation проверяется интеграционными тестами; версия не используется как единственный источник возможностей.
- [ ] RPC stdout парсится только как протокол; stderr хранится отдельно и не ломает parser.
- [ ] Частичные строки, invalid JSON, неизвестные event types и out-of-order completion обрабатываются без падения shell.
- [ ] Stop, steer, follow-up, compaction, retry и runtime crash проходят recovery tests.
- [ ] Одновременное открытие одной сессии в CLI и PiUI либо безопасно поддержано, либо явно блокируется lock-механизмом.
- [ ] Завершение PiUI не оставляет orphaned Pi/tool processes на Windows, Linux и macOS.

## 3. Данные и сессии

- [ ] Pi JSONL остаётся source of truth; PiUI не переписывает его напрямую.
- [ ] Удаление SQLite-базы PiUI не удаляет и не повреждает Pi-сессии.
- [ ] Индекс полностью перестраивается из реестра проектов и session files.
- [ ] Atomic writes, migrations, backups и rollback migrations покрыты тестами.
- [ ] Symlink/junction/case-sensitivity/path-length/Unicode edge cases проверены по платформам.
- [ ] Rename, archive/trash, export и import имеют однозначные semantics и не создают ghost sessions.
- [ ] Secrets, prompts, tool results и пользовательские пути не попадают в telemetry по умолчанию.

## 4. Attachments и rendering

- [ ] Изображения проходят официальный Pi RPC path и корректно отображаются в истории.
- [ ] Обычные файлы передаются как явные path/resource references; UI не создаёт ложного впечатления, что Pi получил бинарный upload.
- [ ] Managed-copy режим, если включён, показывает конечный путь, размер и правила удаления.
- [ ] Большие изображения, SVG, malformed media, missing files и внешние пути безопасно обрабатываются.
- [ ] Markdown, code blocks, links, tool cards и extension output защищены от script injection и unsafe URL schemes.
- [ ] Для неизвестного custom entry/renderer существует универсальный raw-data fallback.

## 5. Extension SDK

- [ ] Backend-only Pi extension работает без `piui.manifest.json`.
- [ ] Manifest валидируется schema до загрузки; несовместимая версия отклоняется с понятной диагностикой.
- [ ] Declarative contributions проходят deterministic ordering, collision handling и lifecycle tests.
- [ ] Rich views работают в изоляции и не получают Tauri/shell/filesystem API напрямую.
- [ ] Каждая host capability выдаётся отдельно, видима пользователю и может быть отозвана.
- [ ] Project-local UI package не исполняется до trust decision.
- [ ] Full-shell replacement доступен только доверенному global package.
- [ ] Safe mode запускается до загрузки extension UI и не может быть скрыт или переопределён расширением.
- [ ] Crash loop, timeout, memory abuse и invalid messages расширения не роняют core shell.
- [ ] Reference package из `examples/minimal-piui-package/` проходит contract tests.

## 6. Security и privacy

- [ ] Threat model из `docs/07_SECURITY.md` пересмотрен перед release candidate.
- [ ] Frontend CSP запрещает inline/eval и произвольные remote origins.
- [ ] Tauri commands allowlisted; argument validation и path authorization находятся в Rust-host.
- [ ] WebView не имеет общего shell API, unrestricted filesystem или raw process spawning.
- [ ] Remote content не получает привилегированный origin.
- [ ] OAuth/login flow не передаёт credentials через DOM, logs или extension messages.
- [ ] Логи имеют redaction, retention policy и явный export flow.
- [ ] Dependency/SBOM/license/audit checks проходят в CI.
- [ ] Update artifacts подписаны; downgrade и compromised-update scenarios протестированы.
- [ ] Security contact, vulnerability policy и supported-version policy опубликованы.
- [ ] Clean clone проходит `pnpm repo:check`; source tree и Git history не содержат credentials, Pi sessions, agent artifacts, private paths или generated local state, а `LICENSE`/NOTICE/package metadata согласованы.

## 7. Performance и устойчивость

- [ ] First frame и usable-shell budgets из `docs/08_TESTING_AND_PERFORMANCE.md` пройдены на минимальных reference machines.
- [ ] Измерены отдельно RSS shell, каждый Pi runtime, extension hosts и tool child processes.
- [ ] Idle core-shell RSS не превышает release gate; отклонение документировано только ADR и новой базовой линией.
- [ ] Idle CPU, token-to-paint p95, input latency и scroll jank проходят бюджеты.
- [ ] 10 000 message blocks не рендерятся одновременно; virtualization подтверждена профилем.
- [ ] Startup и открытие существующей истории не требуют сети.
- [ ] Memory leak soak test, rapid session switching, long streaming и repeated extension reload пройдены.
- [ ] Crash recovery не теряет подтверждённые Pi entries и не дублирует user prompts.

## 8. Accessibility и UX quality

- [ ] Полный основной flow доступен с клавиатуры.
- [ ] Focus order, focus restoration, dialogs, menus и screen-reader labels проверены.
- [ ] Contrast, reduced motion, zoom 200%, high-DPI и narrow-window modes пройдены.
- [ ] Streaming updates не создают неконтролируемых live-region announcements.
- [ ] Ошибки содержат действие восстановления и diagnostic identifier, но не раскрывают secrets.
- [ ] Default UI остаётся минимальным: необязательные панели не открыты автоматически.

## 9. Platform matrix

- [ ] Windows 10/11: WebView2 bootstrap, installer, paths, Job Object, process termination, updates.
- [ ] Linux: поддерживаемые distro/WebKitGTK versions, Wayland/X11, packaging, permissions, child cleanup.
- [ ] macOS: Intel/Apple Silicon при заявленной поддержке, signing/notarization, sandbox/permissions, updates.
- [ ] На каждой платформе пройдены clean install, upgrade, downgrade rejection, uninstall и user-data preservation.
- [ ] Runtime discovery проверен для managed Pi, system Pi и custom executable.
- [ ] Managed Pi artifact имеет зафиксированные upstream origin/version/checksum, target triple, SBOM/provenance и проверенный rollback; приложение не выполняет npm install/update.
- [ ] Diagnostics bundle сообщает версии Pi/PiUI/WebView/OS без утечки содержимого чатов.

## 10. Release engineering и документация

- [ ] Reproducible build или документированная степень reproducibility подтверждена.
- [ ] Версии schema, host API и runtime protocol синхронизированы.
- [ ] Changelog перечисляет breaking changes и migration path.
- [ ] Public SDK docs содержат permissions, lifecycle, limits, fallback и compatibility examples.
- [ ] `AGENTS.md`, ADR, open risks и source list актуальны.
- [ ] User guide объясняет project trust, file semantics, safe mode, backups и CLI interoperability.
- [ ] Release candidate прошёл dogfood на реальных Pi extensions и существующих session trees.
- [ ] Go/no-go review подписан владельцами runtime, security, frontend и release engineering.
