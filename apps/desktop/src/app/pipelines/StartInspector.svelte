<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Play from '@lucide/svelte/icons/play';
  import { t } from '../../features/locale/language';
  import { IconButton } from '../../lib/ui';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import { Button, Switch, toasts } from '../../lib/ui';
  import InputsEditor from './inputs/InputsEditor.svelte';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import { chatInput, chatMessageInput, withChatInput } from '../chatPipelines/chatPipeline';
  import { chatPipelines } from '../chatPipelines/chatPipelines.svelte';

  interface Props {
    editor: PipelineEditorStore;
    onClose: () => void;
  }
  let { editor, onClose }: Props = $props();

  const messageInput = $derived(chatInput(editor.graph.inputs));
  const saved = $derived(editor.systems.some((item) => item.id === editor.graph.id));
  const isDefault = $derived(chatPipelines.libraries[editor.workspaceId]?.chatDefault === editor.graph.id);
  let defaultBusy = $state(false);

  function acceptChat(): void {
    editor.setInputs(withChatInput(editor.graph.inputs, chatMessageInput($t('Message'), $t('The chat message that started the run.'))), true);
  }

  async function setDefault(next: boolean): Promise<void> {
    defaultBusy = true;
    try {
      await chatPipelines.setChatDefault(editor.workspaceId, next ? editor.graph.id : undefined);
    } catch (error) {
      toasts.error($t('Could not change the default for new chats'), error instanceof Error ? error.message : undefined);
    } finally {
      defaultBusy = false;
    }
  }
</script>

<!-- Typing edits the draft live; leaving the panel records one undo step. -->
<aside class="panel" aria-labelledby="start-title" onfocusout={() => editor.settle()}>
  <header>
    <span class="mark" aria-hidden="true"><Play size={12} /></span>
    <h2 id="start-title">{$t('Start')}</h2>
    <span class="spacer"></span>
    <IconButton label={$t('Close start settings')} size="sm" onclick={onClose}><X /></IconButton>
  </header>
  <div class="body">
    <h3>{$t('Chat')}</h3>
    {#if messageInput}
      <p class="note"><MessagesSquare size={14} /> {$t('Chat messages go to the input “{0}”. Every step receives it.', [messageInput.label || messageInput.name])}</p>
      <Switch
        label={$t('Start new chats of this project with this pipeline')}
        checked={isDefault}
        disabled={editor.readOnly || defaultBusy || (!saved && !isDefault)}
        onCheckedChange={(next) => void setDefault(next)}
      />
      {#if !saved}<p class="hint">{$t('Save the pipeline first to make it the default.')}</p>{/if}
    {:else}
      <p class="note">{$t('Chats can send messages through this pipeline once it has a message input.')}</p>
      <Button size="sm" variant="secondary" disabled={editor.readOnly} onclick={acceptChat}>
        {#snippet leading()}<MessagesSquare />{/snippet}
        {$t('Accept chat messages')}
      </Button>
    {/if}
    <h3>{$t('Run inputs')}</h3>
    <InputsEditor inputs={editor.graph.inputs ?? []} readOnly={editor.readOnly} onChange={(next) => editor.setInputs(next, true)} />
  </div>
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: none;
    width: clamp(320px, 26vw, 400px);
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 44px;
    padding: 0 var(--piui-space-2) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--piui-success);
    color: var(--piui-bg);
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .spacer {
    flex: 1;
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  .note {
    display: flex;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .hint {
    margin: 0;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .body > :global(.btn) {
    justify-self: start;
  }
  h3 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
