import {
  discardImages,
  pasteImage,
  pickAttachments,
  redeemDrop,
  type ComposerAttachmentsResult,
  type ComposerFileReference,
  type ComposerImage,
  type ComposerRejectionReason,
} from '../../../host-api/composerInputsClient';
import type { ImageSupport } from '../../../harness-adapters/composer';
import { errorMessage } from '../../workspaceStore.svelte';
import { forgetThumbnail, rememberThumbnail } from './thumbnails';

/** Images one message may carry (the host enforces the same bound). */
export const MAX_IMAGES_PER_MESSAGE = 6;

/** Something the user should know about the last attach attempt; copy lives in the component. */
export type AttachmentNotice =
  | { readonly kind: 'rejected'; readonly name: string; readonly reason: ComposerRejectionReason }
  /** Images the harness or model does not take; they were not attached. */
  | { readonly kind: 'images-unsupported'; readonly names: readonly string[]; readonly reason: string }
  | { readonly kind: 'too-many'; readonly names: readonly string[] }
  /** A browser drop or paste of a non-image file: it has no path to reference. */
  | { readonly kind: 'no-path'; readonly names: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

function isImageFile(file: File): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type);
}

/**
 * Attachments of one composer draft. Images are pending host attachments
 * (bytes in PiUI's app data, never in the project); other files become path
 * references the user confirms before they are inserted into the text.
 * `save` keeps the draft's images across composer remounts.
 */
export class ComposerAttachments {
  images = $state.raw<ComposerImage[]>([]);
  /** Picked or dropped files waiting for the user to confirm path references. */
  references = $state.raw<ComposerFileReference[]>([]);
  notices = $state.raw<AttachmentNotice[]>([]);
  busy = $state(false);

  constructor(
    initial: readonly ComposerImage[],
    private readonly save: (images: readonly ComposerImage[]) => void,
  ) {
    this.images = [...initial];
  }

  get ids(): string[] {
    return this.images.map((image) => image.id);
  }

  private setImages(images: ComposerImage[]): void {
    this.images = images;
    this.save(images);
  }

  private async run(operation: () => Promise<ComposerAttachmentsResult>, support: ImageSupport, notices: AttachmentNotice[] = []): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.accept(await operation(), support, notices);
    } catch (error) {
      this.notices = [...notices, { kind: 'error', message: errorMessage(error) }];
    } finally {
      this.busy = false;
    }
  }

  private async accept(result: ComposerAttachmentsResult, support: ImageSupport, notices: AttachmentNotice[]): Promise<void> {
    const next: AttachmentNotice[] = [...notices, ...result.rejected.map((item) => ({ kind: 'rejected' as const, name: item.name, reason: item.reason }))];
    let images = result.images;
    const refused: ComposerImage[] = [];
    if (!support.supported && images.length) {
      refused.push(...images);
      next.push({ kind: 'images-unsupported', names: images.map((image) => image.name), reason: support.reason ?? '' });
      images = [];
    }
    const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - this.images.length);
    if (images.length > room) {
      const extra = images.slice(room);
      refused.push(...extra);
      next.push({ kind: 'too-many', names: extra.map((image) => image.name) });
      images = images.slice(0, room);
    }
    // Nothing the user does not see stays pending on the host.
    if (refused.length) {
      for (const image of refused) forgetThumbnail(image.id);
      await discardImages(refused.map((image) => image.id)).catch(() => undefined);
    }
    if (images.length) this.setImages([...this.images, ...images]);
    if (result.files.length) this.references = [...this.references, ...result.files];
    this.notices = next;
  }

  /** The native file dialog (images and files). */
  pick(workspaceId: string, support: ImageSupport): Promise<void> {
    return this.run(() => pickAttachments(workspaceId), support);
  }

  /** Files of a host-observed OS drop on the window. */
  redeem(workspaceId: string, dropId: string, support: ImageSupport): Promise<void> {
    return this.run(() => redeemDrop(workspaceId, dropId), support);
  }

  /**
   * Pasted or browser-dropped files. Only images have bytes to send; other
   * files have no path here, so they are reported instead of dropped.
   */
  async paste(workspaceId: string, files: readonly File[], support: ImageSupport): Promise<void> {
    const images = files.filter(isImageFile);
    const others = files.filter((file) => !isImageFile(file));
    const notices: AttachmentNotice[] = others.length ? [{ kind: 'no-path', names: others.map((file) => file.name || 'File') }] : [];
    if (!images.length) {
      this.notices = notices;
      return;
    }
    if (!support.supported) {
      this.notices = [...notices, { kind: 'images-unsupported', names: images.map((file) => file.name || 'Image'), reason: support.reason ?? '' }];
      return;
    }
    await this.run(async () => {
      const merged: ComposerAttachmentsResult = { type: 'attachments', protocol: 1, images: [], files: [], rejected: [] };
      for (const file of images) {
        const name = file.name || 'Pasted image';
        const result = await pasteImage(workspaceId, file, name);
        for (const image of result.images) rememberThumbnail(image.id, file);
        merged.images.push(...result.images);
        merged.rejected.push(...result.rejected);
      }
      return merged;
    }, support, notices);
  }

  /** Removes one image and deletes its pending bytes on the host. */
  async remove(id: string): Promise<void> {
    this.setImages(this.images.filter((image) => image.id !== id));
    forgetThumbnail(id);
    await discardImages([id]).catch(() => undefined);
  }

  /** Removes every image (their pending bytes are deleted). */
  async discardAll(): Promise<void> {
    const ids = this.ids;
    if (!ids.length) return;
    this.setImages([]);
    for (const id of ids) forgetThumbnail(id);
    await discardImages(ids).catch(() => undefined);
  }

  /**
   * The images now belong to a queued message (or another draft): they leave
   * this composer without being deleted on the host.
   */
  handOver(): ComposerImage[] {
    const images = this.images;
    this.setImages([]);
    return images;
  }

  /** Text for the confirmed references, separated by spaces. */
  confirmReferences(): string {
    const text = this.references.map((item) => item.reference).join(' ');
    this.references = [];
    return text;
  }

  cancelReferences(): void {
    this.references = [];
  }

  dismissNotices(): void {
    this.notices = [];
  }
}
