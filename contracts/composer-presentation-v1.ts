/** Presentation on an existing owner-managed editor. No draft, request or file store. */
export interface ComposerRows { minRows: number; maxRows: number }

export interface ComposerOptions {
  contractVersion: 1;
  /** Omit to retain the owner's CSS min/max height. */
  autoGrow?: ComposerRows;
  /** Owner menus receive keys before the common submit intent. */
  beforeKeyDown?: (event: KeyboardEvent) => void;
  onSubmit: (event: KeyboardEvent) => void;
  /** Hosts may supply their existing device policy; otherwise pointer media queries apply. */
  touchOnly?: () => boolean;
}

export interface ComposerHandle {
  update(options: ComposerOptions): void;
  resize(): void;
  dispose(): void;
}
