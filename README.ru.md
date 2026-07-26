# PiUI

<p align="center">
  Быстрый локальный desktop-интерфейс для просмотра и продолжения сессий <a href="https://pi.dev/">Pi</a>.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md"><strong>Русский</strong></a>
</p>

<p align="center">
  <a href="https://github.com/CrazyAngelm/PiUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/CrazyAngelm/PiUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/CrazyAngelm/PiUI/releases"><img alt="Последний релиз" src="https://img.shields.io/github/v/release/CrazyAngelm/PiUI?include_prereleases"></a>
  <a href="LICENSE"><img alt="Лицензия MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

> [!IMPORTANT]
> PiUI находится на ранней стадии developer preview. Текущая сборка для Windows не подписана, не обновляется автоматически и не является управляемым дистрибутивом Pi или OS sandbox. Перед использованием с важными сессиями прочитайте раздел [Текущие ограничения](#текущие-ограничения).

## Установка

### Windows 10/11 (рекомендуемый способ)

1. Установите официальный [Pi CLI](https://pi.dev/) и убедитесь, что команда `pi --version` работает в новом окне терминала.
2. Откройте [релиз PiUI v0.1.0](https://github.com/CrazyAngelm/PiUI/releases/tag/v0.1.0).
3. Скачайте `PiUI_0.1.0_x64-setup.exe` и соответствующий файл `SHA256SUMS.txt`.
4. Проверьте контрольную сумму, запустите установщик и откройте **PiUI** через меню «Пуск».
5. Выберите **New chat** для личной сессии или **Add project**, чтобы зарегистрировать существующую папку.

После загрузки обоих файлов проверьте установщик:

```powershell
Get-FileHash .\PiUI_0.1.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

Хеш из `Get-FileHash` должен совпадать со строкой установщика в `SHA256SUMS.txt`.

Поскольку developer-preview сборка не имеет цифровой подписи, Windows может показать предупреждение о неизвестном издателе. Перед запуском проверьте контрольную сумму. Если вы не хотите запускать неподписанный бинарный файл, [соберите приложение из исходников](#сборка-из-исходников).

Портативный файл `PiUI_0.1.0_windows_x86_64.exe` можно использовать без установки. На него распространяются те же ограничения preview-версии.

### Linux и macOS

Готовые пакеты для Linux и macOS пока не публикуются. Используйте [сборку из исходников](#сборка-из-исходников). Платформенная упаковка, подпись и полная матрица релизов остаются открытыми задачами.

### Обновление

PiUI не обновляется незаметно для пользователя. Скачайте новый релиз с GitHub и установите его поверх предыдущей версии. Сессии принадлежат Pi; локальная SQLite-база PiUI содержит только перестраиваемый кеш и UI metadata.

## Первый запуск

1. Запустите PiUI.
2. Используйте **New chat**, чтобы начать без проекта, или нажмите **Add project** и внимательно проверьте запрос доверия к папке.
3. Выберите существующую сессию или создайте новую.
4. Запустите локальный runtime Pi, выберите модель и отправьте сообщение.

Не записывайте данные в одну сессию одновременно из PiUI и Pi CLI. Безопасная работа нескольких writers пока не поддерживается.

## Возможности PiUI

- обнаруживает существующие Pi JSONL-сессии без введения второго формата чатов;
- безопасно отображает ограниченную по размеру ленту с Markdown, reasoning и сгруппированной активностью tools;
- продолжает индексированные сессии или создаёт личные чаты, которыми владеет Pi;
- запускает локально установленный Pi CLI в RPC-режиме только после явного действия пользователя;
- передаёт типизированные runtime events через узкий Rust/Tauri Host API;
- хранит перестраиваемый SQLite-каталог отдельно от файлов сессий Pi;
- предоставляет управление доверием к проектам и локальные настройки внешнего вида;
- поддерживает клавиатурную навигацию, безопасные generic fallback и reduced motion.

PiUI является оболочкой над Pi. Он не заменяет agent loop, providers, tools, compaction, хранилище аутентификации или ветвление сессий Pi.

## Текущие ограничения

- Локальный live-RPC путь является preview, а не гарантией происхождения управляемого runtime.
- Артефакты Windows не подписаны, автоматического обновления пока нет.
- Одновременная запись в одну сессию из Pi CLI и PiUI не поддерживается.
- Аутентификация остаётся в стандартном потоке Pi; PiUI не читает и не раскрывает `auth.json`.
- Packaged browser/Tauri E2E, получение управляемого runtime, updater и полная матрица Windows/Linux остаются release gates.
- Project-local JavaScript расширений отключён до завершения модели доверия и изоляции.

Точный статус описан в [Foundation status](docs/13_FOUNDATION_STATUS.md), [open risks](docs/12_OPEN_RISKS.md) и [release checklist](CHECKLIST_RELEASE.md).

## Сборка из исходников

### Требования

- Git
- Node.js 22+
- pnpm 10.23+
- Rust 1.94.1 с `rustfmt` и `clippy`
- [платформенные зависимости Tauri 2](https://v2.tauri.app/start/prerequisites/)
- локальный Pi CLI для live-runtime preview

### Development-сборка

```bash
git clone https://github.com/CrazyAngelm/PiUI.git
cd PiUI
pnpm install --frozen-lockfile
pnpm tauri dev
```

### Release-сборка

```bash
pnpm install --frozen-lockfile
pnpm repo:check
pnpm check
pnpm test
pnpm contract:test
cargo test --workspace
pnpm tauri build --no-bundle
```

Исполняемый файл будет создан в `target/release/`. В Windows maintainers могут собрать NSIS-установщик командой:

```powershell
pnpm tauri build --bundles nsis --ci
```

## Проверки качества

```bash
pnpm repo:check
python tools/validate_spec.py
pnpm check
pnpm test
pnpm contract:test
pnpm build
pnpm test:e2e
pnpm perf:smoke
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm test:e2e` сейчас является статической smoke-проверкой UI, а не packaged desktop E2E suite.

## Структура репозитория

```text
apps/desktop/           Tauri 2 host и интерфейс на Svelte 5
crates/piui-contracts/  Безопасные host/UI DTO и fixtures
crates/piui-index/      Перестраиваемый SQLite-индекс и LF-only scanner сессий
crates/piui-runtime/    Pi RPC adapter, lifecycle и stream projection
crates/piui-platform/   Native identity и process-containment primitives
crates/piui-extensions/ Валидация extension manifest
contracts/              Версионированные TypeScript-контракты
docs/                   Product, architecture, security и release documentation
spikes/                 Изолированные evidence/experiments, не runtime dependencies
```

## Документация

- [Product scope](docs/01_PRODUCT.md)
- [UX and information architecture](docs/02_UX.md)
- [Architecture](docs/03_ARCHITECTURE.md)
- [Pi integration](docs/04_PI_INTEGRATION.md)
- [Extension SDK](docs/05_EXTENSION_SDK.md)
- [Data and sessions](docs/06_DATA_AND_SESSIONS.md)
- [Security model](docs/07_SECURITY.md)
- [Testing and performance](docs/08_TESTING_AND_PERFORMANCE.md)
- [Roadmap](docs/09_ROADMAP_AND_TASKS.md)
- [Architecture decisions](docs/10_ADR.md)

## Участие в разработке и безопасность

Мы приветствуем contributions. Перед pull request прочитайте [CONTRIBUTING.md](CONTRIBUTING.md) и [AGENTS.md](AGENTS.md). Изменения IPC-контрактов требуют повышения версии, compatibility coverage и обновления файлов в `contracts/`.

Сообщайте об уязвимостях приватно по правилам [SECURITY.md](SECURITY.md). Никогда не публикуйте credentials, prompts, session files или локальные filesystem paths в issue.

## Лицензия

PiUI распространяется по [лицензии MIT](LICENSE). Сторонние зависимости и упомянутые внешние материалы остаются под своими лицензиями и условиями.
