/** Russian UI copy for run observability. Keys are the English source strings. */
export const runsRu: Readonly<Record<string, string>> = {
  'Connection from {0} to {1}': 'Связь от «{0}» к «{1}»',
  '{0} connection from {1} to {2}': '{0}: связь от «{1}» к «{2}»',
  // Run debugging (pinned data, debug in editor, archive and delete; run debugging v1).
  'Pinned data': 'Закреплённые данные',
  Pinned: 'Закреплено',
  'From run #{0}': 'Из запуска #{0}',
  Unpin: 'Открепить',
  View: 'Показать',
  Hide: 'Скрыть',
  'This step always runs, so its pinned data is never used. Unpin it.':
    'Этот шаг выполняется всегда, поэтому его закреплённые данные не используются. Открепите их.',
  'A run started with “Use pinned data” skips this step and passes this output to the next steps.':
    'Запуск с «Использовать закреплённые данные» пропускает этот шаг и передаёт этот результат следующим шагам.',
  'Pinned data: a run with pinned data skips this step': 'Закреплённые данные: запуск с ними пропускает этот шаг',
  'This step did not run: its result is pinned data': 'Шаг не выполнялся: его результат — закреплённые данные',
  'The sample uses the pinned data of: {0}': 'Пример использует закреплённые данные шагов: {0}',
  'Use pinned data (pinned steps don’t run)': 'Использовать закреплённые данные (закреплённые шаги не выполняются)',
  'Pinned: {0}. Their pinned output goes to the next steps; nothing else is reused.':
    'Закреплены: {0}. Их закреплённый результат получат следующие шаги; всё остальное выполнится заново.',
  'Every step runs, including the pinned ones: {0}.': 'Выполнятся все шаги, включая закреплённые: {0}.',
  'Opened from a run as a new draft': 'Запуск открыт как новый черновик',
  'Saving creates a new pipeline; the saved one is not changed.': 'Сохранение создаст новый пайплайн; сохранённый не изменится.',
  'Pinned data is not exported': 'Закреплённые данные не экспортируются',
  'System files never include pinned data; the pins stay in PiUI.': 'Файлы систем не содержат закреплённых данных; они остаются в PiUI.',
  'Pinned from run #{0}, {1}.': 'Закреплено из запуска #{0}, {1}.',
  'Nothing ran: the pinned data does not match this step’s result fields, so the step failed.':
    'Ничего не выполнялось: закреплённые данные не подходят к полям результата шага, поэтому шаг завершился ошибкой.',
  'Nothing ran: this step’s result is its pinned data, passed on to the next steps.':
    'Ничего не выполнялось: результат шага — его закреплённые данные, они переданы следующим шагам.',
  'Could not pin the output': 'Не удалось закрепить результат',
  'Output pinned': 'Результат закреплён',
  '{0} is pinned in the saved pipeline. A run with pinned data skips it.':
    '«{0}» закреплён в сохранённом пайплайне. Запуск с закреплёнными данными его пропустит.',
  'Save this output on the step in the saved pipeline, so a run with pinned data skips the step':
    'Сохранить этот результат в шаге сохранённого пайплайна, чтобы запуск с закреплёнными данными пропускал шаг',
  'Pin output': 'Закрепить результат',
  'Replace the pinned data?': 'Заменить закреплённые данные?',
  '{0} already has pinned data from run #{1}. Pinning this output replaces it in the saved pipeline.':
    'У «{0}» уже есть закреплённые данные из запуска #{1}. Этот результат заменит их в сохранённом пайплайне.',
  '{0} already has pinned data. Pinning this output replaces it in the saved pipeline.':
    'У «{0}» уже есть закреплённые данные. Этот результат заменит их в сохранённом пайплайне.',
  'Keep the current pin': 'Оставить текущие',
  Replace: 'Заменить',
  'The saved pipeline of this run no longer exists.': 'Сохранённого пайплайна этого запуска больше нет.',
  'This step is no longer in the saved pipeline.': 'Этого шага больше нет в сохранённом пайплайне.',
  'This step always runs (a reviewing step, callable role or program router), so it cannot be pinned.':
    'Этот шаг выполняется всегда (проверка, роль по вызову или программный роутер), поэтому его нельзя закрепить.',
  'The review asked for changes, but the step it retries from uses pinned data, so another round would repeat the same input. Accept the last result or reject it.':
    'Проверка попросила доработку, но шаг, с которого она повторяет работу, использует закреплённые данные: новый раунд получил бы тот же вход. Примите последний результат или отклоните его.',
  'Reviewing steps, callable roles and program routers always run: unpin this step.':
    'Проверки, роли по вызову и программные роутеры выполняются всегда: открепите этот шаг.',
  'The pinned data of this step is invalid or larger than 256 KiB: unpin it.':
    'Закреплённые данные шага некорректны или больше 256 КиБ: открепите их.',
  'Pinned data of this pipeline is larger than 1 MiB: unpin some steps.': 'Закреплённые данные пайплайна больше 1 МиБ: открепите часть шагов.',
  'Debug in editor': 'Отладить в редакторе',
  'Debug this run in the editor': 'Отладить этот запуск в редакторе',
  'Opens the pipeline exactly as this run used it, as a new unsaved draft. The saved pipeline is not changed. Checked outputs become pinned data: a run with pinned data skips those steps.':
    'Открывает пайплайн ровно таким, каким его использовал этот запуск, как новый несохранённый черновик. Сохранённый пайплайн не меняется. Отмеченные результаты станут закреплёнными данными: запуск с ними пропустит эти шаги.',
  'Reading this run’s outputs…': 'Читаю результаты запуска…',
  'Open without pinned data': 'Открыть без закреплённых данных',
  'Open draft': 'Открыть черновик',
  '{0} (run #{1})': '{0} (запуск #{1})',
  'This run’s pipeline cannot be opened in the editor.': 'Пайплайн этого запуска нельзя открыть в редакторе.',
  'No step of this run succeeded, so there is nothing to pin. The draft runs every step.':
    'Ни один шаг этого запуска не завершился успешно, закреплять нечего. Черновик выполнит все шаги.',
  'Pin the outputs to reuse': 'Какие результаты закрепить',
  'Pinned data in this run': 'В этом запуске — закреплённые данные',
  'Reviewing steps, callable roles and program routers always run.': 'Проверки, роли по вызову и программные роутеры выполняются всегда.',
  'The output is larger than 256 KiB.': 'Результат больше 256 КиБ.',
  'The agent’s history could not be read.': 'Не удалось прочитать историю агента.',
  'No output was recorded.': 'Результат не записан.',
  Archive: 'В архив',
  Unarchive: 'Вернуть из архива',
  Archived: 'В архиве',
  'Show archived runs': 'Показывать архивные запуски',
  'More run actions': 'Другие действия с запуском',
  'Safe mode keeps runs read-only.': 'В безопасном режиме запуски доступны только для чтения.',
  'Stop or finish the run to archive or delete it.': 'Остановите запуск или дождитесь его завершения, чтобы архивировать или удалить его.',
  'Delete run…': 'Удалить запуск…',
  'Delete run': 'Удалить запуск',
  'Delete this run?': 'Удалить этот запуск?',
  'Only PiUI’s own records of this run are deleted.': 'Удаляются только собственные записи PiUI об этом запуске.',
  'Removed from PiUI': 'Удаляется из PiUI',
  'This run in PiUI’s run journal: its steps, the results PiUI recorded, attempts and messages':
    'Этот запуск в журнале запусков PiUI: шаги, записанные PiUI результаты, попытки и сообщения',
  'Its entry in the run list': 'Строка в списке запусков',
  'Script working copies PiUI may still hold for it': 'Рабочие копии скриптов, которые PiUI ещё может хранить для него',
  'Not touched': 'Не затрагивается',
  'The agents’ conversations in their harnesses ({0} sessions and their native history)':
    'Разговоры агентов в их харнесах (сессий: {0}, вместе с нативной историей)',
  'Agent conversations in their harnesses (native sessions and history)': 'Разговоры агентов в их харнесах (нативные сессии и история)',
  'Files in the project folder': 'Файлы в папке проекта',
  'The saved pipeline, its pinned data and automations': 'Сохранённый пайплайн, его закреплённые данные и автоматизации',
  'This cannot be undone.': 'Это нельзя отменить.',
  'Keep the run': 'Оставить запуск',
  'This request is not valid. Refresh the run and try again.': 'Запрос некорректен. Обновите запуск и попробуйте снова.',
  'This run, pipeline or step is no longer available. Refresh the list.': 'Этого запуска, пайплайна или шага больше нет. Обновите список.',
  'This run or pipeline changed meanwhile. Nothing was changed; check it and try again.':
    'Запуск или пайплайн успел измениться. Ничего не изменено; проверьте и попробуйте снова.',
  'Safe mode keeps runs and pipelines read-only.': 'В безопасном режиме запуски и пайплайны доступны только для чтения.',
  'PiUI is closing.': 'PiUI закрывается.',
  'This run is still running or needs checking. Stop or reconcile it first.':
    'Этот запуск ещё выполняется или требует проверки. Сначала остановите его или запишите исход.',
  'Only the output of a step that succeeded can be pinned.': 'Закрепить можно только результат успешно завершённого шага.',
  'This step finished without a recorded output.': 'Шаг завершился без записанного результата.',
  'This output is larger than pinned data allows (256 KiB per step, 1 MiB per pipeline).':
    'Результат больше, чем допускают закреплённые данные (256 КиБ на шаг, 1 МиБ на пайплайн).',
  'The agent’s history could not be read, so its output cannot be pinned.':
    'Не удалось прочитать историю агента, поэтому его результат нельзя закрепить.',
  'PiUI could not save this change. Nothing was changed.': 'PiUI не смог сохранить изменение. Ничего не изменено.',
  'The operation could not be completed. Nothing was changed.': 'Операцию не удалось выполнить. Ничего не изменено.',
};
