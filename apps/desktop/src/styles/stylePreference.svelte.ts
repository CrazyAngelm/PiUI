/** Built-in visual styles. Appearance (light/dark/system) remains host-owned. */
export type BuiltinStyle = 'nano' | 'chaos';
export const STYLE_STORAGE_KEY = 'piui.appearance.style';

function restoredStyle(): BuiltinStyle {
  try {
    return localStorage.getItem(STYLE_STORAGE_KEY) === 'chaos' ? 'chaos' : 'nano';
  } catch {
    return 'nano';
  }
}

/** Synchronous, local-only: the first paint never waits for an account or host. */
export class StylePreference {
  value = $state<BuiltinStyle>(restoredStyle());
  sessionOnly = $state(false);

  apply(): void {
    const root = typeof document === 'undefined' ? undefined : document.documentElement;
    if (root) root.dataset.style = this.value;
  }

  set(value: BuiltinStyle): void {
    if (value !== 'nano' && value !== 'chaos') return;
    this.value = value;
    this.apply();
    try {
      localStorage.setItem(STYLE_STORAGE_KEY, value);
      this.sessionOnly = false;
    } catch {
      // Keep the chosen style usable, and tell the settings view it is temporary.
      this.sessionOnly = true;
    }
  }
}

export const stylePreference = new StylePreference();
