/** Russian UI copy for harness setup, sign-in and approvals. Keys are the English source strings. */
export const harnessesRu: Readonly<Record<string, string>> = {
  // MCP form requests (Codex MCP elicitations) in approval cards.
  'MCP server {0}': 'MCP-сервер {0}',
  'Requested values': 'Запрошенные значения',
  'Accept': 'Принять',
  'Decline': 'Отклонить',
  'No answer': 'Без ответа',
  'From {0} to {1}.': 'От {0} до {1}.',
  '{0} or more.': 'Не меньше {0}.',
  '{0} or less.': 'Не больше {0}.',
  'This request needs a value PiUI cannot show, so it can only be declined.':
    'Запрос требует значение, которое PiUI не умеет показать, поэтому его можно только отклонить.',
  'Some optional values cannot be entered here and are left empty.':
    'Некоторые необязательные значения здесь ввести нельзя, они останутся пустыми.',
  'Fill in this field.': 'Заполните это поле.',
  'Enter at least {0} characters.': 'Введите не меньше {0} символов.',
  'Enter at most {0} characters.': 'Введите не больше {0} символов.',
  'Enter an email address.': 'Введите адрес электронной почты.',
  'Enter a full address, such as https://example.com.': 'Введите полный адрес, например https://example.com.',
  'Enter a date as YYYY-MM-DD.': 'Введите дату в формате ГГГГ-ММ-ДД.',
  'Enter a date and time with a time zone, such as 2026-09-27T10:00:00Z.':
    'Введите дату и время с часовым поясом, например 2026-09-27T10:00:00Z.',
  'Enter a number.': 'Введите число.',
  'Enter a whole number.': 'Введите целое число.',
  'Enter {0} or more.': 'Введите {0} или больше.',
  'Enter {0} or less.': 'Введите {0} или меньше.',
  'Choose one of the options.': 'Выберите один из вариантов.',

  // Claude Code sign-in: composers.
  'Not signed in — run {0} in a terminal and use {1}.': 'Вход не выполнен — запустите {0} в терминале и выполните {1}.',
  'Checking the Claude Code sign-in…': 'Проверяем вход в Claude Code…',
  'Could not check the Claude Code sign-in.': 'Не удалось проверить вход в Claude Code.',
  'Claude Code is signed in with your Claude subscription.': 'Claude Code вошёл по вашей подписке Claude.',

  // Harness limitations in the node inspector (adapter manifests).
  'Limitations of {0}': 'Ограничения {0}',
  'Tools cannot be limited per agent; only the sandbox and permissions bound them.':
    'Инструменты нельзя ограничить для агента — их ограничивают только песочница и права.',
  'Never asks for approval with read-only, workspace-write or full access: actions that need one, MCP tools included, are refused.':
    'С правами «только чтение», «запись в проект» и «полный доступ» не спрашивает одобрения: такие действия, включая MCP-инструменты, отклоняются.',
  'No network unless allowed, and only with read-only or workspace-write.':
    'Сеть доступна, только если разрешена, и лишь с «только чтение» или «запись в проект».',
  'Read-only allows only read, grep, find and ls: a tool list, not a sandbox.':
    '«Только чтение» разрешает лишь read, grep, find и ls: это список инструментов, а не песочница.',
  'No workspace-write mode: choose read-only or full access.': 'Нет режима «запись в проект»: выберите «только чтение» или «полный доступ».',
  'Network access cannot be restricted.': 'Доступ к сети ограничить нельзя.',
  'Uses its own permission settings; PiUI cannot make it read-only.':
    'Использует свои настройки прав; PiUI не может сделать его «только для чтения».',
  'Its approval prompts are not shown in PiUI.': 'Его запросы одобрения не показываются в PiUI.',
  'Only skills can be switched per agent, not MCP servers.': 'Для агента переключаются только навыки, не MCP-серверы.',
  'Cannot run a single model call read-only.': 'Не может выполнить разовый вызов модели только для чтения.',
  'Tools and delegation cannot be limited per agent.': 'Инструменты и делегирование нельзя ограничить для агента.',
  'A running turn cannot be steered; follow-ups wait for it to end.': 'Идущий ход нельзя направлять; следующие сообщения ждут его конца.',
  'Skills, MCP servers and plugins come from your Claude Code settings; they cannot be switched per agent.':
    'Навыки, MCP-серверы и плагины берутся из настроек Claude Code; для агента их не переключить.',
  'Without a sign-in a step fails before it starts: run `claude` and use /login.':
    'Без входа шаг завершается ошибкой до запуска: запустите `claude` и выполните /login.',

  // Claude Code sign-in: run panel.
  'Claude Code is not signed in with your Claude subscription, so this step did not start. Run `claude` in a terminal and use /login, then run this step again.':
    'Claude Code не вошёл по вашей подписке Claude, поэтому шаг не запускался. Выполните `claude` в терминале, войдите через /login и запустите шаг снова.',
};
