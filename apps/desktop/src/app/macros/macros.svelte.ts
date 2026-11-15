import { macroErrors, macroFromDraft, parseMacros, type Macro, type MacroDraft, type MacroErrors } from './macro';

/** Macros are a local preference, like favorite models: no host, harness or account ever stores them. */
export const MACROS_STORAGE_KEY = 'piui.macros.v1';

function readStored(): Macro[] {
  try {
    return parseMacros(localStorage.getItem(MACROS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export class MacroStore {
  list = $state.raw<readonly Macro[]>(readStored());
  /** Storage refused the last write: the macros last until the app closes. */
  sessionOnly = $state(false);
  /** A macro id, or `new`, that Settings → Macros opens for editing. */
  editRequest = $state<string | undefined>();

  private write(next: readonly Macro[]): void {
    this.list = next;
    try {
      localStorage.setItem(MACROS_STORAGE_KEY, JSON.stringify(next));
      this.sessionOnly = false;
    } catch {
      this.sessionOnly = true;
    }
  }

  /** Saves a new or edited macro. An invalid draft changes nothing and returns its field errors. */
  save(draft: MacroDraft): { macro: Macro } | { errors: MacroErrors } {
    const errors = macroErrors(draft, this.list);
    if (Object.keys(errors).length > 0) return { errors };
    const index = this.list.findIndex((item) => item.id === draft.id);
    const existing = this.list[index];
    const macro = macroFromDraft(draft, existing ? existing.id : crypto.randomUUID());
    this.write(existing ? this.list.map((item) => (item.id === macro.id ? macro : item)) : [...this.list, macro]);
    return { macro };
  }

  /** Deletes a macro. The returned function puts it back in its place, unless its name was taken meanwhile. */
  remove(id: string): (() => void) | undefined {
    const index = this.list.findIndex((item) => item.id === id);
    const removed = this.list[index];
    if (!removed) return undefined;
    this.write(this.list.filter((item) => item.id !== id));
    return () => {
      if (this.list.some((item) => item.id === removed.id || item.name === removed.name)) return;
      const next = [...this.list];
      next.splice(Math.min(index, next.length), 0, removed);
      this.write(next);
    };
  }

  requestEdit(id: string): void {
    this.editRequest = id;
  }

  /** Reads the pending request once. */
  takeEditRequest(): string | undefined {
    const id = this.editRequest;
    this.editRequest = undefined;
    return id;
  }
}

export const macros = new MacroStore();
