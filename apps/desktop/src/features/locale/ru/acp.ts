/** Russian UI copy for ACP agents. Keys are the English source strings. */
export const acpRu: Readonly<Record<string, string>> = {
  // Generic ACP adapter manifest (src/harness-adapters/acp.ts).
  'ACP agent': 'ACP-агент',
  'The agent keeps its own permission, tool and MCP settings. PiUI answers its permission requests but cannot restrict its tools or files.':
    'Агент сам управляет своими разрешениями, инструментами и MCP. PiUI отвечает на его запросы разрешений, но не может ограничить его инструменты или файлы.',
  'Instructions are sent with the first message; the agent keeps its own system prompt.':
    'Инструкции отправляются с первым сообщением; агент сохраняет свой системный промпт.',

  // Settings → Harnesses (src/app/settings).
  'Safe mode: PiUI starts no agent program, so harness checks and changes are off.':
    'Безопасный режим: PiUI не запускает программы агентов, поэтому проверки и изменения харнесов отключены.',
  'Loading harnesses…': 'Загрузка харнесов…',
  'Built-in harnesses': 'Встроенные харнесы',
  Location: 'Расположение',
  'Tested with PiUI': 'Проверено с PiUI',
  'Sign-in': 'Вход',
  'ACP agents': 'ACP-агенты',
  'Add ACP agent…': 'Добавить ACP-агента…',
  'Agents that speak the Agent Client Protocol. PiUI starts only the exact command line you trust, never through a shell. Trust is not a sandbox: an agent runs with your permissions.':
    'Агенты, работающие по Agent Client Protocol. PiUI запускает только ту командную строку, которой вы доверили, и никогда через оболочку. Доверие — не песочница: агент работает с вашими правами.',
  'Use {0} {1}?': 'Использовать {0} {1}?',
  'Use this version': 'Использовать эту версию',
  'PiUI has not verified this version with this agent. It may use the protocol differently than PiUI expects.':
    'PiUI не проверял эту версию агента. Она может использовать протокол иначе, чем ожидает PiUI.',
  'The confirmation covers only version {0}. An update needs a new confirmation.':
    'Подтверждение действует только для версии {0}. После обновления понадобится новое подтверждение.',
  'Remove {0}?': 'Удалить {0}?',
  'Remove agent': 'Удалить агента',
  'PiUI forgets this descriptor and your decisions about it. Chats with this agent keep their history but cannot start until you add it again.':
    'PiUI забудет это описание и ваши решения о нём. Чаты с этим агентом сохранят историю, но не запустятся, пока вы не добавите его снова.',
  'Not checked': 'Не проверено',
  'Not installed': 'Не установлен',
  'Unsupported version': 'Неподдерживаемая версия',
  'Unverified version': 'Непроверенная версия',
  'Sign-in required': 'Нужен вход',
  'Needs review': 'Нужна проверка',
  '{0}, tested with PiUI': '{0}, проверена с PiUI',
  '{0}, not verified by PiUI; you confirmed this version': '{0}, не проверена PiUI; вы подтвердили эту версию',
  '{0}, newer than the versions tested with PiUI': '{0}, новее версий, проверенных с PiUI',
  '{0}, not verified by PiUI': '{0}, не проверена PiUI',
  '{0}, older than the versions tested with PiUI': '{0}, старше версий, проверенных с PiUI',
  'The version output was not recognized': 'Вывод версии не распознан',
  'The version check did not finish': 'Проверка версии не завершилась',
  'Ships with PiUI': 'Поставляется с PiUI',
  'Added by you': 'Добавлен вами',
  Identity: 'Идентификатор',
  Command: 'Команда',
  Program: 'Программа',
  Version: 'Версия',
  'The agent offers: {0}.': 'Агент предлагает: {0}.',
  Environment: 'Окружение',
  'Passed from your environment: {0}': 'Передаются из вашего окружения: {0}',
  'Secrets you allowed: {0}': 'Разрешённые вами секреты: {0}',
  'Secrets not passed: {0}': 'Секреты не передаются: {0}',
  'Switched off': 'Отключено',
  'Reopening chats': 'Повторное открытие чатов',
  'Model choice': 'Выбор модели',
  'Session modes': 'Режимы сессии',
  'PiUI coordination tool': 'Инструмент координации PiUI',
  Documentation: 'Документация',
  'Review and trust…': 'Проверить и доверить…',
  'Confirm version…': 'Подтвердить версию…',
  'Secret variables…': 'Секретные переменные…',

  // Registry readiness reasons and sign-in hints (host fixed texts).
  'Checking this agent…': 'Проверка агента…',
  "The agent's program was not found on PATH.": 'Программа агента не найдена в PATH.',
  "The agent's program path does not exist.": 'Путь к программе агента не существует.',
  'This launcher needs a shell, which PiUI never uses. Point the descriptor at the executable or the Node script.':
    'Этому загрузчику нужна оболочка, а PiUI никогда её не использует. Укажите в описании исполняемый файл или скрипт Node.',
  'Node.js is needed to start this agent but was not found.': 'Для запуска этого агента нужен Node.js, но он не найден.',
  "Review and trust this agent's command line in Settings → Harnesses.":
    'Проверьте командную строку этого агента и доверьте её в «Настройки → Харнесы».',
  'The installed version is older than the versions tested with PiUI.': 'Установленная версия старше версий, проверенных с PiUI.',
  'The agent did not report a version PiUI can recognize.': 'Агент не сообщил версию, которую PiUI может распознать.',
  'PiUI has not verified this version. Confirm it in Settings → Harnesses to use it.':
    'PiUI не проверял эту версию. Подтвердите её в «Настройки → Харнесы», чтобы использовать.',
  "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.":
    'Войдите через приложение самого агента и попробуйте снова. Как это сделать — в «Настройки → Харнесы».',
  'This agent is no longer registered in Settings → Harnesses.': 'Этот агент больше не зарегистрирован в «Настройки → Харнесы».',
  'Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.':
    'Claude Code работает только по вашей подписке Claude: запустите `claude` в терминале и выполните /login.',
  "Sign in with Codex's own flow: run `codex login` in a terminal.": 'Войдите средствами Codex: выполните `codex login` в терминале.',
  "Sign in with Gemini CLI's own flow: run `gemini` in a terminal and choose a sign-in method. To use an API key instead, allow PiUI to pass GEMINI_API_KEY below.":
    'Войдите средствами Gemini CLI: запустите `gemini` в терминале и выберите способ входа. Чтобы вместо этого использовать API-ключ, разрешите PiUI передавать GEMINI_API_KEY ниже.',

  // Registry errors (harness_registry_v1).
  'Harness checks and changes are disabled in safe mode.': 'В безопасном режиме проверки и изменения харнесов отключены.',
  'The harness list changed. Review it and try again.': 'Список харнесов изменился. Проверьте его и попробуйте снова.',
  'An agent with this ID already exists.': 'Агент с таким ID уже существует.',
  'This agent is no longer registered.': 'Этот агент больше не зарегистрирован.',
  'Agents that ship with PiUI cannot be removed or re-trusted.': 'Агентов, поставляемых с PiUI, нельзя удалить или доверить заново.',
  'The agent or its command line changed since you reviewed it. Review it again.':
    'Агент или его командная строка изменились после вашей проверки. Проверьте ещё раз.',
  'The program was not found, so there is nothing to trust yet.': 'Программа не найдена, доверять пока нечему.',
  'There is nothing to confirm for this agent right now. Check it again.': 'Сейчас для этого агента нечего подтверждать. Проверьте его снова.',
  'Remove an agent before adding another (32 at most).': 'Удалите агента, прежде чем добавить нового (не больше 32).',
  'PiUI could not save the harness list.': 'PiUI не удалось сохранить список харнесов.',
  'PiUI could not read the harness list.': 'PiUI не удалось прочитать список харнесов.',
  'Wait for the current harness change to finish.': 'Дождитесь завершения текущего изменения харнесов.',

  // Descriptor validation (host AcpDescriptorError and the form).
  'The descriptor is not valid JSON or contains unknown fields.': 'Описание не является корректным JSON или содержит неизвестные поля.',
  'The descriptor is larger than 32 KiB.': 'Описание больше 32 КиБ.',
  'Only ACP descriptor schema version 1 is supported.': 'Поддерживается только версия 1 схемы описания ACP.',
  'The display name must be 1-64 characters without control characters.': 'Имя должно содержать 1–64 символа без управляющих символов.',
  'The program must be a file name found on PATH or an absolute path.': 'Программа должна быть именем файла из PATH или абсолютным путём.',
  'Use at most 32 arguments of 1-512 characters without control characters.':
    'Используйте не больше 32 аргументов по 1–512 символов без управляющих символов.',
  'Use 1-8 version arguments of 1-512 characters without control characters.':
    'Используйте 1–8 аргументов версии по 1–512 символов без управляющих символов.',
  'The version pattern must be a valid regular expression of at most 200 characters.':
    'Шаблон версии должен быть корректным регулярным выражением длиной не больше 200 символов.',
  'The verified range needs MAJOR.MINOR.PATCH versions with the minimum below the ceiling.':
    'Для проверенного диапазона нужны версии MAJOR.MINOR.PATCH, причём минимум меньше верхней границы.',
  'Environment variables must be at most 32 unique names of letters, digits and underscores.':
    'Переменных окружения может быть не больше 32; имена уникальны и состоят из букв, цифр и подчёркиваний.',
  'This environment variable cannot be passed to an agent.': 'Эту переменную окружения нельзя передать агенту.',
  'The sign-in hint must be at most 400 characters without control characters.':
    'Подсказка для входа — не больше 400 символов без управляющих символов.',
  'The documentation link must be an https URL of at most 300 characters.': 'Ссылка на документацию должна быть адресом https длиной не больше 300 символов.',
  'A descriptor can only switch agent features off.': 'Описание может только отключать возможности агента.',
  'The ID must be 1-32 lowercase letters, digits and single inner hyphens.':
    'ID должен содержать 1–32 строчные латинские буквы, цифры и одиночные дефисы внутри.',
  'This descriptor has values the form cannot show. Keep editing it as JSON.':
    'В описании есть значения, которые форма не может показать. Продолжайте редактировать его как JSON.',

  // Trust, secrets and add dialogs.
  'Trust {0}?': 'Доверить {0}?',
  'PiUI will start exactly this command, without a shell. Review it before you trust it.':
    'PiUI запустит именно эту команду, без оболочки. Проверьте её, прежде чем доверить.',
  'Command line': 'Командная строка',
  Arguments: 'Аргументы',
  None: 'Нет',
  'Environment variables': 'Переменные окружения',
  'PiUI passes these names from your environment. It never reads, shows or stores their values.':
    'PiUI передаёт эти имена из вашего окружения. Их значения PiUI никогда не читает, не показывает и не хранит.',
  'Secret-like names ({0}) pass only after you allow them separately.':
    'Имена, похожие на секреты ({0}), передаются только после отдельного разрешения.',
  'Only the basic environment (locations, locale and PATH). No keys or tokens.':
    'Только базовое окружение (расположения, язык и PATH). Никаких ключей и токенов.',
  'Trust is not a sandbox. The agent runs with your user account’s permissions and keeps its own tools, network access and credentials. PiUI runs this command now to read its version, and later to start chats.':
    'Доверие — не песочница. Агент работает с правами вашей учётной записи и сохраняет свои инструменты, доступ к сети и учётные данные. PiUI запустит эту команду сейчас, чтобы узнать версию, а позже — чтобы начинать чаты.',
  'Descriptor fingerprint: {0}': 'Отпечаток описания: {0}',
  'Review the current command': 'Проверить текущую команду',
  'Trust this command': 'Доверить эту команду',
  'Secret variables for {0}': 'Секретные переменные для {0}',
  'When the agent starts, PiUI passes the value of each selected variable from your environment. PiUI never reads, shows or stores the values. Leave a variable unselected to keep it from the agent.':
    'При запуске агента PiUI передаёт значение каждой выбранной переменной из вашего окружения. Значения PiUI никогда не читает, не показывает и не хранит. Не отмечайте переменную, чтобы не передавать её агенту.',
  'Pass to the agent': 'Передавать агенту',
  'Add ACP agent': 'Добавить ACP-агента',
  'Describe how to start an agent that speaks the Agent Client Protocol. PiUI runs nothing until you review and trust its command line.':
    'Опишите, как запускать агента, работающего по Agent Client Protocol. PiUI ничего не запустит, пока вы не проверите и не доверите его командную строку.',
  'Descriptor input': 'Способ ввода описания',
  Form: 'Форма',
  JSON: 'JSON',
  'Agent ID': 'ID агента',
  'Lowercase letters, digits and hyphens, for example qwen-code. Chats and pipelines use it as acp:<ID>.':
    'Строчные латинские буквы, цифры и дефисы, например qwen-code. Чаты и пайплайны используют его как acp:<ID>.',
  'A program name found on PATH or an absolute path. PiUI never uses a shell.':
    'Имя программы из PATH или абсолютный путь. PiUI никогда не использует оболочку.',
  'One argument per line, for example --experimental-acp.': 'По одному аргументу в строке, например --experimental-acp.',
  'Version arguments': 'Аргументы версии',
  'One per line; the program prints its version with them.': 'По одному в строке; с ними программа печатает свою версию.',
  'Version pattern': 'Шаблон версии',
  'A regular expression whose first group is the version.': 'Регулярное выражение, первая группа которого — версия.',
  'Tested from version': 'Проверено начиная с версии',
  'MAJOR.MINOR.PATCH, included.': 'MAJOR.MINOR.PATCH, включительно.',
  'Tested below version': 'Проверено до версии',
  'MAJOR.MINOR.PATCH, excluded. Other versions need your confirmation.':
    'MAJOR.MINOR.PATCH, не включая. Другие версии потребуют вашего подтверждения.',
  'Names only, one per line. Values stay in your environment; names such as API keys pass only after you allow them.':
    'Только имена, по одному в строке. Значения остаются в вашем окружении; имена вроде API-ключей передаются только после вашего разрешения.',
  'Sign-in hint': 'Подсказка для входа',
  'How to sign in with the agent’s own app. Never paste a key or token here.':
    'Как войти через приложение самого агента. Никогда не вставляйте сюда ключ или токен.',
  'Documentation link': 'Ссылка на документацию',
  'Switch off agent features': 'Отключить возможности агента',
  'Never reload a conversation with session/load.': 'Никогда не загружать разговор заново через session/load.',
  'Ignore the models the agent advertises.': 'Игнорировать модели, которые объявляет агент.',
  'Ignore the modes the agent advertises.': 'Игнорировать режимы, которые объявляет агент.',
  'Never offer PiUI’s workspace tool as an HTTP MCP server.': 'Никогда не предлагать инструмент рабочей области PiUI как HTTP MCP-сервер.',
  'Descriptor JSON': 'JSON описания',
  'ACP agent descriptor v1. Unknown fields are rejected, never dropped.':
    'Описание ACP-агента v1. Неизвестные поля отклоняются, а не отбрасываются.',

  // Chat details: agent-advertised session modes.
  Mode: 'Режим',
  'Agent mode': 'Режим агента',
  'Unknown mode': 'Неизвестный режим',

  // Starting an ACP chat (workspace errors).
  'Review and trust this agent in Settings → Harnesses before starting it.':
    'Перед запуском проверьте этого агента и доверьте его в «Настройки → Харнесы».',
  "Confirm this agent's version in Settings → Harnesses before starting it.":
    'Перед запуском подтвердите версию этого агента в «Настройки → Харнесы».',
  'Sign in to this agent with its own app, then try again. Settings → Harnesses shows how.':
    'Войдите в этого агента через его собственное приложение и попробуйте снова. Как это сделать — в «Настройки → Харнесы».',
};
