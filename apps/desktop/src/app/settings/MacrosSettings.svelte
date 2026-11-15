<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { t } from '../../features/locale/language';
  import { Button, Dialog, EmptyState, Field, IconButton, Input, Textarea, toasts } from '../../lib/ui';
  import { macros } from '../macros/macros.svelte';
  import { macroSummary, parseSkillNames, type Macro, type MacroErrors, type MacroField } from '../macros/macro';

  let open = $state(false);
  let editingId = $state('');
  let name = $state('');
  let description = $state('');
  let skills = $state('');
  let prompt = $state('');
  let errors = $state<MacroErrors>({});
  let nameInput = $state<HTMLInputElement | null>(null);

  function openEditor(macro: Macro | undefined = undefined): void {
    editingId = macro?.id ?? '';
    name = macro?.name ?? '';
    description = macro?.description ?? '';
    skills = macro?.skills.join(', ') ?? '';
    prompt = macro?.prompt ?? '';
    errors = {};
    open = true;
    void tick().then(() => nameInput?.focus());
  }

  function close(): void { open = false; }

  function clearError(field: MacroField): void {
    if (field === 'skills') errors = { ...errors, skills: undefined, content: undefined };
    else errors = { ...errors, [field]: undefined };
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const result = macros.save({ ...(editingId ? { id: editingId } : {}), name, description, prompt, skills: parseSkillNames(skills) });
    if ('errors' in result) errors = result.errors;
    else close();
  }

  function remove(macro: Macro): void {
    const undo = macros.remove(macro.id);
    if (undo) toasts.show({ title: $t('Deleted //{0}', [macro.name]), action: { label: $t('Undo'), run: undo } });
  }

  $effect(() => {
    const request = macros.editRequest;
    if (request === undefined) return;
    untrack(() => {
      macros.takeEditRequest();
      if (request === 'new') openEditor();
      else {
        const found = macros.list.find((item) => item.id === request);
        if (found) openEditor(found);
      }
    });
  });
</script>

<section aria-labelledby="macros-title">
  <div class="title-row">
    <h2 id="macros-title">{$t('Macros')}</h2>
    <Button variant="primary" size="sm" onclick={() => openEditor()}><Plus size={14} />{$t('New macro')}</Button>
  </div>
  {#if macros.sessionOnly}
    <p class="error" role="alert">{$t('Macros could not be saved on this device. They last until the app closes.')}</p>
  {/if}
  {#if macros.list.length}
    <div class="rows" role="list" aria-label={$t('Macros')}>
      {#each macros.list as macro (macro.id)}
        <div class="row" role="listitem">
          <code>//{macro.name}</code>
          <span class="summary">{macroSummary(macro)}</span>
          <IconButton size="sm" label={$t('Edit //{0}', [macro.name])} onclick={() => openEditor(macro)}><Pencil /></IconButton>
          <IconButton size="sm" label={$t('Delete //{0}', [macro.name])} onclick={() => remove(macro)}><Trash2 /></IconButton>
        </div>
      {/each}
    </div>
  {:else}
    <EmptyState title={$t('No macros yet')} description={$t('A macro is a saved prompt or a set of skills. Type // in a message to add one.')}>
      {#snippet actions()}<Button variant="primary" size="sm" onclick={() => openEditor()}>{$t('New macro')}</Button>{/snippet}
    </EmptyState>
  {/if}
</section>

<Dialog bind:open title={editingId ? $t('Edit macro') : $t('New macro')} closeLabel={$t('Close')}>
  <form id="macro-editor" onsubmit={save}>
    <Field label={$t('Name')} for="macro-name" error={errors.name ? $t(errors.name) : undefined}>
      <Input id="macro-name" bind:ref={nameInput} bind:value={name} autocomplete="off" spellcheck={false} invalid={Boolean(errors.name)} oninput={() => clearError('name')}>
        {#snippet leading()}<span aria-hidden="true">//</span>{/snippet}
      </Input>
    </Field>
    <Field label={$t('Description')} for="macro-description" optionalLabel={$t('optional')} error={errors.description ? $t(errors.description) : undefined}>
      <Input id="macro-description" bind:value={description} invalid={Boolean(errors.description)} oninput={() => clearError('description')} />
    </Field>
    <Field label={$t('Skills')} for="macro-skills" optionalLabel={$t('optional')} error={errors.skills ? $t(errors.skills) : undefined}>
      <Input id="macro-skills" bind:value={skills} placeholder="review, test-runner" invalid={Boolean(errors.skills)} oninput={() => clearError('skills')} />
    </Field>
    <Field label={$t('Prompt')} for="macro-prompt" error={errors.content ? $t(errors.content) : undefined}>
      <Textarea id="macro-prompt" bind:value={prompt} minRows={5} maxRows={14} invalid={Boolean(errors.content)} oninput={() => clearError('content')} />
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{$t('Cancel')}</Button>
    <Button variant="primary" type="submit" form="macro-editor">{$t('Save')}</Button>
  {/snippet}
</Dialog>

<style>
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-4); margin-bottom: var(--piui-space-4); }
  h2 { margin: 0; font-size: var(--piui-text-xl); font-weight: var(--piui-weight-semibold); }
  .rows { border: 1px solid var(--piui-border-subtle); border-radius: var(--piui-radius-md); background: var(--piui-bg-raised); }
  .row { display: flex; align-items: center; gap: var(--piui-space-2); padding: var(--piui-space-3) var(--piui-space-4); }
  .row + .row { border-top: 1px solid var(--piui-border-subtle); }
  code { flex: none; font-family: var(--piui-font-mono); }
  .summary { flex: 1; min-width: 0; overflow: hidden; color: var(--piui-text-muted); text-overflow: ellipsis; white-space: nowrap; }
  .error { color: var(--piui-danger); }
  form { display: grid; gap: var(--piui-space-4); }
</style>
