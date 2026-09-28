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
  /** Heading of the group this row starts or continues (e.g. "Teammates"). */
  readonly group?: string;
  /** A teammate's avatar (one emoji or initials) and color. */
  readonly avatar?: { readonly avatar: string; readonly color: string };
}
