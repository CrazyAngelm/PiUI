/** Russian UI copy for triggers, tray and autostart. Keys are the English source strings. */
export const triggersRu: Readonly<Record<string, string>> = {
  // Automation cadence and previews
  'When {0} succeeds': 'Когда «{0}» завершится успешно',
  'When {0} fails': 'Когда «{0}» завершится с ошибкой',
  'When {0} is stopped': 'Когда «{0}» будет остановлен',
  'When {0} succeeds or fails': 'Когда «{0}» завершится успешно или с ошибкой',
  'When {0} succeeds or is stopped': 'Когда «{0}» завершится успешно или будет остановлен',
  'When {0} fails or is stopped': 'Когда «{0}» завершится с ошибкой или будет остановлен',
  'When {0} finishes': 'Когда «{0}» завершится',
  'When files change': 'Когда меняются файлы',
  'When {0} and {1} more change': 'Когда меняются {0} и ещё {1}',
  'When {0} changes': 'Когда меняется {0}',
  '{0}, PiUI starts {1}.': '{0}, PiUI запустит «{1}».',
  'PiUI starts {0} {1} s after matching files stop changing.': 'PiUI запустит «{0}» через {1} с после того, как подходящие файлы перестанут меняться.',
  'Ignored: {0}': 'Не учитываются: {0}',
  'Changes made while its own run works are ignored. .git, node_modules, target and dist are never watched.':
    'Изменения во время её собственного запуска не учитываются. За .git, node_modules, target и dist PiUI не следит.',
  'At most one run every {0} s. A chain of automations stops after {1} automatic runs.':
    'Не чаще одного запуска в {0} с. Цепочка автоматизаций останавливается после {1} автоматических запусков.',
  'Skipped: PiUI was closed or paused': 'Пропущено: PiUI был закрыт или на паузе',
  'Skipped: too many chained automations': 'Пропущено: слишком длинная цепочка автоматизаций',
  'Skipped: ran moments ago': 'Пропущено: запуск был только что',
  'Skipped: automations paused': 'Пропущено: автоматизации на паузе',

  // File patterns
  'Enter a pattern.': 'Введите шаблон.',
  'Keep each pattern under 256 characters.': 'Шаблон должен быть короче 256 символов.',
  'Patterns cannot contain control characters.': 'Шаблоны не могут содержать управляющие символы.',
  'Use / between folders.': 'Разделяйте папки символом /.',
  'Use a path inside the project folder, without a drive, / or ~ at the start.': 'Укажите путь внутри папки проекта — без диска, / или ~ в начале.',
  'Remove ./ and ../ from the pattern.': 'Уберите ./ и ../ из шаблона.',
  'Remove the empty folder name (//).': 'Уберите пустое имя папки (//).',
  'Use ** as a whole folder name, as in src/**/*.ts.': 'Используйте ** как отдельное имя папки, например src/**/*.ts.',
  'Close each [ ] character class and keep it non-empty.': 'Закройте каждый класс символов [ ] и не оставляйте его пустым.',
  'Use {a,b} with at least two non-empty choices, without nesting or /.': 'Используйте {a,b} минимум с двумя непустыми вариантами, без вложенности и /.',
  'Add at least one file pattern.': 'Добавьте хотя бы один шаблон файлов.',
  'Use at most {0} patterns in each list.': 'Не больше {0} шаблонов в каждом списке.',
  'Pattern “{0}”: {1}': 'Шаблон «{0}»: {1}',
  'Choose the pipeline to wait for.': 'Выберите пайплайн, завершения которого ждать.',
  'Choose at least one result.': 'Выберите хотя бы один результат.',
  'Wait between {0} and {1} seconds.': 'Ожидание — от {0} до {1} секунд.',

  // Automations list
  'Start saved pipelines on a schedule or after an event. They run while PiUI is open or in the tray.':
    'Запускайте сохранённые пайплайны по расписанию или после события. Они работают, пока PiUI открыт или в трее.',
  'Pause all': 'Приостановить все',
  'All automations are paused. Nothing starts until you resume them.': 'Все автоматизации на паузе. Ничего не запустится, пока вы их не возобновите.',
  'Resume automations': 'Возобновить автоматизации',
  'Run a pipeline every morning, when another pipeline finishes or when project files change.':
    'Запускайте пайплайн каждое утро, после завершения другого пайплайна или при изменении файлов проекта.',
  'Watching project files': 'Следит за файлами проекта',
  'Waiting for {0} to finish': 'Ждёт завершения «{0}»',
  'Turn it on to react to events.': 'Включите, чтобы реагировать на события.',

  // Automation dialog
  'Runs a saved pipeline on a schedule or after an event while PiUI is open or in the tray.':
    'Запускает сохранённый пайплайн по расписанию или после события, пока PiUI открыт или в трее.',
  'Pipeline to run': 'Какой пайплайн запускать',
  'On a schedule': 'По расписанию',
  'After an event': 'После события',
  Event: 'Событие',
  'When a pipeline finishes': 'Когда пайплайн завершится',
  'Pipeline to wait for': 'Какого пайплайна ждать',
  'Start when that pipeline': 'Запускать, когда этот пайплайн',
  Succeeds: 'завершится успешно',
  Fails: 'завершится с ошибкой',
  'Is stopped': 'будет остановлен',
  'This automation starts the pipeline it waits for, so each run can start the next one. The chain stops after 3 automatic runs.':
    'Эта автоматизация запускает тот же пайплайн, которого ждёт, поэтому каждый запуск может начать следующий. Цепочка остановится после 3 автоматических запусков.',
  'Files to watch': 'За какими файлами следить',
  'One pattern per line, relative to the project folder. src/**/*.ts matches TypeScript files under src; *.md matches Markdown files in any folder.':
    'По одному шаблону на строку, относительно папки проекта. src/**/*.ts — файлы TypeScript в src; *.md — файлы Markdown в любой папке.',
  Ignore: 'Не учитывать',
  'Wait until files are quiet for': 'Ждать, пока файлы не меняются',
  '2 to 3600 seconds. Changes during the wait start one run together.': 'От 2 до 3600 секунд. Все изменения за это время дают один запуск.',
  seconds: 'секунд',
  'If PiUI was closed or paused at that time': 'Если PiUI был закрыт или на паузе в это время',
  'Automations run only while PiUI is open or in the tray; they do not wake the computer. Each run uses your harness subscriptions like a manual run.':
    'Автоматизации работают, только пока PiUI открыт или в трее; компьютер они не будят. Каждый запуск расходует подписки харнесов, как ручной запуск.',
  'the pipeline': 'пайплайн',

  // Run trigger label
  'Started by {0}': 'Запущено автоматизацией «{0}»',
  'Started by {0} after run': 'Запущено автоматизацией «{0}» после запуска',
  'Open run {0}': 'Открыть запуск {0}',
  'Started by {0} when files changed': 'Запущено автоматизацией «{0}» после изменения файлов',
  'chained run {0} of {1}': 'звено цепочки {0} из {1}',
  'Started from a chat': 'Запущено из чата',

  // Run a pipeline from a chat
  'Run a saved pipeline of this project': 'Запустить сохранённый пайплайн этого проекта',
  'Run pipeline…': 'Запустить пайплайн…',
  'Run a pipeline': 'Запустить пайплайн',
  'Open a chat in a project first, then run one of its pipelines.': 'Сначала откройте чат в проекте, затем запустите один из его пайплайнов.',
  'This project folder is missing.': 'Папка этого проекта не найдена.',
  'Trust this folder from the sidebar to run its pipelines.': 'Отметьте папку как доверенную в боковой панели, чтобы запускать её пайплайны.',
  'Run started: {0}': 'Запуск начат: {0}',
  'Follow it in Runs. This chat is not changed.': 'Следите за ним в разделе «Запуски». Этот чат не меняется.',
  'Starts a saved pipeline of {0}. The run appears in Runs; the chat is not changed.':
    'Запускает сохранённый пайплайн проекта {0}. Запуск появится в разделе «Запуски»; чат не меняется.',
  'This project has no saved pipelines yet. Build one in Pipelines first.':
    'В этом проекте пока нет сохранённых пайплайнов. Сначала создайте пайплайн в разделе «Пайплайны».',
  'Saved pipelines': 'Сохранённые пайплайны',
  'This pipeline asks for inputs on the next step.': 'На следующем шаге пайплайн попросит входные данные.',
  'Next…': 'Далее…',
  'This pipeline is no longer saved. Choose another one.': 'Этот пайплайн больше не сохранён. Выберите другой.',

  // Background mode
  Background: 'Фоновый режим',
  'Automations keep running while PiUI is in the tray. Scheduled runs can use your paid plans.':
    'Автоматизации продолжают работать, пока PiUI в трее. Запуски по расписанию могут расходовать ваши платные тарифы.',
  'Safe mode keeps background settings read-only.': 'В безопасном режиме настройки фонового режима доступны только для чтения.',
  'Keep running in the tray when the window is closed': 'Оставаться в трее после закрытия окна',
  'Closing the window hides PiUI in the tray. Quit from the tray menu stops PiUI and every agent it started.':
    'Закрытие окна сворачивает PiUI в трей. «Выйти» в меню трея останавливает PiUI и всех запущенных им агентов.',
  'Start PiUI when I sign in to Windows': 'Запускать PiUI при входе в Windows',
  'Start PiUI when I sign in': 'Запускать PiUI при входе в систему',
  'Not available in this build.': 'Недоступно в этой сборке.',
  'PiUI starts in the tray when the option above is on; otherwise it opens its window.':
    'Если включён параметр выше, PiUI запустится в трее; иначе откроется окно.',
  'Pause all automations': 'Приостановить все автоматизации',
  'Nothing starts on a schedule or after an event until you resume. Runs already working continue.':
    'Ничего не запускается по расписанию или после событий, пока вы не возобновите. Уже идущие запуски продолжаются.',
  'This change could not be applied. Nothing was changed.': 'Не удалось применить изменение. Ничего не изменено.',
  'This option is not available on this computer right now.': 'Сейчас этот параметр недоступен на этом компьютере.',
  'The setting could not be saved. Nothing was changed.': 'Не удалось сохранить настройку. Ничего не изменено.',
  'The setting could not be changed. Nothing was changed.': 'Не удалось изменить настройку. Ничего не изменено.',

  // Tray menu
  'Open PiUI': 'Открыть PiUI',
  'Quit PiUI': 'Выйти из PiUI',
  'PiUI (automations paused)': 'PiUI (автоматизации на паузе)',
};
