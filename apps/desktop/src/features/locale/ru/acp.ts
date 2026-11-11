/** Russian UI copy for ACP agents. Keys are the English source strings. */
export const acpRu: Readonly<Record<string, string>> = {
  // Generic ACP adapter manifest (src/harness-adapters/acp.ts).
  'ACP agent': 'ACP-агент',
  'The agent keeps its own permission, tool and MCP settings. Nano Desktop answers its permission requests but cannot restrict its tools or files.':
    'Агент сам управляет своими разрешениями, инструментами и MCP. Nano Desktop отвечает на его запросы разрешений, но не может ограничить его инструменты или файлы.',
  'Instructions are sent with the first message; the agent keeps its own system prompt.':
    'Инструкции отправляются с первым сообщением; агент сохраняет свой системный промпт.',

  // Settings → Harnesses (src/app/settings).
  'Safe mode: Nano Desktop starts no agent program, so harness checks and changes are off.':
    'Безопасный режим: Nano Desktop не запускает программы агентов, поэтому проверки и изменения харнесов отключены.',
  'Loading harnesses…': 'Загрузка харнесов…',
  'Built-in harnesses': 'Встроенные харнесы',
  Location: 'Расположение',
  'Tested with Nano Desktop': 'Проверено с Nano Desktop',
  'Sign-in': 'Вход',
  'ACP agents': 'ACP-агенты',
  'Add ACP agent…': 'Добавить ACP-агента…',
  'Agents that speak the Agent Client Protocol. Nano Desktop starts only the exact command line you trust, never through a shell. Trust is not a sandbox: an agent runs with your permissions.':
    'Агенты, работающие по Agent Client Protocol. Nano Desktop запускает только ту командную строку, которой вы доверили, и никогда через оболочку. Доверие — не песочница: агент работает с вашими правами.',
  'Remove {0}?': 'Удалить {0}?',
  'Remove agent': 'Удалить агента',
  'Nano Desktop forgets this descriptor and your decisions about it. Chats with this agent keep their history but cannot start until you add it again.':
    'Nano Desktop забудет это описание и ваши решения о нём. Чаты с этим агентом сохранят историю, но не запустятся, пока вы не добавите его снова.',
  'Not checked': 'Не проверено',
  'Not installed': 'Не установлен',
  'Unsupported version': 'Неподдерживаемая версия',
  'Unverified version': 'Непроверенная версия',
  'Newer than tested': 'Новее проверенных версий',
  'Untested version': 'Версия не проверялась',
  'Version unknown': 'Версия не определена',
  'Sign-in required': 'Нужен вход',
  'Needs review': 'Нужна проверка',
  '{0}, tested with Nano Desktop': '{0}, проверена с Nano Desktop',
  '{0}, newer than the versions tested with Nano Desktop': '{0}, новее версий, проверенных с Nano Desktop',
  '{0}, not verified by Nano Desktop': '{0}, не проверена Nano Desktop',
  '{0}, older than the versions tested with Nano Desktop': '{0}, старше версий, проверенных с Nano Desktop',
  'The version output was not recognized': 'Вывод версии не распознан',
  'The version check did not finish': 'Проверка версии не завершилась',
  'Ships with Nano Desktop': 'Поставляется с Nano Desktop',
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
  'Nano Desktop coordination tool': 'Инструмент координации Nano Desktop',
  Documentation: 'Документация',
  'Review and trust…': 'Проверить и доверить…',
  'Secret variables…': 'Секретные переменные…',

  // Registry readiness reasons and sign-in hints (host fixed texts).
  'Checking this agent…': 'Проверка агента…',
  "The agent's program was not found on PATH.": 'Программа агента не найдена в PATH.',
  "The agent's program path does not exist.": 'Путь к программе агента не существует.',
  'This launcher needs a shell, which Nano Desktop never uses. Point the descriptor at the executable or the Node script.':
    'Этому загрузчику нужна оболочка, а Nano Desktop никогда её не использует. Укажите в описании исполняемый файл или скрипт Node.',
  'Node.js is needed to start this agent but was not found.': 'Для запуска этого агента нужен Node.js, но он не найден.',
  "Review and trust this agent's command line in Settings → Harnesses.":
    'Проверьте командную строку этого агента и доверьте её в «Настройки → Харнесы».',
  'The installed version is older than the versions tested with Nano Desktop.': 'Установленная версия старше версий, проверенных с Nano Desktop.',
  'The agent did not report a version Nano Desktop can recognize.': 'Агент не сообщил версию, которую Nano Desktop может распознать.',
  "Sign in with the agent's own app, then try again. Settings → Harnesses shows how.":
    'Войдите через приложение самого агента и попробуйте снова. Как это сделать — в «Настройки → Харнесы».',
  'This agent is no longer registered in Settings → Harnesses.': 'Этот агент больше не зарегистрирован в «Настройки → Харнесы».',
  'Claude Code runs only on your Claude subscription: run `claude` in a terminal and use /login.':
    'Claude Code работает только по вашей подписке Claude: запустите `claude` в терминале и выполните /login.',
  "Sign in with Codex's own flow: run `codex login` in a terminal.": 'Войдите средствами Codex: выполните `codex login` в терминале.',
  "Sign in with Gemini CLI's own flow: run `gemini` in a terminal and choose a sign-in method. To use an API key instead, allow PiUI to pass GEMINI_API_KEY below.":
    'Войдите средствами Gemini CLI: запустите `gemini` в терминале и выберите способ входа. Чтобы вместо этого использовать API-ключ, разрешите Nano Desktop передавать GEMINI_API_KEY ниже.',
  "Sign in with OpenCode's own flow: run `opencode auth login` in a terminal. To use a provider API key instead, allow PiUI to pass it below.":
    'Войдите средствами OpenCode: выполните `opencode auth login` в терминале. Чтобы вместо этого использовать API-ключ провайдера, разрешите Nano Desktop передать его ниже.',
  "Sign in with Qwen Code's own flow: run `qwen` in a terminal and use /auth. To use an API key instead, allow PiUI to pass DASHSCOPE_API_KEY or OPENAI_API_KEY below.":
    'Войдите средствами Qwen Code: запустите `qwen` в терминале и выполните /auth. Чтобы вместо этого использовать API-ключ, разрешите Nano Desktop передавать DASHSCOPE_API_KEY или OPENAI_API_KEY ниже.',
  "Sign in with Copilot's own flow: run `copilot` in a terminal and use /login. To use a token instead, allow PiUI to pass COPILOT_GITHUB_TOKEN below.":
    'Войдите средствами Copilot: запустите `copilot` в терминале и выполните /login. Чтобы вместо этого использовать токен, разрешите Nano Desktop передавать COPILOT_GITHUB_TOKEN ниже.',
  "Set up Goose's own provider: run `goose configure` in a terminal and choose a provider and model.":
    'Настройте провайдера средствами Goose: выполните `goose configure` в терминале и выберите провайдера и модель.',
  "Sign in with Kimi Code's own flow: run `kimi` in a terminal and use /login.":
    'Войдите средствами Kimi Code: запустите `kimi` в терминале и выполните /login.',
  "Sign in with Cursor's own flow: run `cursor-agent login` in a terminal. To use an API key instead, allow PiUI to pass CURSOR_API_KEY below.":
    'Войдите средствами Cursor: выполните `cursor-agent login` в терминале. Чтобы вместо этого использовать API-ключ, разрешите Nano Desktop передавать CURSOR_API_KEY ниже.',

  // Native harness refusals (host fixed texts).
  'The installed native harness version is not supported by this adapter.': 'Установленная версия агента не поддерживается этим адаптером.',
  'Native lifecycle containment is not yet verified on this platform.':
    'Завершение процессов агента на этой платформе ещё не проверено.',
  'The installed harness speaks a protocol this Nano Desktop version does not support. Update Nano Desktop or the harness.':
    'Установленный harness использует протокол, который эта версия Nano Desktop не поддерживает. Обновите Nano Desktop или harness.',

  // Registry errors (harness_registry_v1).
  'Harness checks and changes are disabled in safe mode.': 'В безопасном режиме проверки и изменения харнесов отключены.',
  'The harness list changed. Review it and try again.': 'Список харнесов изменился. Проверьте его и попробуйте снова.',
  'An agent with this ID already exists.': 'Агент с таким ID уже существует.',
  'This agent is no longer registered.': 'Этот агент больше не зарегистрирован.',
  'Agents that ship with Nano Desktop cannot be removed or re-trusted.': 'Агентов, поставляемых с Nano Desktop, нельзя удалить или доверить заново.',
  'The agent or its command line changed since you reviewed it. Review it again.':
    'Агент или его командная строка изменились после вашей проверки. Проверьте ещё раз.',
  'The program was not found, so there is nothing to trust yet.': 'Программа не найдена, доверять пока нечему.',
  'There is nothing to confirm for this agent right now. Check it again.': 'Сейчас для этого агента нечего подтверждать. Проверьте его снова.',
  'Remove an agent before adding another (32 at most).': 'Удалите агента, прежде чем добавить нового (не больше 32).',
  'Nano Desktop could not save the harness list.': 'Nano Desktop не удалось сохранить список харнесов.',
  'Nano Desktop could not read the harness list.': 'Nano Desktop не удалось прочитать список харнесов.',
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
  'Nano Desktop will start exactly this command, without a shell. Review it before you trust it.':
    'Nano Desktop запустит именно эту команду, без оболочки. Проверьте её, прежде чем доверить.',
  'Command line': 'Командная строка',
  Arguments: 'Аргументы',
  None: 'Нет',
  'Environment variables': 'Переменные окружения',
  'Nano Desktop passes these names from your environment. It never reads, shows or stores their values.':
    'Nano Desktop передаёт эти имена из вашего окружения. Их значения Nano Desktop никогда не читает, не показывает и не хранит.',
  'Secret-like names ({0}) pass only after you allow them separately.':
    'Имена, похожие на секреты ({0}), передаются только после отдельного разрешения.',
  'Only the basic environment (locations, locale and PATH). No keys or tokens.':
    'Только базовое окружение (расположения, язык и PATH). Никаких ключей и токенов.',
  'Trust is not a sandbox. The agent runs with your user account’s permissions and keeps its own tools, network access and credentials. Nano Desktop runs this command now to read its version, and later to start chats.':
    'Доверие — не песочница. Агент работает с правами вашей учётной записи и сохраняет свои инструменты, доступ к сети и учётные данные. Nano Desktop запустит эту команду сейчас, чтобы узнать версию, а позже — чтобы начинать чаты.',
  'Trust covers this command line; newer versions start without asking again.':
    'Доверие относится к этой командной строке; более новые версии запускаются без повторного вопроса.',
  'Descriptor fingerprint: {0}': 'Отпечаток описания: {0}',
  'Review the current command': 'Проверить текущую команду',
  'Trust this command': 'Доверить эту команду',
  'Secret variables for {0}': 'Секретные переменные для {0}',
  'When the agent starts, Nano Desktop passes the value of each selected variable from your environment. Nano Desktop never reads, shows or stores the values. Leave a variable unselected to keep it from the agent.':
    'При запуске агента Nano Desktop передаёт значение каждой выбранной переменной из вашего окружения. Значения Nano Desktop никогда не читает, не показывает и не хранит. Не отмечайте переменную, чтобы не передавать её агенту.',
  'Pass to the agent': 'Передавать агенту',
  'Add ACP agent': 'Добавить ACP-агента',
  'Describe how to start an agent that speaks the Agent Client Protocol. Nano Desktop runs nothing until you review and trust its command line.':
    'Опишите, как запускать агента, работающего по Agent Client Protocol. Nano Desktop ничего не запустит, пока вы не проверите и не доверите его командную строку.',
  'Descriptor input': 'Способ ввода описания',
  Form: 'Форма',
  JSON: 'JSON',
  'Agent ID': 'ID агента',
  'Lowercase letters, digits and hyphens, for example qwen-code. Chats and pipelines use it as acp:<ID>.':
    'Строчные латинские буквы, цифры и дефисы, например qwen-code. Чаты и пайплайны используют его как acp:<ID>.',
  'A program name found on PATH or an absolute path. Nano Desktop never uses a shell.':
    'Имя программы из PATH или абсолютный путь. Nano Desktop никогда не использует оболочку.',
  'One argument per line, for example --experimental-acp.': 'По одному аргументу в строке, например --experimental-acp.',
  'Version arguments': 'Аргументы версии',
  'One per line; the program prints its version with them.': 'По одному в строке; с ними программа печатает свою версию.',
  'Version pattern': 'Шаблон версии',
  'A regular expression whose first group is the version.': 'Регулярное выражение, первая группа которого — версия.',
  'Tested from version': 'Проверено начиная с версии',
  'MAJOR.MINOR.PATCH, included.': 'MAJOR.MINOR.PATCH, включительно.',
  'Tested below version': 'Проверено до версии',
  'MAJOR.MINOR.PATCH, excluded. Newer versions start with a notice.':
    'MAJOR.MINOR.PATCH, не включая. Более новые версии запускаются с пометкой.',
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
  'Never offer Nano Desktop’s workspace tool as an HTTP MCP server.': 'Никогда не предлагать инструмент рабочей области Nano Desktop как HTTP MCP-сервер.',
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
