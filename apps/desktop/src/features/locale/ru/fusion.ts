/** Russian UI copy for Fusion, the lead + sidekick pair (ADR-043). Keys are the English source strings. */
export const fusionRu: Readonly<Record<string, string>> = {
  // New-chat composer
  'Chat type': 'Тип чата',
  'One agent answers you': 'Вам отвечает один агент',
  'A lead agent and a sidekick work as a pair': 'Ведущий агент и напарник работают в паре',
  'The pair cannot start': 'Пара не может начать работу',
  'The Fusion chat started, but the first message was not sent': 'Чат Fusion создан, но первое сообщение не отправлено',
  'Fusion pair': 'Пара Fusion',
  'The lead chats with you and hands work to a sidekick that keeps its own context between briefs.':
    'Ведущий общается с вами и передаёт работу напарнику, который сохраняет свой контекст между поручениями.',
  Lead: 'Ведущий',
  Sidekick: 'Напарник',
  'Fusion needs Claude Code or Codex as the lead. Install and sign in to one of them.':
    'Для Fusion ведущим должен быть Claude Code или Codex. Установите один из них и войдите в аккаунт.',
  'Checking the pair…': 'Проверяем пару…',
  'This pair can start.': 'Эта пара может начать работу.',
  'This pair cannot start yet. See the highlighted role.': 'Эта пара пока не может начать работу. Смотрите выделенную роль.',
  'Pair options': 'Параметры пары',
  'Brief detail': 'Подробность поручений',
  Prescriptive: 'Подробно',
  'The lead spells out each step; fewer rounds of rework.': 'Ведущий расписывает каждый шаг; меньше раундов доработки.',
  Outline: 'Набросок',
  'The lead states the goal; the sidekick decides the details.': 'Ведущий ставит цель; детали решает напарник.',
  'Sidekick may push back on a brief': 'Напарник может возражать против поручения',
  'Deliver reports to the lead automatically': 'Автоматически передавать отчёты ведущему',
  'Lead may also use its own subagents': 'Ведущий может использовать и своих субагентов',
  'Not available': 'Недоступно',

  // Refusals of a pair
  'This harness cannot lead a Fusion chat.': 'Этот харнес не может вести чат Fusion.',
  'Choose Claude Code or Codex as the lead.': 'Выберите ведущим Claude Code или Codex.',
  'This harness cannot be the sidekick.': 'Этот харнес не может быть напарником.',
  'Choose Claude Code, Codex or Pi as the sidekick.': 'Выберите напарником Claude Code, Codex или Pi.',
  'Both roles need a concrete permission mode.': 'Обеим ролям нужен конкретный режим прав.',
  'A pair cannot rely on "Harness settings": pick Read only, Edit project or Full access for the lead and the sidekick.':
    'Пара не может опираться на «Настройки харнеса»: выберите для ведущего и напарника «Только чтение», «Правка проекта» или «Полный доступ».',
  'The sidekick would be allowed more than the lead.': 'Напарнику разрешено больше, чем ведущему.',
  'Lower the sidekick permissions or raise the lead permissions.': 'Снизьте права напарника или повысьте права ведущего.',
  'This sidekick can only run with full access.': 'Этот напарник работает только с полным доступом.',
  'Claude Code cannot answer its own command approvals in Edit project mode, and Pi has no edit-only mode. Use Full access (or Native with a Claude Code lead), or choose another sidekick.':
    'Claude Code в режиме «Правка проекта» не может отвечать на запросы одобрения команд, а у Pi нет режима только правки. Выберите «Полный доступ» (или «Нативный» при ведущем Claude Code) либо другого напарника.',
  'The Codex sandbox could not be verified on this computer.': 'Не удалось проверить песочницу Codex на этом компьютере.',
  'Choose another harness for this role, or use Full access if you accept that.':
    'Выберите для этой роли другой харнес или «Полный доступ», если вы с этим согласны.',
  'A read-only lead cannot review or take over the sidekick work.': 'Ведущий только для чтения не может проверять работу напарника или забирать её себе.',
  'Give the lead at least the Edit project permission.': 'Дайте ведущему хотя бы право «Правка проекта».',

  // Errors
  'Safe mode is on, so Fusion cannot change anything. Restart PiUI without safe mode.':
    'Включён безопасный режим, поэтому Fusion ничего не может менять. Перезапустите PiUI без безопасного режима.',
  'The host did not accept this request.': 'Хост не принял этот запрос.',
  'This Fusion chat or round no longer exists.': 'Этого чата Fusion или раунда больше нет.',
  'The state changed meanwhile. Try again.': 'Состояние изменилось. Повторите попытку.',
  'This action is not available here.': 'Это действие здесь недоступно.',
  'The host could not save the Fusion state.': 'Хост не смог сохранить состояние Fusion.',
  'Sign in to the harness first, then try again.': 'Сначала войдите в харнес, затем повторите попытку.',
  'The Fusion action could not be completed.': 'Не удалось выполнить действие Fusion.',
  'The Fusion action failed': 'Действие Fusion не выполнено',

  // Sidekick, round, brief and delivery states
  'not started': 'не запущен',
  idle: 'свободен',
  working: 'работает',
  'waiting for approval': 'ждёт одобрения',
  stopping: 'останавливается',
  unavailable: 'недоступен',
  queued: 'в очереди',
  finished: 'завершён',
  completed: 'выполнен',
  interrupted: 'прерван',
  'no answer': 'без ответа',
  done: 'готово',
  partial: 'частично',
  blocked: 'заблокировано',
  'needs a decision': 'нужно решение',
  'status unknown': 'статус неизвестен',
  active: 'активно',
  reported: 'есть отчёт',
  closed: 'закрыто',
  stopped: 'остановлено',
  rejected: 'отклонено',
  superseded: 'заменено',
  'report queued': 'отчёт в очереди',
  'report being delivered': 'отчёт доставляется',
  'report delivered': 'отчёт доставлен',
  'delivery uncertain': 'доставка не подтверждена',
  'report withdrawn': 'отчёт отозван',
  report: 'отчёт',
  status: 'статус',
  refused: 'отказ',
  sent: 'отправлено',
  shortened: 'сокращён',

  // Header badge and panel
  'Fusion pair, sidekick {0} {1}. Open details.': 'Пара Fusion, напарник {0}: {1}. Открыть подробности.',
  'Fusion pair, state unavailable. Open details.': 'Пара Fusion, состояние недоступно. Открыть подробности.',
  'Fusion pair, loading. Open details.': 'Пара Fusion, загрузка. Открыть подробности.',
  'Sidekick {0}: {1}': 'Напарник {0}: {1}',
  Pair: 'Пара',
  Statistics: 'Статистика',
  Briefs: 'Поручения',
  Accepted: 'Принято',
  Rejected: 'Отклонено',
  'Taken over': 'Забрано ведущим',
  Rounds: 'Раунды',
  'Pair actions': 'Действия с парой',
  'Stop sidekick': 'Остановить напарника',
  'Stop pair': 'Остановить пару',
  'Reset sidekick…': 'Сбросить напарника…',
  'Stop sidekick interrupts its current round. Stop pair also stops the lead. Reset retires the sidekick context; the next brief starts a fresh one.':
    'Остановка напарника прерывает его текущий раунд. Остановка пары останавливает и ведущего. Сброс закрывает контекст напарника; следующее поручение начнёт новый.',
  'Fusion actions are disabled in safe mode.': 'В безопасном режиме действия Fusion отключены.',
  'Loading the pair…': 'Загружаем пару…',
  'No briefs yet. The lead sends one when it delegates work.': 'Поручений пока нет. Ведущий отправит его, когда делегирует работу.',
  Brief: 'Поручение',
  'Follow-up': 'Уточнение',
  'PiUI could not tell how this round ended. Check the sidekick conversation, then reconcile it or abandon it.':
    'PiUI не смог определить, чем закончился этот раунд. Проверьте беседу напарника, затем сверьте раунд или откажитесь от него.',
  Reconcile: 'Сверить',
  'Abandon…': 'Отказаться…',
  'Show fewer briefs': 'Показать меньше поручений',
  'Show all {0} briefs': 'Показать все поручения ({0})',
  'Sidekick sessions': 'Сессии напарника',
  Retired: 'Закрыта',
  Current: 'Текущая',
  'Open the sidekick conversation ({0})': 'Открыть беседу напарника ({0})',
  'The sidekick conversation is read-only: the lead gives it work through briefs.':
    'Беседа напарника доступна только для чтения: ведущий даёт ему работу через поручения.',

  // Confirmations
  'Abandon this round?': 'Отказаться от этого раунда?',
  'The round is closed without a verified report. Files the sidekick already changed stay as they are. This cannot be undone.':
    'Раунд будет закрыт без подтверждённого отчёта. Файлы, которые напарник уже изменил, останутся как есть. Отменить это нельзя.',
  'Abandon round': 'Отказаться от раунда',
  'Reset the sidekick?': 'Сбросить напарника?',
  'The current sidekick conversation is retired and stays readable. The next brief starts a fresh sidekick with an empty context, so it will not remember earlier briefs.':
    'Текущая беседа напарника закрывается, но остаётся доступной для чтения. Следующее поручение запустит нового напарника с пустым контекстом, он не будет помнить прежние поручения.',
  'Reset sidekick': 'Сбросить напарника',

  'Project: {0}': 'Проект: {0}',
  'Fusion roles take their permissions from the pair picker, not from this menu.':
    'Права ролей Fusion задаются в выборе пары, а не в этом меню.',

  // Sidekick chat and lead notices
  'the lead chat': 'чат ведущего',
  'Read-only: the lead gives the sidekick its work through briefs.': 'Только чтение: ведущий даёт напарнику работу через поручения.',
  'Sidekick of {0}. Read-only.': 'Напарник чата «{0}». Только чтение.',
  'Sidekick of {0}': 'Напарник чата «{0}»',
  'Open lead chat': 'Открыть чат ведущего',
  'This is the sidekick of a Fusion chat. Its lead gives it work through briefs, so you cannot message it here. Talk to the lead chat instead.':
    'Это напарник чата Fusion. Ведущий даёт ему работу через поручения, поэтому писать ему здесь нельзя. Общайтесь с чатом ведущего.',
  'This harness could not take the sidekick tool, so the lead cannot delegate to its sidekick in this chat.':
    'Этот харнес не смог принять инструмент напарника, поэтому ведущий не может делегировать работу напарнику в этом чате.',
  'This resumed chat was started without the sidekick tool, so the lead cannot delegate. Start a new Fusion chat to work as a pair.':
    'Этот возобновлённый чат был начат без инструмента напарника, поэтому ведущий не может делегировать. Начните новый чат Fusion, чтобы работать в паре.',

  // Sidekick tool cards in the transcript
  'Sidekick call': 'Вызов напарника',
  'Brief {0}': 'Поручение {0}',
  'Round {0}': 'Раунд {0}',
  'Page {0} of {1}': 'Страница {0} из {1}',
};
