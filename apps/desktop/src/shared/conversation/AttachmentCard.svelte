<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Download from '@lucide/svelte/icons/download';
  import { Button, IconButton } from '../../lib/ui';
  import { useTranslation } from '../../features/locale/context';
  import type { ConversationAttachment, ConversationMedia } from '../../../../../contracts/conversation-presentation-v1';

  let { attachment, open, download, resolve, printMode = false }: {
    attachment: ConversationAttachment;
    open?: (id: string) => Promise<void>;
    download?: (id: string) => Promise<void>;
    resolve?: (id: string) => Promise<ConversationMedia>;
    printMode?: boolean;
  } = $props();
  const t = useTranslation();
  const id = untrack(() => attachment.id);
  const ports = untrack(() => ({ open, download, resolve }));
  let src = $state('');
  let error = $state('');
  let busy = $state(false);
  let disposed = false;
  const mediaKind = untrack(() => attachment.presentation);

  onMount(() => {
    if (ports.resolve && mediaKind && mediaKind !== 'file' && (!printMode || mediaKind === 'image') && !attachment.unavailable) {
      void ports.resolve(id).then(media => {
        if (disposed) return;
        if (typeof media.src !== 'string' || !media.src) throw new Error('Missing media source.');
        const url = new URL(media.src, document.baseURI);
        const dataImage = mediaKind === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(media.src);
        if (!['http:', 'https:', 'blob:'].includes(url.protocol) && !dataImage) throw new Error('Unsupported media source.');
        src = media.src;
      }).catch(() => { if (!disposed) error = 'Preview unavailable. Open the attachment to continue.'; });
    }
    return () => { disposed = true; src = ''; };
  });

  async function act(kind: 'open' | 'download'): Promise<void> {
    if (busy || attachment.unavailable || disposed) return;
    if (kind === 'open' && attachment.openable === false) return;
    const callback = ports[kind];
    if (!callback) return;
    busy = true; error = '';
    try { await callback(id); }
    catch { if (!disposed) error = 'Could not open attachment.'; }
    finally { if (!disposed) busy = false; }
  }
</script>

<div class="attachment" data-file-name={attachment.label} data-file-url={src || undefined}>
  {#if src && mediaKind === 'image'}
    {#if !printMode && ports.open && attachment.openable !== false && !attachment.unavailable}
    <button class="image" type="button" aria-label={attachment.label} onclick={() => void act('open')}>
      <img {src} alt={attachment.label} loading="lazy" onerror={() => { src = ''; error = 'Preview unavailable. Open the attachment to continue.'; }} />
    </button>
    {:else}<img {src} alt={attachment.label} loading={printMode ? 'eager' : 'lazy'} onerror={() => { src = ''; error = 'Preview unavailable. Open the attachment to continue.'; }} />{/if}
  {:else if src && mediaKind === 'audio'}
    <audio {src} controls preload="none" aria-label={attachment.label} onerror={() => { src = ''; error = 'Preview unavailable. Open the attachment to continue.'; }}></audio>
  {:else if src && mediaKind === 'video'}
    <!-- svelte-ignore a11y_media_has_caption (The owner supplies an existing file, not authored video.) -->
    <video {src} controls preload="none" aria-label={attachment.label} onerror={() => { src = ''; error = 'Preview unavailable. Open the attachment to continue.'; }}></video>
  {/if}
  <div class="caption">
    {#if !printMode && ports.open && !attachment.unavailable && attachment.openable !== false}
      <Button size="sm" variant="ghost" disabled={busy} onclick={() => void act('open')}>{attachment.label}</Button>
    {:else}<span>{attachment.label}</span>{/if}
    {#if !printMode && attachment.downloadable && ports.download && !attachment.unavailable}
      <IconButton size="sm" label={$t('Download attachment')} disabled={busy} onclick={() => void act('download')}><Download size={14} /></IconButton>
    {/if}
  </div>
  {#if attachment.detail}<small>{attachment.detail}</small>{/if}
  {#if attachment.progress !== undefined}<progress max="100" value={attachment.progress} aria-label={attachment.label}></progress>{/if}
  {#if attachment.unavailable && !attachment.detail}<small>{$t('Attachment unavailable')}</small>{/if}
  {#if error}<small role={error === 'Could not open attachment.' ? 'alert' : 'status'}>{$t(error)}</small>{/if}
</div>

<style>
  .attachment { display: grid; gap: var(--piui-space-1); max-width: 100%; color: var(--piui-text-muted); }
  .caption { display: flex; align-items: center; gap: var(--piui-space-1); }
  .image { display: block; border: 0; padding: 0; background: transparent; cursor: pointer; text-align: left; }
  img, video { display: block; max-width: 100%; border-radius: var(--piui-radius-md); object-fit: contain; }
  audio { max-width: 100%; }
  .image:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  small { font-size: var(--piui-text-xs); }
  progress { width: 100%; accent-color: var(--piui-accent); }
</style>
