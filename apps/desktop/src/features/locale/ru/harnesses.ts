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
  'Codex cannot limit its tools per agent: only its sandbox and permissions bound them.':
    'Codex не умеет ограничивать инструменты для отдельного агента: их ограничивают только песочница и права.',
  'With read-only, workspace-write or full-access permissions Codex never asks for approval: actions that would need it, including MCP tools that ask first, are refused.':
    'С правами «только чтение», «запись в проект» или «полный доступ» Codex никогда не спрашивает одобрения: действия, которым оно нужно, включая MCP-инструменты с запросом, отклоняются.',
  'Network access stays off unless you allow it, and only with read-only or workspace-write permissions.':
    'Доступ к сети выключен, пока вы его не разрешите, и возможен только с правами «только чтение» или «запись в проект».',
  "Read-only allows only the read, grep, find and ls tools. It is Pi's tool allowlist, not a sandbox.":
    'Режим «только чтение» разрешает лишь инструменты read, grep, find и ls. Это список инструментов Pi, а не песочница.',
  'Pi has no workspace-write mode: choose read-only or full access.':
    'У Pi нет режима «запись в проект»: выберите «только чтение» или «полный доступ».',
  'Pi cannot restrict network access.': 'Pi не умеет ограничивать доступ к сети.',
  'Prime Agent uses its own permission settings: PiUI cannot make it read-only or limit its writes.':
    'Prime Agent использует собственные настройки прав: PiUI не может сделать его «только для чтения» или ограничить запись.',
  'Approval prompts of Prime Agent are not shown in PiUI.': 'Запросы одобрения Prime Agent не показываются в PiUI.',
  'Only skills can be switched per agent; MCP servers cannot.':
    'Для отдельного агента можно переключать только навыки, MCP-серверы — нельзя.',
  'Prime Agent cannot run a single model call read-only.': 'Prime Agent не может выполнить разовый вызов модели в режиме только чтения.',
  'Hermes uses its own permission settings: PiUI cannot make it read-only or limit its writes.':
    'Hermes использует собственные настройки прав: PiUI не может сделать его «только для чтения» или ограничить запись.',
  'Hermes cannot limit its tools or delegation per agent.': 'Hermes не умеет ограничивать инструменты и делегирование для отдельного агента.',
  'Hermes cannot steer a running turn; follow-up messages wait until it ends.':
    'Hermes нельзя направлять во время хода: следующие сообщения ждут его окончания.',
  'Hermes cannot run a single model call read-only.': 'Hermes не может выполнить разовый вызов модели в режиме только чтения.',
  'Skills, MCP servers and plugins come from your Claude Code configuration and cannot be switched per agent.':
    'Навыки, MCP-серверы и плагины берутся из вашей конфигурации Claude Code, их нельзя переключать для отдельного агента.',
  'A step fails before it starts when Claude Code is not signed in: run `claude` in a terminal and use /login.':
    'Если вход в Claude Code не выполнен, шаг завершается ошибкой до запуска: запустите `claude` в терминале и выполните /login.',

  // Claude Code sign-in: run panel.
  'Claude Code is not signed in with your Claude subscription, so this step did not start. Run `claude` in a terminal and use /login, then run this step again.':
    'Claude Code не вошёл по вашей подписке Claude, поэтому шаг не запускался. Выполните `claude` в терминале, войдите через /login и запустите шаг снова.',
};
