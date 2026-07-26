# 01. Product Requirements Document

## 1. Назначение

PiUI — локальная desktop-оболочка над Pi agent harness. Она организует существующие рабочие папки как проекты, показывает связанные с ними Pi-сессии и даёт chat-first интерфейс для продолжения работы. Ядро продукта намеренно невелико: управление проектами и сессиями, чат, отображение agent activity, базовые настройки и точка расширения.

PiUI не конкурирует с Pi и не создаёт альтернативную экосистему. Один Pi package может содержать обычные Pi extensions/skills/prompts/themes и дополнительное UI-описание для PiUI.

## 2. Продуктовая формула

> **Существующий Pi + существующие файлы пользователя + минимальная графическая оболочка + версионированные UI contributions.**

### 2.1 Почему это соответствует философии Pi

Pi прямо позиционирует себя как набор primitives, а не как заранее заданный workflow. Сессии имеют древовидную историю, расширения могут регистрировать tools, commands, события и TUI-компоненты. Следовательно, PiUI должен добавлять интерфейсные primitives, а не встраивать в core конкретные методологии вроде plan mode, subagents, worktrees или approval framework.

### 2.2 Product principles

1. **Local first.** Сессии, настройки и проекты остаются локальными. Модельные providers могут быть удалёнными, но PiUI не имеет собственного cloud backend.
2. **Same Pi everywhere.** CLI и PiUI разделяют конфигурацию и сессии.
3. **Progressive disclosure.** На основном экране видны только действия текущей работы; сложные сведения открываются по запросу.
4. **Fast path first.** Добавить папку → открыть чат → отправить сообщение должно занимать минимум действий.
5. **Extension over accumulation.** Специализированная функция сначала проектируется как extension contribution.
6. **Honest security.** Trust не называется sandbox; пользователь видит, что Pi и backend-extensions исполняются с его OS-правами.
7. **Graceful degradation.** Незнакомые tool calls, custom messages и отключённые UI extensions остаются читаемыми.
8. **Keyboard and mouse parity.** Основные потоки полностью доступны с клавиатуры, но не требуют запоминания команд.

## 3. Целевые пользователи

### 3.1 Primary: разработчик, уже использующий Pi

Нужен визуальный менеджер нескольких проектов и сессий без потери CLI-конфигурации, tools, extensions и истории.

### 3.2 Secondary: пользователь, предпочитающий GUI

Хочет работать с Pi без постоянной навигации по terminal TUI, видеть изображения, structured tool activity и легко возвращаться к чатам.

### 3.3 Extension author

Хочет одним package расширить поведение Pi и добавить UI: renderer своего tool, кнопку composer, settings, sidebar view или даже альтернативный shell.

### 3.4 Maintainer

Нужны узкое ядро, стабильные contracts, воспроизводимые баги, safe mode и возможность обновлять Pi независимо от UI.

## 4. Jobs to be done

- Когда у меня несколько рабочих папок, я хочу быстро видеть активные Pi-сессии и их состояние.
- Когда я продолжаю сессию из CLI, я хочу найти её в PiUI без импорта или конвертации.
- Когда агент работает долго, я хочу переключиться на другой чат и позже увидеть результат.
- Когда расширение просит подтверждение или ввод, я хочу ответить нормальным GUI-диалогом.
- Когда tool возвращает сложный результат, я хочу увидеть удобный renderer, но не потерять raw data.
- Когда проект незнакомый, я хочу явно решить, загружать ли его extensions/settings.
- Когда UI extension падает, я хочу продолжать чат без потери сессии.

## 5. Термины

- **Project** — зарегистрированный в PiUI canonical path к существующей папке.
- **Session** — исходный JSONL-файл Pi и его дерево entries.
- **Active branch** — путь от корня session tree до текущего `leafId`.
- **Runtime** — запущенный процесс Pi RPC, обслуживающий одну открытую/работающую сессию.
- **Dormant session** — сессия без запущенного процесса; её метаданные доступны из индекса.
- **Pi extension** — TypeScript-модуль, загружаемый самим Pi.
- **PiUI extension** — UI contribution из того же или отдельного package, загружаемый PiUI.
- **Package** — распространяемый через npm/git/local Pi package с ключами `pi` и, опционально, `piui`.
- **Generic fallback** — безопасное стандартное отображение неизвестного payload.
- **Managed Pi** — закреплённая совместимая поставка Pi, распространяемая вместе с PiUI или его runtime installer.
- **System Pi** — команда `pi`, установленная пользователем.

