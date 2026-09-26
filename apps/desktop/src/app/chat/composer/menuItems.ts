/** One row of the composer's `/`, `@` or `$` menu. */
export interface ComposerMenuItem {
  readonly key: string;
  /** Primary text, e.g. `/review` or a file path. */
  readonly title: string;
  readonly detail?: string;
  /** Where the entry comes from, e.g. `PiUI` or a harness name. */
  readonly badge?: string;
  /** A native argument hint such as `<file>`. */
  readonly hint?: string;
  readonly disabled?: boolean;
  /** Shown instead of being selectable (e.g. "Unavailable now"). */
  readonly note?: string;
}
