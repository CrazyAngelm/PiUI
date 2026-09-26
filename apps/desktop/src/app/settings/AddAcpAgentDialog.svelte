<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';
  import AcpDescriptorEditor from './AcpDescriptorEditor.svelte';
  import { draftDescriptor, emptyDescriptorForm, formFromJson, formJson, type AcpDescriptorForm } from './acpAgents';
  import type { HarnessesStore } from './harnessesStore.svelte';

  /**
   * Adds a user ACP descriptor from a form or pasted JSON. Nothing runs here:
   * a new agent is untrusted until the user reviews its exact command line.
   * Problems stay in the dialog and the draft is kept.
   */
  interface Props {
    open: boolean;
    store: HarnessesStore;
    onAdded: (id: string) => void;
  }
  let { open = $bindable(), store, onAdded }: Props = $props();
  const uid = $props.id();

  type Mode = 'form' | 'json';
  let mode = $state<Mode>('form');
  let form = $state<AcpDescriptorForm>(emptyDescriptorForm());
  let json = $state('');
  let error = $state<string>();

  function switchMode(next: Mode): void {
    error = undefined;
    if (next === 'json') {
      json = formJson(form);
      return;
    }
    if (json.trim() === '') return;
    const parsed = formFromJson(json);
    if ('error' in parsed) {
      // The JSON stays the draft; switching would lose or rewrite values.
      error = parsed.error;
      mode = 'json';
      return;
    }
    form = parsed.form;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const draft = draftDescriptor(mode, form, json);
    if (!draft.ok) {
      error = draft.message;
      return;
    }
    error = undefined;
    const failure = await store.add(draft.descriptor);
    if (failure !== undefined) {
      error = failure.message;
      return;
    }
    form = emptyDescriptorForm();
    json = '';
    mode = 'form';
    onAdded(draft.descriptor.id);
  }
</script>

<Dialog
  bind:open
  title={$t('Add ACP agent')}
  description={$t('Describe how to start an agent that speaks the Agent Client Protocol. PiUI runs nothing until you review and trust its command line.')}
  size="lg"
  closeLabel={$t('Close')}
>
  <form id="{uid}-form" class="add" onsubmit={(event) => void submit(event)} novalidate>
    <AcpDescriptorEditor bind:mode bind:form bind:json onModeChange={switchMode} />
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </form>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button type="submit" form="{uid}-form" variant="primary" loading={store.busy === 'add'} disabled={store.safeMode}>{$t('Add agent')}</Button>
  {/snippet}
</Dialog>

<style>
  .add {
    display: grid;
    gap: var(--piui-space-4);
  }
  .error {
    margin: 0;
    color: var(--piui-danger-text);
  }
</style>
