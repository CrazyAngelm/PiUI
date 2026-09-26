import { listenComposerDrops } from '../../../host-api/composerInputsClient';

/**
 * Routes host-observed OS file drops on the window to the composer that is
 * on screen (the most recently mounted one). The host keeps the dropped
 * paths; a composer redeems the opaque drop id once. In the browser UI Lab
 * no OS drop events exist, and composers take HTML drops of image bytes.
 */
type Target = (dropId: string) => void;

class ComposerDropTargets {
  /** An OS drag with files is over the window. */
  dragging = $state(false);
  private readonly targets: { readonly key: symbol; readonly accept: Target }[] = [];
  private listening: Promise<() => void> | undefined;

  private listen(): void {
    this.listening ??= listenComposerDrops((event) => {
      if (event.type === 'enter') this.dragging = (event.count ?? 0) > 0;
      else if (event.type === 'leave') this.dragging = false;
      else {
        this.dragging = false;
        const target = this.targets.at(-1);
        if (target && event.dropId) target.accept(event.dropId);
      }
    }).catch(() => () => undefined);
  }

  /** Makes `accept` the drop target until the returned function runs. */
  register(accept: Target): () => void {
    this.listen();
    const entry = { key: Symbol('composer-drop-target'), accept };
    this.targets.push(entry);
    return () => {
      const index = this.targets.findIndex((candidate) => candidate.key === entry.key);
      if (index >= 0) this.targets.splice(index, 1);
    };
  }
}

export const composerDropTargets = new ComposerDropTargets();