## 6. Scope продукта

### 6.1 Core 1.0

- Реестр проектов-папок.
- Список Pi-сессий по проектам.
- Новый чат, открытие и продолжение существующего.
- Одновременная работа нескольких сессий с ограничением concurrency.
- Streaming text/thinking/tool activity.
- Stop, steer, follow-up и очередь.
- Выбор provider/model и thinking level из данных Pi.
- Image input и inline image display.
- File attachment adapter без выдуманного бинарного протокола.
- Session rename, export, fork/clone; branch tree — чтение, переход после закрытия RPC-gap.
- Settings и runtime diagnostics.
- Project trust.
- Tier 0 и Tier 1/Tier 2 PiUI extensions.
- Search по локальному перестраиваемому индексу.
- Safe mode и crash recovery.
- Windows/Linux packaging; macOS-ready codebase.

### 6.2 Намеренно вне core 1.0

- Git status, diffs, commits, worktrees.
- IDE или полноценный file explorer.
- Embedded terminal.
- Subagent orchestration dashboard.
- Plan mode.
- Permissions framework для действий модели.
- MCP registry.
- Remote SSH/containers UI.
- Cloud sync/accounts/teams.
- Extension marketplace и автоматическая публикация packages.
- Голосовой режим.

Эти функции допустимы как extensions; core предоставляет slots и host capabilities.

## 7. Functional requirements

### 7.1 Project registry

| ID | Требование | Приоритет |
|---|---|---|
| PRJ-001 | Пользователь добавляет существующую папку через системный folder picker. | Must |
| PRJ-002 | Путь canonicalize-ится с учётом symlink/case rules платформы; дубликаты не создаются. | Must |
| PRJ-003 | Проект можно переименовать только в UI-реестре; имя папки на диске не меняется. | Must |
| PRJ-004 | Проект можно pin/unpin и скрыть из реестра без удаления папки или Pi-сессий. | Must |
| PRJ-005 | Недоступный путь показывается как offline/missing; запись не удаляется автоматически. | Must |
| PRJ-006 | Dragging папки на sidebar предлагает добавить её как project. | Should |
| PRJ-007 | Project-level Pi resources загружаются только после trust resolution. | Must |
| PRJ-008 | Пользователь может открыть папку в системном file manager и скопировать путь. | Should |
| PRJ-009 | Nested projects разрешены как отдельные entries; PiUI предупреждает о пересекающемся trust scope. | Should |

### 7.2 Session discovery and lifecycle

| ID | Требование | Приоритет |
|---|---|---|
| SES-001 | PiUI обнаруживает существующие Pi session JSONL для canonical project path. | Must |
| SES-002 | Сессия, созданная/изменённая CLI, появляется после filesystem event или ручного refresh без импорта. | Must |
| SES-003 | Список содержит display name, fallback title, last activity, runtime status и branch indicator. | Must |
| SES-004 | Новый чат создаётся через Pi runtime, а не ручное создание JSONL. | Must |
| SES-005 | Открытие dormant session запускает runtime on demand и загружает нужный session file. | Must |
| SES-006 | Переключение UI не останавливает выполняющуюся сессию; idle inactive runtime можно выгрузить по TTL. | Must |
| SES-007 | Session rename использует Pi RPC `set_session_name`. | Must |
| SES-008 | Delete использует OS trash, после подтверждения и только для выбранного `.jsonl`; permanent delete скрыт в Advanced. | Must |
| SES-009 | Export использует Pi `export_html`; raw JSONL copy доступен отдельным действием. | Must |
| SES-010 | Fork/clone используют Pi RPC и отражаются в sidebar. | Must |
| SES-011 | Full tree view отображает все branches и labels; переход на произвольный node включается только при поддерживаемом runtime capability. | Should/blocked |
| SES-012 | Crash runtime не повреждает session file; пользователь видит restart/resume. | Must |
| SES-013 | Header-only/пустые sessions не засоряют список: они группируются или удаляются только по доказуемому ownership rule. | Should |
| SES-014 | Session list не требует запуска runtime для каждой сессии. | Must |

