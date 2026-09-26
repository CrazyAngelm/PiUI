<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Play from '@lucide/svelte/icons/play';
  import { t } from '../../features/locale/language';
  import { IconButton } from '../../lib/ui';
  import InputsEditor from './inputs/InputsEditor.svelte';
  import type { PipelineEditorStore } from './editorStore.svelte';

  interface Props {
    editor: PipelineEditorStore;
    onClose: () => void;
  }
  let { editor, onClose }: Props = $props();
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
  h3 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
