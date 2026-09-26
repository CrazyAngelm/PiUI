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
};