### 7.3 Chat timeline

| ID | Требование | Приоритет |
|---|---|---|
| CHT-001 | Отображаются user, assistant, thinking, tool call/result, bash, compaction, retry, error и custom messages. | Must |
| CHT-002 | Streaming обновляется батчами; UI не пересобирает весь Markdown на каждый token delta. | Must |
| CHT-003 | Thinking collapsed по умолчанию; пользователь может раскрыть конкретный block. | Must |
| CHT-004 | Tool call и result визуально объединены в одну карточку с running/success/error/cancelled state. | Must |
| CHT-005 | Generic tool card показывает tool name, arguments, result summary и raw JSON/text по раскрытию. | Must |
| CHT-006 | Tool output не исполняет HTML/JS и не открывает ссылки автоматически. | Must |
| CHT-007 | Custom renderer не может скрыть доступ к raw payload. | Must |
| CHT-008 | Пользователь может копировать message text, code block, tool output и permalink/entry ID. | Should |
| CHT-009 | Long conversations virtualize off-screen content без скачка scroll anchor. | Must |
| CHT-010 | При чтении истории новые streaming events не насильно прокручивают вниз; показывается “New activity”. | Must |
| CHT-011 | Ошибка provider/retry отображается inline с ясным состоянием, не как исчезающий toast. | Must |
| CHT-012 | Compaction отображается ненавязчивым разделителем; details доступны по раскрытию. | Should |
| CHT-013 | Images из message content рендерятся inline с fit/zoom/open/copy path where applicable. | Must |
| CHT-014 | Неизвестный message/entry type показывается generic inspector, а не теряется. | Must |

### 7.4 Composer and queues

| ID | Требование | Приоритет |
|---|---|---|
| CMP-001 | Multiline composer поддерживает обычный текст, slash commands, path suggestions и attachments. | Must |
| CMP-002 | В idle state `Enter` отправляет, `Shift+Enter` создаёт строку; hotkeys настраиваются. | Must |
| CMP-003 | Во время run пользователь явно выбирает `Steer` или `Follow up`; выбранное поведение видно до отправки. | Must |
| CMP-004 | Кнопка Send превращается в Stop только для active run; queued composer остаётся доступным. | Must |
| CMP-005 | Pending queue показывается chips/list, элементы можно удалить до доставки, если Pi capability это допускает; иначе UI честно сообщает ограничение. | Should |
| CMP-006 | `get_commands` питает autocomplete для extension commands, prompts и skills. | Must |
| CMP-007 | Built-in TUI commands, недоступные RPC, не предлагаются как исполняемые. | Must |
| CMP-008 | `set_editor_text` от extension заменяет/вставляет composer content с защитой от случайной потери несохранённого текста. | Must |
| CMP-009 | Draft сохраняется локально per session и очищается только после принятого prompt. | Must |
| CMP-010 | Composer не отправляет пустой prompt без attachment/command. | Must |

### 7.5 Models and thinking

| ID | Требование | Приоритет |
|---|---|---|
| MOD-001 | Model picker заполняется через `get_available_models`, не из захардкоженного списка. | Must |
| MOD-002 | Текущая model/thinking state берётся из `get_state`. | Must |
| MOD-003 | Switching использует `set_model`; ошибки показываются рядом с picker. | Must |
| MOD-004 | Thinking options берутся через `get_available_thinking_levels`. | Must |
| MOD-005 | Picker показывает provider, display name, input modalities и context window, если они доступны. | Should |
| MOD-006 | Смена model во время несовместимого state блокируется или ставится в очередь согласно фактическому ответу Pi. | Must |
| MOD-007 | PiUI не создаёт собственный список цен; показывается только cost metadata, полученная от Pi, с пометкой estimate. | Must |
| MOD-008 | Неавторизованный provider ведёт в Settings/Auth flow, а не к ручному редактированию JSON в основном UI. | Must |

