import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerAttachmentsResult, ComposerImage } from '../../../host-api/composerInputsClient';

const client = vi.hoisted(() => ({
  pickAttachments: vi.fn(),
  redeemDrop: vi.fn(),
  pasteImage: vi.fn(),
  discardImages: vi.fn(),
  previewImage: vi.fn(),
}));
vi.mock('../../../host-api/composerInputsClient', () => client);
import { ComposerAttachments, MAX_IMAGES_PER_MESSAGE } from './composerAttachments.svelte';

const image = (index: number): ComposerImage => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `shot-${index}.png`, mimeType: 'image/png', size: 10 });
const result = (partial: Partial<ComposerAttachmentsResult>): ComposerAttachmentsResult => ({
  type: 'attachments', protocol: 1, images: [], files: [], rejected: [], ...partial,
});
const SUPPORTED = { supported: true } as const;
const UNSUPPORTED = { supported: false, reason: 'Prime Agent accepts text only in PiUI.' } as const;

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.discardImages.mockResolvedValue(undefined);
});

describe('composer attachments', () => {
  it('keeps picked images, queues references for confirmation and reports rejections', async () => {
    const saved: (readonly ComposerImage[])[] = [];
    const attachments = new ComposerAttachments([], (images) => saved.push(images));
    client.pickAttachments.mockResolvedValue(result({
      images: [image(1)],
      files: [{ name: 'spec.pdf', reference: '@docs/spec.pdf', inProject: true }],
      rejected: [{ name: 'src', reason: 'not-a-file' }],
    }));
    await attachments.pick('workspace', SUPPORTED);
    expect(attachments.images).toEqual([image(1)]);
    expect(saved.at(-1)).toEqual([image(1)]);
    expect(attachments.references).toEqual([{ name: 'spec.pdf', reference: '@docs/spec.pdf', inProject: true }]);
    expect(attachments.notices).toEqual([{ kind: 'rejected', name: 'src', reason: 'not-a-file' }]);
    expect(attachments.confirmReferences()).toBe('@docs/spec.pdf');
    expect(attachments.references).toEqual([]);
  });

  it('never keeps an image the harness cannot take: it is discarded and explained', async () => {
    const attachments = new ComposerAttachments([], () => undefined);
    client.redeemDrop.mockResolvedValue(result({ images: [image(1)] }));
    await attachments.redeem('workspace', 'drop', UNSUPPORTED);
    expect(attachments.images).toEqual([]);
    expect(client.discardImages).toHaveBeenCalledWith([image(1).id]);
    expect(attachments.notices).toEqual([{ kind: 'images-unsupported', names: ['shot-1.png'], reason: UNSUPPORTED.reason }]);
    // A pasted image is refused before any bytes are sent.
    await attachments.paste('workspace', [new File([new Uint8Array([1])], 'clip.png', { type: 'image/png' })], UNSUPPORTED);
    expect(client.pasteImage).not.toHaveBeenCalled();
    expect(attachments.notices).toEqual([{ kind: 'images-unsupported', names: ['clip.png'], reason: UNSUPPORTED.reason }]);
  });

  it('caps a message at six images and discards the rest', async () => {
    const attachments = new ComposerAttachments([image(1), image(2), image(3), image(4), image(5)], () => undefined);
    client.pickAttachments.mockResolvedValue(result({ images: [image(6), image(7)] }));
    await attachments.pick('workspace', SUPPORTED);
    expect(attachments.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(client.discardImages).toHaveBeenCalledWith([image(7).id]);
    expect(attachments.notices).toEqual([{ kind: 'too-many', names: ['shot-7.png'] }]);
  });

  it('pastes only images and reports other files instead of dropping them', async () => {
    const attachments = new ComposerAttachments([], () => undefined);
    client.pasteImage.mockResolvedValue(result({ images: [image(1)] }));
    await attachments.paste('workspace', [
      new File([new Uint8Array([1])], 'clip.png', { type: 'image/png' }),
      new File(['text'], 'notes.txt', { type: 'text/plain' }),
    ], SUPPORTED);
    expect(client.pasteImage).toHaveBeenCalledTimes(1);
    expect(attachments.images).toEqual([image(1)]);
    expect(attachments.notices).toEqual([{ kind: 'no-path', names: ['notes.txt'] }]);
  });

  it('removes with a host discard, hands over without one and surfaces host errors', async () => {
    const saved: (readonly ComposerImage[])[] = [];
    const attachments = new ComposerAttachments([image(1), image(2)], (images) => saved.push(images));
    await attachments.remove(image(1).id);
    expect(client.discardImages).toHaveBeenCalledWith([image(1).id]);
    expect(attachments.handOver()).toEqual([image(2)]);
    expect(attachments.images).toEqual([]);
    expect(client.discardImages).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)).toEqual([]);
    client.pickAttachments.mockRejectedValue(new Error('Trust this project before starting or controlling its agents.'));
    await attachments.pick('workspace', SUPPORTED);
    expect(attachments.notices).toEqual([{ kind: 'error', message: 'Trust this project before starting or controlling its agents.' }]);
    expect(attachments.busy).toBe(false);
  });
});
