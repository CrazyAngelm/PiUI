/** Russian UI copy for model-call and script steps. Keys are the English source strings. */
export const executorsRu: Readonly<Record<string, string>> = {
  // Changing a node's type.
  'Change type': 'Сменить тип',
  'Changed to {0}': 'Тип изменён: {0}',
  'Undo restores the previous type and everything the change removed.': 'Отмена вернёт прежний тип и всё, что было удалено.',
  'Node type: {0}': 'Тип ноды: {0}',
  'Change this node to {0}?': 'Сменить тип ноды на «{0}»?',
  'The new type cannot keep everything listed below. Undo restores it.': 'Новый тип не может сохранить всё перечисленное ниже. Отмена вернёт это.',
  'Removed connections and settings': 'Удаляемые связи и настройки',
  Discarded: 'Удаляемые данные',
  'Kept: the name, position, result connections, result fields, run condition, review and approval.':
    'Сохранятся: название, положение, связи по результату, поля результата, условие запуска, проверка и одобрение.',
  'Change to {0}': 'Сменить на «{0}»',
  'Sends messages to {0}': 'Отправляет сообщения: {0}',
  'Receives messages from {0}': 'Получает сообщения от: {0}',
  'Observes {0}': 'Наблюдает за: {0}',
  'Is observed by {0}': 'За ней наблюдает: {0}',
  'May start instances of {0}': 'Может запускать экземпляры: {0}',
  'May be started by {0}': 'Её может запускать: {0}',
  'Runs only when another agent calls it; it will run in order instead': 'Запускается только по вызову другого агента; станет запускаться по порядку',
  'Script code ({0} lines)': 'Код скрипта (строк: {0})',
  'Input mappings ({0})': 'Сопоставления входа ({0})',
  'Harness and model: {0}': 'Харнес и модель: {0}',
  'Permissions, tools, skills and MCP settings': 'Права, инструменты, навыки и настройки MCP',
  'Harness {0} cannot answer read-only; it becomes {1} and the model is chosen again':
    'Харнес {0} не умеет отвечать в режиме только чтения; он сменится на {1}, модель будет выбрана заново',
  'File access becomes read-only': 'Доступ к файлам станет только для чтения',
  'Network access is turned off': 'Доступ к сети будет выключен',
  'Tool rules ({0})': 'Правила инструментов ({0})',
  'Skills and MCP settings ({0})': 'Настройки навыков и MCP ({0})',

  // Code editor.
  'Tab indents. Press Esc, then Tab, to move focus out of the code.': 'Tab добавляет отступ. Чтобы выйти из кода, нажмите Esc, затем Tab.',

  // Testing a script.
  'Test script': 'Проверка скрипта',
  'Runs this code once now, on this computer in the project folder, with the sample input below. Nothing is saved to a run.':
    'Запускает этот код один раз прямо сейчас на этом компьютере, в папке проекта, с примером входных данных ниже. В запуски ничего не сохраняется.',
  'Sample input (stdin)': 'Пример входных данных (stdin)',
  'The JSON document the script reads. It is kept for this node while the editor is open.':
    'JSON-документ, который читает скрипт. Сохраняется для этой ноды, пока открыт редактор.',
  'Reset to default': 'Вернуть по умолчанию',
  'Running the script…': 'Скрипт выполняется…',
  '{0} s': '{0} с',
  Test: 'Проверить',
  'Add code of at most 64 KiB to test it.': 'Добавьте код размером не больше 64 КиБ, чтобы проверить его.',
  'Set a time limit from 1 to 3600 seconds.': 'Задайте лимит времени от 1 до 3600 секунд.',
  'Ended by a signal': 'Завершён сигналом',
  'Exit code {0}': 'Код выхода {0}',
  'Stopped after {0} s': 'Остановлен через {0} с',
  'The code or the result fields changed after this test. Test again to check them.':
    'Код или поля результата изменились после этой проверки. Проверьте ещё раз.',
  'Test result': 'Результат проверки',
  'The script printed nothing to stdout.': 'Скрипт ничего не вывел в stdout.',
  'This step declares no result fields: a run passes its output on as text.':
    'У этого шага нет полей результата: запуск передаст его вывод дальше как текст.',
  'The output is not one complete JSON object, so no field could be read.':
    'Вывод — не один полный JSON-объект, поэтому поля прочитать не удалось.',
  'The script did not finish, so no result was read.': 'Скрипт не завершился, поэтому результат не прочитан.',
  Problem: 'Ошибка',
  Valid: 'Верно',
  'Only the last 64 KiB of stderr are kept.': 'Сохраняются только последние 64 КиБ stderr.',
  'Nothing was written to stderr.': 'В stderr ничего не записано.',
  'The sample input is not valid JSON.': 'Пример входных данных — некорректный JSON.',
  'The sample input must be one JSON object.': 'Пример входных данных должен быть одним JSON-объектом.',
  'The sample input is larger than 256 KiB.': 'Пример входных данных больше 256 КиБ.',
  'A declared file field does not name a file in the project folder.': 'Объявленное поле-файл не указывает на файл в папке проекта.',
  'The script and every process it started were stopped.': 'Скрипт и все запущенные им процессы остановлены.',
  'Timed out': 'Время вышло',
  'A run would stop it the same way and fail the step.': 'Запуск остановил бы его так же, и шаг завершился бы ошибкой.',
  'A run would succeed': 'Запуск прошёл бы успешно',
  'A run would fail': 'Запуск завершился бы ошибкой',

  // Script test refusals (host-api/scriptTestClient.ts).
  'Check the code, its time limit and the sample input before testing.': 'Перед проверкой проверьте код, лимит времени и пример входных данных.',
  'This project is no longer registered. Refresh the project list.': 'Этот проект больше не зарегистрирован. Обновите список проектов.',
  'Scripts do not run in safe mode.': 'В безопасном режиме скрипты не запускаются.',
  'Trust this project folder to test scripts.': 'Чтобы проверять скрипты, отметьте папку проекта как доверенную.',
  'The project folder is unavailable.': 'Папка проекта недоступна.',
  'PiUI is closing.': 'PiUI закрывается.',
  'This test is already running.': 'Эта проверка уже выполняется.',
  'Too many script tests are running. Wait for one to finish.': 'Выполняется слишком много проверок скриптов. Дождитесь завершения одной из них.',
  'The script could not be started. Nothing ran.': 'Скрипт не удалось запустить. Ничего не выполнялось.',
  'The script started, but PiUI could not observe how it ended.': 'Скрипт запустился, но PiUI не смог узнать, чем он завершился.',
  'The script test could not be completed.': 'Не удалось выполнить проверку скрипта.',
};
