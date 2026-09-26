import { derived, writable } from 'svelte/store';
export type Language = 'en' | 'ru';
const key = 'piui.language';
function restored(): Language { try { return localStorage.getItem(key) === 'ru' ? 'ru' : 'en'; } catch { return 'en'; } }
export const language = writable<Language>(restored());
export function setLanguage(value: Language): void {
  try { localStorage.setItem(key, value); } catch { /* Session language still works when storage is unavailable. */ }
  if (value === 'ru') void loadRussian();
  language.set(value);
}
language.subscribe(value => { const root = typeof document === 'undefined' ? undefined : document.documentElement; if (root) root.lang = value; });
// The Russian catalogs are a separate chunk, so English first paint does not
// ship them. main.ts loads them before mounting when Russian is saved.
let russianLookup: ((value: string) => string | undefined) | undefined;
let russianLoading: Promise<void> | undefined;
const catalogRevision = writable(0);
export function loadRussian(): Promise<void> {
  russianLoading ??= import('./ruCatalog').then(
    module => { russianLookup = module.lookupRussian; catalogRevision.update(revision => revision + 1); },
    (error: unknown) => { russianLoading = undefined; throw error; },
  );
  return russianLoading;
}
export function translate(value: string, locale: Language): string { return locale === 'ru' ? russianLookup?.(value) ?? value : value; }
export const t = derived([language, catalogRevision], ([locale]) => (value: string, parameters: readonly unknown[] = []) => translate(value, locale).replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
