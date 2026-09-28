<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { AgentGraph } from '../../features/orchestration/agentGraph';
  import { pipelineLibraryHost } from '../../host-api/pipelineLibraryClient';
  import { Button, Dialog, Field, Input, Segmented, Textarea, toasts } from '../../lib/ui';
  import { templateSystem } from './templateLibrary';

  interface Props {
    open: boolean;
    graph: AgentGraph;
    workspaceId: string;
    projectName: string;
    onSaved?: () => void;
  }
  let { open = $bindable(false), graph, workspaceId, projectName, onSaved }: Props = $props();

  let name = $state('');
  let description = $state('');
  let scope = $state<'global' | 'workspace'>('global');
  let error = $state('');
  let busy = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!open) return;
    name = graph.name;
    description = '';
    error = '';
    void tick().then(() => nameInput?.select());
  });

  async function save(event: SubmitEvent | undefined = undefined): Promise<void> {
    event?.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      error = 'Enter a template name.';
      return;
    }
    let system: Record<string, unknown>;
    try {
      system = templateSystem({ ...graph, name: name.trim() });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Fix the problems before saving';
      return;
    }
    busy = true;
    error = '';
    try {
      await pipelineLibraryHost.request({
        type: 'saveTemplate',
        template: {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          scope: scope === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId },
          system,
        },
      });
      toasts.success($t('Template saved'), $t('Pinned data and run history are not part of a template.'));
      open = false;
      onSaved?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the template.';
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title={$t('Save as template')} description={$t('A template is a copy. Changing this pipeline later does not change the template.')} size="sm">
  <form id="save-template-form" class="form" onsubmit={(event) => void save(event)} novalidate>
    <Field label={$t('Name')} for="template-name" error={error && !name.trim() ? $t(error) : undefined}>
      <Input id="template-name" bind:ref={nameInput} bind:value={name} maxlength={120} invalid={Boolean(error) && !name.trim()} />
    </Field>
    <Field label={$t('Description')} for="template-description" optionalLabel={$t('optional')}>
      <Textarea id="template-description" bind:value={description} minRows={2} maxRows={5} maxlength={500} />
    </Field>
    <Field label={$t('Available in')}>
      <Segmented
        label={$t('Available in')}
        bind:value={scope}
        options={[
          { value: 'global', label: $t('Every project') },
          { value: 'workspace', label: projectName },
        ]}
      />
    </Field>
    {#if error && name.trim()}<p class="error" role="alert">{$t(error)}</p>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="save-template-form" loading={busy}>{$t('Save template')}</Button>
  {/snippet}
</Dialog>

<style>
  .form {
    display: grid;
    gap: var(--piui-space-3);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
    white-space: pre-wrap;
  }
</style>
