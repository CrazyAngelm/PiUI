import { readable } from 'svelte/store';
import { translate, type Language } from './locale';

const russian: Readonly<Record<string, string>> = {
  'Could not load history. Try again.': 'Не удалось загрузить историю. Попробуйте ещё раз.',
  'Could not load the full answer. Try again.': 'Не удалось загрузить полный ответ. Попробуйте ещё раз.',
  'Could not open attachment.': 'Не удалось открыть вложение.',
  'Could not reconnect.': 'Не удалось восстановить соединение.',
  'Reconnecting…': 'Восстановление соединения…',
  'Disconnected': 'Соединение потеряно',
  'Reconnect': 'Восстановить соединение',
  'Attachments': 'Вложения',
  'Download attachment': 'Скачать вложение',
  'Attachment unavailable': 'Вложение недоступно',
  'Refresh search': 'Обновить поиск',
  'Preview unavailable. Open the attachment to continue.': 'Предпросмотр недоступен. Откройте вложение.',
  'Approval requests': 'Запросы подтверждения',
  'Message actions': 'Действия с сообщением',
  'Copy message': 'Скопировать сообщение',
  'Copied': 'Скопировано',
  'Edit and send again': 'Изменить и отправить заново',
  'Branch into a new chat': 'Ответвить в новый диалог',
  'Repeat request': 'Повторить запрос',
  'Refresh conversation': 'Обновить диалог',
  'Could not complete the message action.': 'Не удалось выполнить действие с сообщением.',
};

export function createConversationTranslation(language: Language) {
  return readable((value: string, parameters: readonly unknown[] = []) =>
    (language === 'ru' ? russian[value] ?? translate(value, language) : value)
      .replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
}
// The same pure fallback used by locale/context.ts; every island supplies context.
export const t = createConversationTranslation('en');