### 7.6 Attachments

| ID | Требование | Приоритет |
|---|---|---|
| ATT-001 | PNG/JPEG/WebP/GIF при поддержке выбранной модели кодируются и передаются через RPC `images`. | Must |
| ATT-002 | Изображение имеет preview, MIME/size validation и remove action до отправки. | Must |
| ATT-003 | Файл внутри project root передаётся агенту как canonical relative path в структурированном text preamble; содержимое не дублируется автоматически. | Must |
| ATT-004 | Внешний файл требует явного выбора: reference original path или copy into managed project attachment area. | Must |
| ATT-005 | Copy использует content hash, collision-safe filename и provenance metadata; source не удаляется. | Must |
| ATT-006 | PDF/doc/archive не обещаются как “понятые” моделью: PiUI передаёт path и позволяет Pi/tool/extension прочитать или преобразовать файл. | Must |
| ATT-007 | Директории не прикрепляются как бинарные объекты; вставляется path reference. | Must |
| ATT-008 | Attachment size limits настраиваются; oversized image предлагает downscale/cancel без скрытого изменения оригинала. | Should |
| ATT-009 | При model без image input Send блокируется для image-only prompt и предлагает смену модели или path reference. | Must |
| ATT-010 | Attachment history в UI восстанавливается из message image blocks и PiUI metadata, но session validity не зависит от metadata. | Must |

### 7.7 Extension compatibility

| ID | Требование | Приоритет |
|---|---|---|
| EXT-001 | Обычный Pi extension загружается самим Pi без переписывания для PiUI. | Must |
| EXT-002 | `select/confirm/input/editor` отображаются модальными UI и возвращают matching response. | Must |
| EXT-003 | `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` имеют определённое отображение. | Must |
| EXT-004 | TUI-only APIs не симулируются ложными обещаниями; extension diagnostics указывает degradation. | Must |
| EXT-005 | Pi package может объявить `piui.manifest.json` с contributions и permissions. | Must for 1.0 |
| EXT-006 | Unknown/missing UI extension не ломает backend Pi extension. | Must |
| EXT-007 | Declarative contributions не исполняют arbitrary JS. | Must |
| EXT-008 | Rich views запускаются в sandboxed frame/worker и общаются только через capability host API. | Must |
| EXT-009 | Full shell replacement разрешён только explicitly trusted global package после restart. | Should for 1.0 |
| EXT-010 | Safe mode отключает все PiUI packages и project-local Pi resources. | Must |
| EXT-011 | Extension API имеет semantic version/capability negotiation и compatibility errors. | Must |
| EXT-012 | Extension can contribute settings, commands, status items, composer actions, sidebar/panel views, tool/message/preview renderers and optional shell. | Must |
| EXT-013 | Project UI package никогда не получает network/workspace-write/session-command capability без manifest permission и user grant. | Must |
| EXT-014 | Development mode поддерживает reload UI package без рестарта всей app, кроме shell replacement. | Should |

### 7.8 Settings and authentication

| ID | Требование | Приоритет |
|---|---|---|
| SET-001 | Settings доступны кнопкой в верхней части sidebar и command palette. | Must |
| SET-002 | Разделы: General, Runtime, Models & Auth, Extensions, Appearance, Keybindings, Security, Advanced/Diagnostics. | Must |
| SET-003 | PiUI settings хранятся отдельно; Pi settings изменяются только через поддерживаемый adapter с atomic write/validation. | Must |
| SET-004 | OAuth/subscription login, пока нет headless API, запускается через контролируемый interactive Pi flow; результат остаётся в стандартном Pi auth store. | Must |
| SET-005 | API key field маскирует значение, никогда не читает существующий secret обратно в UI и записывает его через trusted backend flow. | Must |
| SET-006 | Runtime page показывает selected mode, path, version, capabilities, stderr diagnostics и “Test runtime”. | Must |
| SET-007 | Extensions page различает global/project, Pi backend/PiUI frontend, trusted/disabled/error states. | Must |
| SET-008 | Advanced settings скрыты по умолчанию и имеют reset-to-default. | Must |
| SET-009 | Theme default следует OS; light/dark и density доступны без перезапуска. | Should |
| SET-010 | Keybindings обнаруживают conflicts до сохранения. | Should |

