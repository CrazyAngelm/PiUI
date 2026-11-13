import { readable } from 'svelte/store';
import { lookupRussian } from '../../../apps/desktop/src/features/locale/ruCatalog';

/** Embedded locale adapter: no localStorage, document.lang or host preferences. */
export type Language = 'en' | 'ru';

const russian: Readonly<Record<string, string>> = {
  'Execution target': 'Место выполнения',
  'Configured harness: {0}': 'Настроенный агент: {0}',
  'Nano Cloud is unavailable. Imported settings are kept for Desktop.': 'Nano Cloud недоступен. Импортированные настройки сохранены для Desktop.',
  'Replace native settings': 'Замена нативных настроек',
  'Use Nano Cloud for this step?': 'Использовать Nano Cloud для этого шага?',
  'The following native settings will be replaced. The step name, instructions and task stay unchanged.': 'Следующие нативные настройки будут заменены. Имя шага, инструкции и задача останутся прежними.',
  'New profile: Nano Cloud, model {0}, native permissions from the server profile. This is not a read-only or isolated execution mode.': 'Новый профиль: Nano Cloud, модель {0}, нативные разрешения серверного профиля. Это не режим только для чтения и не изолированная среда.',
  'Replace with Nano Cloud settings': 'Заменить настройками Nano Cloud',
  'Keep current settings': 'Оставить текущие настройки',
  'The step or cloud capabilities changed. Choose the target again.': 'Шаг или доступные облачные возможности изменились. Выберите место выполнения заново.',
  'Permission mode': 'Режим разрешений',
  'Model provider': 'Провайдер модели',
  'Network access': 'Доступ к сети',
  'Base instructions': 'Базовые инструкции',
  'Configured': 'Задано',
  'Tool rules': 'Правила инструментов',
  'Resource rules': 'Правила ресурсов',
  'Delegation permissions': 'Разрешения делегирования',
  'Script stored in this draft; execution is not enabled.': 'Скрипт сохранён в этом черновике; выполнение не включено.',
  'Saved pipelines': 'Сохранённые пайплайны',
  'New draft': 'Новый черновик',
  'Draft editor. Saving and importing do not start agents or grant access to this computer.': 'Редактор черновиков. Сохранение и импорт не запускают агентов и не предоставляют доступ к этому компьютеру.',
  'Save your changes before leaving this draft?': 'Сохранить изменения перед переходом к другому черновику?',
  'Save and continue': 'Сохранить и продолжить',
  'Discard changes': 'Отменить изменения',
  'Keep editing': 'Продолжить редактирование',
  'Keep as a new draft': 'Оставить как новый черновик',
  'Import a system file': 'Импортировать файл системы',
  'Pipeline name': 'Название пайплайна',
  'Delete selection': 'Удалить выбранное',
  'Step details': 'Настройки шага',
  'Model availability and execution are checked by the destination host.': 'Доступность модели и выполнение проверяются в месте запуска.',
  'All step settings are preserved in the portable document below.': 'Все настройки шага сохранены в переносимом документе ниже.',
  'Select a step to edit it.': 'Выберите шаг для редактирования.',
  'Connect steps': 'Связать шаги',
  'Choose a step': 'Выберите шаг',
  'Choose a route': 'Выберите маршрут',
  'Portable document': 'Переносимый документ',
  'Portable system JSON': 'JSON переносимой системы',
  'Edit advanced settings here. Invalid or unsupported fields leave the current draft unchanged.': 'Здесь можно изменить расширенные настройки. Некорректные или неподдерживаемые поля не изменят текущий черновик.',
  'Apply document': 'Применить документ',
  'Discard document edits': 'Отменить правки документа',
  'Apply or discard the document edits to continue editing the graph.': 'Примените или отмените правки документа, чтобы продолжить редактирование графа.',
  'Could not load saved pipelines.': 'Не удалось загрузить сохранённые пайплайны.',
  'The saved pipeline has an unsupported contract.': 'Формат сохранённого пайплайна не поддерживается.',
  'The saved pipeline is no longer available.': 'Сохранённый пайплайн больше недоступен.',
  'Could not load the pipeline.': 'Не удалось загрузить пайплайн.',
  'Imported as a new draft.': 'Импортировано как новый черновик.',
  'Could not apply the document.': 'Не удалось применить документ.',
  'Could not validate the pipeline.': 'Не удалось проверить пайплайн.',
  'This pipeline changed elsewhere. Reload it or save your changes as a new draft.': 'Этот пайплайн изменён в другом месте. Перезагрузите его или оставьте изменения новым черновиком.',
  'The server returned a different pipeline. The local draft was kept.': 'Сервер вернул другой пайплайн. Локальный черновик сохранён.',
  'Could not confirm the save. Your draft is still open.': 'Не удалось подтвердить сохранение. Черновик остаётся открытым.',
  'Pipeline saved.': 'Пайплайн сохранён.',
  'Could not read the selected file.': 'Не удалось прочитать выбранный файл.',
  'Could not export the system.': 'Не удалось экспортировать систему.',
};

export function translate(value: string, locale: Language): string {
  return locale === 'ru' ? russian[value] ?? lookupRussian(value) ?? value : value;
}
export function createTranslation(locale: Language) {
  return readable((value: string, parameters: readonly unknown[] = []) =>
    translate(value, locale).replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
}
/** A fallback only; each mounted graph receives its own immutable locale context. */
export const t = createTranslation('en');
