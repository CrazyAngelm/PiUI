import { afterEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { setLanguage, t, translate } from './language';
import { workspaceError } from '../../host-api/workspaceClient';

afterEach(() => setLanguage('en'));
it('switches interface copy without translating user content or model IDs', () => {
  setLanguage('ru');
  expect(get(t)('Message queue')).toBe('Очередь сообщений');
  expect(get(t)('Choose a project from the sidebar.')).toBe('Выберите проект в боковой панели.');
  expect(get(t)('Runs use the latest saved team and pipeline.')).toBe('Запуски используют последние сохранённые команду и пайплайн.');
  expect(get(t)('Delete {0}', ['My task {1} / gpt-5.5'])).toBe('Удалить My task {1} / gpt-5.5');
  expect(translate('User supplied instruction', 'ru')).toBe('User supplied instruction');
  setLanguage('en');
  expect(get(t)('Message queue')).toBe('Message queue');
});
it('translates safe composer errors without forwarding host details', () => {
  for (const code of ['TURN_ACTIVE','NO_ACTIVE_TURN','QUEUE_PENDING','DELIVERY_UNCERTAIN','NOT_SUPPORTED','RUNTIME_FAILED','SIGN_IN_REQUIRED']) {
    const message = workspaceError({code,message:'secret native payload'}).message;
    expect(translate(message,'ru')).not.toBe(message);
    expect(translate(message,'ru')).not.toContain('secret');
  }
});
