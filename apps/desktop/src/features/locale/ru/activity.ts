/**
 * Russian copy of the chat's activity section and the details panel (ADR-072).
 * "Activity", "Agents", "Running", "Completed", "Failed", "Stopped" and "Mode"
 * already have a translation in the shared catalogs.
 */
export const activityRu: Readonly<Record<string, string>> = {
  'Commands': 'Команды',
  'Other': 'Прочее',
  'Nothing is running': 'Сейчас ничего не запущено',
  'Stop {0}': 'Остановить: {0}',
  'The task could not be stopped.': 'Не удалось остановить задачу.',
  '{0} running in this chat': 'Запущено в этом чате: {0}',
};
