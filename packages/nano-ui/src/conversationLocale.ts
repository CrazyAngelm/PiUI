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
  'Approval requests': 'Запросы подтверждения',
};

export function createConversationTranslation(language: Language) {
  return readable((value: string, parameters: readonly unknown[] = []) =>
    (language === 'ru' ? russian[value] ?? translate(value, language) : value)
      .replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
}
// The same pure fallback used by locale/context.ts; every island supplies context.
export const t = createConversationTranslation('en');
