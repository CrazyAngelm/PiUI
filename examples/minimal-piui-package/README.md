# Minimal dual Pi/PiUI package

Этот пример показывает обязательное разделение:

- `pi/extension.ts` регистрирует backend command через Pi и работает без PiUI;
- `piui.manifest.json` описывает GUI contributions как данные;
- `piui/worker.js` возвращает только declarative `UiNode` и использует capability-limited host API.

В production package необходимо:

1. зафиксировать совместимые версии зависимостей и engines;
2. добавить tests для backend command и render handlers;
3. не использовать package `private: true` при публикации;
4. валидировать manifest командой SDK/JSON Schema;
5. запрашивать только реально необходимые permissions;
6. предусмотреть generic fallback — PiUI уже покажет custom entry без этого renderer.

Manifest намеренно не содержит rich view или trusted shell. Они добавляются только когда declarative nodes недостаточны.
