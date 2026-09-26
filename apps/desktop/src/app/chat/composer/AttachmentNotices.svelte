<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { t } from '../../../features/locale/language';
  import type { ComposerRejectionReason } from '../../../host-api/composerInputsClient';
  import { IconButton } from '../../../lib/ui';
  import { MAX_IMAGES_PER_MESSAGE, type AttachmentNotice } from './composerAttachments.svelte';

  interface Props {
    notices: readonly AttachmentNotice[];
    onDismiss: () => void;
  }
  let { notices, onDismiss }: Props = $props();

  /** English source copy; the locale catalog translates it. */
  const REASONS: Readonly<Record<ComposerRejectionReason, string>> = {
    'not-a-file': 'Folders cannot be attached.',
    'too-large': 'Images must be 5 MB or smaller.',
    unreadable: 'The file could not be read.',
    'not-an-image': 'Only PNG, JPEG, GIF and WebP images can be attached.',
    limit: 'Too many files at once. Attach at most 10 at a time.',
  };

  function text(notice: AttachmentNotice): string {
    switch (notice.kind) {
      case 'rejected':
        return $t('{0} was not attached. {1}', [notice.name, $t(REASONS[notice.reason])]);
      case 'images-unsupported':
        return $t('{0} was not attached. {1}', [notice.names.join(', '), $t(notice.reason)]);
      case 'too-many':
        return $t('{0} was not attached. A message can carry at most {1} images.', [notice.names.join(', '), MAX_IMAGES_PER_MESSAGE]);
      case 'no-path':
        return $t('{0} was not attached. Only images can be pasted or dropped here; use the paperclip or @ to reference other files by path.', [notice.names.join(', ')]);
      case 'error':
        return $t(notice.message);
      default: {
        const exhaustive: never = notice;
        return exhaustive;
      }
    }
  }
</script>

{#if notices.length}
  <div class="notices" role="alert">
    <ul>
      {#each notices as notice, index (index)}
        <li>{text(notice)}</li>
      {/each}
    </ul>
    <IconButton size="sm" label={$t('Dismiss')} onclick={onDismiss}><X /></IconButton>
  </div>
{/if}

<style>
  .notices {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    margin: 8px 12px 0;
    padding: 6px 6px 6px 10px;
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .notices ul {
    display: grid;
    flex: 1;
    gap: 2px;
    margin: 0;
    padding: 2px 0;
    list-style: none;
  }
</style>