### 7.9 Search and navigation

| ID | Требование | Приоритет |
|---|---|---|
| NAV-001 | Search находит projects, session names, first user text и message text из локального индекса. | Must for 1.0 |
| NAV-002 | Search result открывает session и прокручивает к entry, если entry доступен active branch; иначе открывает tree context. | Should |
| NAV-003 | Command palette открывает project/session/settings/actions. | Must |
| NAV-004 | Back/forward navigation восстанавливает project/session/panel state, но не управляет runtime history. | Should |

### 7.10 Notifications and lifecycle

| ID | Требование | Приоритет |
|---|---|---|
| LIF-001 | Background session completion помечается badge; OS notification опциональна. | Must |
| LIF-002 | Closing window при running sessions предлагает оставить app in tray, stop tasks или cancel close. | Should |
| LIF-003 | App exit корректно завершает owned idle runtimes; running processes не остаются orphaned без явной политики. | Must |
| LIF-004 | После crash PiUI восстанавливает project/session selection и перечитывает session source of truth. | Must |
| LIF-005 | Обновление приложения никогда не запускается во время незавершённой записи/миграции без безопасного restart flow. | Must |

## 8. Non-functional requirements

### 8.1 Performance

Целевые бюджеты приведены в testing document. Ключевые требования:

- первый paint не ждёт network/auth/model refresh;
- dormant sessions не имеют процессов;
- idle app CPU близок к нулю;
- timeline virtualized;
- streaming batched;
- extension sandbox lazy-loaded;
- search index обновляется incrementally и имеет backpressure.

### 8.2 Reliability

- append-only Pi sessions не модифицируются indexer-ом;
- partial JSONL line не считается corruption;
- process crash и extension crash изолированы от WebView;
- IPC requests имеют IDs, timeout и cancellation;
- migrations transactional, rollbackable и backed up;
- capability mismatch даёт actionable error.

### 8.3 Accessibility

- WCAG 2.2 AA как целевой уровень;
- full keyboard flow;
- semantic landmarks, focus management, reduced motion, screen-reader live regions для streaming без спама;
- минимум 44×44 CSS px для touch-target where applicable, но desktop density допускает компактные визуальные размеры при достаточной hit area;
- status не передаётся только цветом.

### 8.4 Privacy

- telemetry off and absent by default;
- crash report создаётся локально и отправляется только после preview/consent;
- logs redacted;
- extensions декларируют network domains;
- external links открываются системным browser.

### 8.5 Compatibility

- Windows и Linux — release blockers;
- macOS code path в CI с раннего этапа;
- Pi protocol compatibility matrix, не “latest only” без проверки;
- неизвестные RPC events сохраняются в diagnostics и не валят parser.

## 9. Success metrics

Публичная версия считается успешной, когда:

1. 95% test fixtures CLI→PiUI→CLI сохраняют ту же active branch и readable history.
2. Crash-free sessions >99.5% в opt-in aggregate, либо эквивалентная локальная test telemetry для pre-release.
3. Median time add project → first accepted prompt менее 60 секунд для нового пользователя и менее 15 секунд для настроенного Pi.
4. Idle RSS и startup соответствуют бюджетам на обеих Tier-1 платформах.
5. Не менее трёх fixture packages доказывают: generic Pi extension, declarative UI package, sandboxed rich renderer.
6. Safe mode открывается после намеренно broken shell extension.
7. Ни один test не требует конвертации session JSONL в proprietary chat file.

## 10. Release gates

- Все Must requirements имеют тест или документированную manual acceptance procedure.
- Нет открытых P0/P1 data-loss/security bugs.
- Runtime compatibility tested с minimum, pinned и latest-supported Pi versions.
- Windows/Linux installers подписаны там, где инфраструктура позволяет, и проверены clean-machine install/update/uninstall.
- Third-party licenses/NOTICE собраны автоматически.
- Threat model reviewed после реализации extension host.
- Accessibility audit выполнен keyboard-only и минимум одним screen reader на каждой Tier-1 OS family.
