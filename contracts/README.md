# PiUI contracts

- `piui-extension-manifest.schema.json` — нормативная JSON Schema manifest v1.
- `piui-host-api.d.ts` — author-facing API для declarative workers и rich views.
- `runtime-protocol.ts` — внутренний typed IPC между Rust host и core Svelte UI; v3 introduced the local live-runtime surface, v4 adds Pi-reported thinking-level discovery with a bumped event envelope, v5 adds host-owned personal Chats commands and scoped runtime events without exposing a workspace path, v6 versions desktop semantic timeline projection v2 (bounded known Pi content, correlated tools, no raw JSON/tool arguments), v7 adds cache-first session-catalog snapshots plus opaque watcher hints, and v8 versions PiUI-only appearance preferences (font size and centered conversation width). Catalog freshness never authorizes a JSONL mutation.

## Правила

1. Эти файлы versioned и проходят compatibility tests.
2. Raw Pi RPC types не должны протекать в public PiUI Extension API.
3. Изменение обязательного поля или значения union требует protocol/schema major bump.
4. Новое optional поле внутри major должно безопасно игнорироваться старым consumer там, где это заявлено.
5. Rust DTO генерируются из того же schema source или проверяются golden JSON fixtures.
6. Example manifest обязан валидироваться этой схемой в CI; негативные fixtures обязаны доказывать, что несовместимые permission/entrypoint-комбинации отклоняются.
7. JSON Schema проверяет структурные и часть security-инвариантов: `ui.shell` ↔ shell entrypoint, `network` ↔ allowlist origin, `ui.richView` ↔ views entrypoint, rich contribution → `ui.richView`.
8. Host выполняет второй, семантический проход: уникальность и принадлежность namespace, существование `viewId`/command/handler targets, dependency cycles, slot conflicts, trust level, фактическое соответствие Host API calls выданным permissions и запрет `ui.shell` для project-local/untrusted packages.
9. API, описанный здесь, является целевым контрактом для реализации; это не утверждение, что SDK уже существует.
