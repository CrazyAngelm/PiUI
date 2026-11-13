import { getContext } from 'svelte';
import { t } from './language';

/** Desktop defaults to its app language; an embedded surface supplies its own store. */
export const TRANSLATION_CONTEXT = Symbol('piui.translation');
export function useTranslation(): typeof t { return getContext<typeof t | undefined>(TRANSLATION_CONTEXT) ?? t; }
