<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { GraphEditorDraftState } from '../../../../../contracts/graph-drafts-v1';
  import type { AgentProfile } from '../../../../../contracts/orchestration-v6';
  import { cloudProfile, replacedProfileSettings, usesCloudProfile } from './cloudCreationProfile';
  import { Tooltip } from 'bits-ui';
  import FlowCanvas from '../../app/pipelines/canvas/FlowCanvas.svelte';
  import type { FlowApi } from '../../app/pipelines/canvas/FlowBridge.svelte';
  import { useTranslation } from '../../features/locale/context';
  const t = useTranslation();
  import { Button, Toaster } from '../../lib/ui';
  import { providePortalTarget } from '../../lib/ui/portalContext';
  import { PortableGraphDraft } from './portableGraphDraft.svelte';

  interface Props { editor: PortableGraphDraft; portalTarget: HTMLElement; onDraftState?: (state: GraphEditorDraftState) => void }
  let { editor, portalTarget, onDraftState }: Props = $props();
  providePortalTarget(() => portalTarget);
  const id = $props.id();
  let flow = $state.raw<FlowApi | undefined>();
  let fileInput = $state<HTMLInputElement>();
  let pending = $state<(() => void | Promise<unknown>) | undefined>();
  let source = $state('');
  let target = $state('');
  let sourceBranch = $state('');
  let rawDocument = $state('');
  let documentOpen = $state(false);
  let lastDraftState = '';
  let replacement = $state<{ graphId: string; nodeId: string; previous: string; profile: AgentProfile; changes: { label: string; value: string }[] } | undefined>();

  $effect(() => {
    const state = editor.draftState();
    const key = JSON.stringify(state);
    if (key !== lastDraftState) { lastDraftState = key; untrack(() => onDraftState?.(state)); }
  });

  function chooseCloudTarget(): void {
    const node = editor.selected, capability = editor.creationProfile;
    if (!node || !capability || editor.readOnly) return;
    replacement = { graphId: editor.graph.id, nodeId: node.id, previous: JSON.stringify(node.profile),
      profile: cloudProfile(node.profile, capability), changes: replacedProfileSettings(node.profile) };
  }

  function confirmCloudTarget(): void {
    if (!replacement || editor.readOnly) return;
    const node = editor.graph.nodes.find(item => item.id === replacement?.nodeId);
    if (editor.graph.id !== replacement.graphId || !node || JSON.stringify(node.profile) !== replacement.previous || !editor.creationProfile) {
      editor.errors = ['The step or cloud capabilities changed. Choose the target again.'];
      replacement = undefined;
      return;
    }
    // The confirmation refers to this exact profile. A changed server model grant
    // must be selected again instead of silently changing the confirmed default.
    if (!editor.creationProfile.models.includes(replacement.profile.model)) {
      editor.errors = ['The step or cloud capabilities changed. Choose the target again.'];
      replacement = undefined;
      return;
    }
    editor.updateNode(node.id, { profile: replacement.profile });
    replacement = undefined;
  }

  $effect(() => {
    // Reload/discard and canvas edits update an unedited document view. Never
    // replace text that the person has started editing but has not applied.
    if (documentOpen && editor.pendingDocument === undefined) rawDocument = editor.documentText();
  });

  onMount(() => {
    void editor.refresh();
    // Delegate editor shortcuts from focusable children, including scoped portals.
    const root = portalTarget;
    root.addEventListener('keydown', keyboard);
    return () => root.removeEventListener('keydown', keyboard);
  });

  function guard(action: () => void | Promise<unknown>): void {
    if (editor.unavailable) return;
    if (editor.dirty) pending = action;
    else void action();
  }

  async function resolvePending(choice: 'save' | 'discard' | 'keep'): Promise<void> {
    const action = pending;
    if (choice === 'keep') { pending = undefined; return; }
    if (choice === 'save' && !(await editor.save())) { pending = undefined; return; }
    pending = undefined;
    await action?.();
  }

  function addAgent(screen: { x: number; y: number } | undefined = undefined): void {
    const position = screen ? flow?.toFlow(screen) : flow?.viewportCenter();
    editor.addAgent(position ?? { x: 60, y: 100 });
  }

  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      guard(() => { if (editor.importText(text)) flow?.fitView(); });
    } catch { editor.errors = ['Could not read the selected file.']; }
  }

  function exportFile(): void {
    try {
      const text = editor.exportText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${editor.graph.name.replace(/[\\/:*?"<>|]/g, '_') || 'pipeline'}.piui.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { editor.errors = [error instanceof Error ? error.message : 'Could not export the system.']; }
  }

  function connect(): void {
    const error = editor.connect(source, target, sourceBranch ? `branch:${sourceBranch}` : undefined);
    editor.errors = error ? [error] : [];
  }

  function keyboard(event: KeyboardEvent): void {
    const element = event.target;
    if (element instanceof HTMLElement && (element.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo(); else editor.undo();
    }
  }
</script>

<Tooltip.Provider>
  <section class="graph-editor" aria-label={$t('Pipelines')}>
    <header class="toolbar">
      <label class="saved" for={`${id}-saved`}>{$t('Saved pipelines')}
        <select id={`${id}-saved`} value={editor.revision === null ? '' : editor.graph.id} disabled={editor.unavailable}
          onchange={(event) => {
            const next = event.currentTarget.value;
            event.currentTarget.value = editor.revision === null ? '' : editor.graph.id;
            if (next) guard(() => editor.open(next));
          }}>
          <option value="">{$t('New draft')}</option>
          {#each editor.summaries as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
        </select>
      </label>
      <Button disabled={editor.unavailable} onclick={() => guard(() => editor.newDraft())}>{$t('New')}</Button>
      <Button variant="primary" disabled={editor.unavailable || (!editor.dirty && editor.revision !== null)} onclick={() => void editor.save()}>{$t('Save')}</Button>
      <Button disabled={editor.unavailable || !editor.canReload} onclick={() => guard(() => editor.open(editor.graph.id))}>{$t('Reload')}</Button>
      <Button disabled={editor.unavailable} onclick={() => fileInput?.click()}>{$t('Import')}</Button>
      <Button disabled={editor.unavailable} onclick={exportFile}>{$t('Export')}</Button>
      <input bind:this={fileInput} class="file-input" type="file" accept=".json,.piui.json,application/json" aria-label={$t('Import a system file')} onchange={(event) => void importFile(event)} />
      <span class="saved-state" role="status">{editor.busy ? $t('Working…') : editor.dirty ? $t('Unsaved changes') : editor.revision !== null ? $t('Saved') : ''}</span>
    </header>

    <p class="location">{$t('Nano Cloud')} · {$t('Draft editor. Saving and importing do not start agents or grant access to this computer.')}</p>

    {#if pending}
      <div class="notice" role="alert">
        <p>{$t('Save your changes before leaving this draft?')}</p>
        <div class="actions">
          <Button variant="primary" disabled={editor.unavailable} onclick={() => void resolvePending('save')}>{$t('Save and continue')}</Button>
          <Button disabled={editor.unavailable} onclick={() => void resolvePending('discard')}>{$t('Discard changes')}</Button>
          <Button disabled={editor.unavailable} onclick={() => void resolvePending('keep')}>{$t('Keep editing')}</Button>
        </div>
      </div>
    {/if}
    {#if editor.errors.length}
      <div class="notice notice--error" role="alert">
        {#each editor.errors as error}<p>{$t(error)}</p>{/each}
      </div>
    {/if}
    {#if editor.conflict}
      <div class="notice notice--error" role="alert">
        <p>{$t('This pipeline changed elsewhere. Reload it or save your changes as a new draft.')}</p>
        <Button disabled={editor.unavailable} onclick={() => editor.saveAsNew()}>{$t('Keep as a new draft')}</Button>
      </div>
    {/if}
    {#if editor.pendingDocument !== undefined}<p class="notice" role="status">{$t('Apply or discard the document edits to continue editing the graph.')}</p>{/if}
    {#if editor.notice}<p class="notice" role="status">{$t(editor.notice)}</p>{/if}
    {#if replacement}
      <section class="notice" aria-label={$t('Replace native settings')}>
        <h2>{$t('Use Nano Cloud for this step?')}</h2>
        <p>{$t('The following native settings will be replaced. The step name, instructions and task stay unchanged.')}</p>
        <dl>{#each replacement.changes as change}<dt>{$t(change.label)}</dt><dd>{change.label === 'Harness' && change.value === 'hermes' ? $t('Nano Cloud') : $t(change.value)}</dd>{/each}</dl>
        <p>{$t('New profile: Nano Cloud, model {0}, native permissions from the server profile. This is not a read-only or isolated execution mode.', [replacement.profile.model])}</p>
        <Button disabled={editor.readOnly} onclick={confirmCloudTarget}>{$t('Replace with Nano Cloud settings')}</Button>
        <Button disabled={editor.unavailable} onclick={() => { replacement = undefined; }}>{$t('Keep current settings')}</Button>
      </section>
    {/if}

    <div class="name-row">
      <label for={`${id}-name`}>{$t('Pipeline name')}</label>
      <input id={`${id}-name`} value={editor.graph.name} disabled={editor.readOnly} oninput={(event) => editor.rename(event.currentTarget.value)} />
      <Button disabled={editor.readOnly} onclick={() => addAgent()}>{$t('Add agent')}</Button>
      <Button disabled={editor.readOnly || (!editor.selectedId && !editor.selectedEdge)} onclick={() => editor.removeSelection(editor.selectedId ? [editor.selectedId] : [], editor.selectedEdge ? [editor.selectedEdge] : [])}>{$t('Delete selection')}</Button>
    </div>

    <div class="workspace">
      <div class="canvas-area"><FlowCanvas {editor} onAddRequest={addAgent} onready={(api) => { flow = api; }} /></div>
      <aside aria-label={$t('Step details')}>
        {#if editor.selected}
          {@const selected = editor.selected}
          <h2>{$t('Step details')}</h2>
          {#if (!selected.executor || selected.executor.type === 'agent') && selected.router?.mode !== 'program'}
            <label for={`${id}-target-host`}>{$t('Execution target')}</label>
            <select id={`${id}-target-host`} value="configured" disabled={editor.readOnly}
              onchange={(event) => { event.currentTarget.value = 'configured'; chooseCloudTarget(); }}>
              <option value="configured">{usesCloudProfile(selected.profile, editor.creationProfile) ? $t('Nano Cloud') : $t('Configured harness: {0}', [selected.profile.harness])}</option>
              {#if !usesCloudProfile(selected.profile, editor.creationProfile)}<option value="cloud" disabled={!editor.creationProfile}>{$t('Nano Cloud')}</option>{/if}
            </select>
            {#if !editor.creationProfile}<p class="hint">{$t('Nano Cloud is unavailable. Imported settings are kept for Desktop.')}</p>{/if}
          {/if}
          <label for={`${id}-step-name`}>{$t('Name')}</label>
          <input id={`${id}-step-name`} value={selected.profile.name} disabled={editor.readOnly} oninput={(event) => editor.updateNode(selected.id, { profile: { ...selected.profile, name: event.currentTarget.value } })} />
          <label for={`${id}-step-task`}>{$t('Task')}</label>
          <textarea id={`${id}-step-task`} value={selected.task} disabled={editor.readOnly} oninput={(event) => editor.updateNode(selected.id, { task: event.currentTarget.value })}></textarea>
          {#if !selected.executor || selected.executor.type === 'agent' || selected.executor.type === 'llm'}
            <label for={`${id}-step-model`}>{$t('Model')}</label>
            {#if usesCloudProfile(selected.profile, editor.creationProfile) && editor.creationProfile}
              <select id={`${id}-step-model`} value={selected.profile.model} disabled={editor.readOnly}
                onchange={(event) => editor.updateNode(selected.id, { profile: { ...selected.profile, model: event.currentTarget.value } })}>
                {#each editor.creationProfile.models as model}<option value={model}>{model}</option>{/each}
              </select>
            {:else}
              <input id={`${id}-step-model`} value={selected.profile.model} disabled={editor.readOnly} oninput={(event) => editor.updateNode(selected.id, { profile: { ...selected.profile, model: event.currentTarget.value } })} />
            {/if}
            <p class="hint">{$t('Harness')}: {selected.profile.harness === 'hermes' ? $t('Nano Cloud') : selected.profile.harness}. {$t('Model availability and execution are checked by the destination host.')}</p>
          {/if}
          <p class="hint">{$t('All step settings are preserved in the portable document below.')}</p>
        {:else}
          <p class="hint">{$t('Select a step to edit it.')}</p>
        {/if}
        <fieldset disabled={editor.readOnly}>
          <legend>{$t('Connect steps')}</legend>
          <label for={`${id}-source`}>{$t('From')}</label>
          <select id={`${id}-source`} bind:value={source} onchange={() => { sourceBranch = ''; }}>
            <option value="">{$t('Choose a step')}</option>
            {#each editor.graph.nodes as node (node.id)}<option value={node.id}>{node.profile.name}</option>{/each}
          </select>
          {#if editor.graph.nodes.find(node => node.id === source)?.router}
            <label for={`${id}-branch`}>{$t('Route')}</label>
            <select id={`${id}-branch`} bind:value={sourceBranch}>
              <option value="">{$t('Choose a route')}</option>
              {#each editor.graph.nodes.find(node => node.id === source)?.router?.branches ?? [] as branch}<option value={branch.id}>{branch.label}</option>{/each}
            </select>
          {/if}
          <label for={`${id}-target`}>{$t('To')}</label>
          <select id={`${id}-target`} bind:value={target}>
            <option value="">{$t('Choose a step')}</option>
            {#each editor.graph.nodes as node (node.id)}<option value={node.id}>{node.profile.name}</option>{/each}
          </select>
          <Button disabled={!source || !target || editor.readOnly} onclick={connect}>{$t('Connect')}</Button>
        </fieldset>
      </aside>
    </div>

    <details bind:open={documentOpen}>
      <summary>{$t('Portable document')}</summary>
      <p class="hint">{$t('Edit advanced settings here. Invalid or unsupported fields leave the current draft unchanged.')}</p>
      <textarea class="document" aria-label={$t('Portable system JSON')} bind:value={rawDocument} disabled={editor.unavailable} spellcheck="false"
        oninput={(event) => { const value = event.currentTarget.value; editor.pendingDocument = value === editor.documentText() ? undefined : value; }}></textarea>
      <Button disabled={editor.unavailable} onclick={() => editor.applyDocument(rawDocument)}>{$t('Apply document')}</Button>
      <Button disabled={editor.unavailable} onclick={() => { editor.discardDocument(); rawDocument = editor.documentText(); }}>{$t('Discard document edits')}</Button>
    </details>
    <Toaster dismissLabel={$t('Dismiss')} />
  </section>
</Tooltip.Provider>

<style>
  .graph-editor { display: grid; gap: var(--piui-space-3); color: var(--piui-text); background: var(--piui-bg); padding: var(--piui-space-4); font-family: var(--piui-font-ui); font-size: var(--piui-text-sm); }
  .toolbar, .actions, .name-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--piui-space-2); }
  .saved { display: flex; align-items: center; gap: var(--piui-space-2); }
  .saved-state { margin-left: auto; color: var(--piui-text-muted); }
  .location, .hint { margin: 0; color: var(--piui-text-muted); line-height: 1.5; }
  .notice { margin: 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); background: var(--piui-surface-1); border-radius: var(--piui-radius-sm); }
  .notice p { margin: 0 0 var(--piui-space-2); white-space: pre-wrap; }
  .notice--error { color: var(--piui-danger-text); background: var(--piui-danger-surface); border-color: var(--piui-danger-border); }
  .workspace { display: grid; grid-template-columns: minmax(0, 1fr) 260px; min-height: 560px; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-md); overflow: hidden; }
  .canvas-area { height: 560px; min-width: 0; }
  aside { display: flex; flex-direction: column; gap: var(--piui-space-2); padding: var(--piui-space-3); background: var(--piui-bg-raised); border-left: 1px solid var(--piui-border); }
  h2 { font-size: var(--piui-text-md); margin: 0; }
  input, select, textarea { min-width: 0; border: 1px solid var(--piui-border-strong); border-radius: var(--piui-radius-sm); padding: 6px 8px; background: var(--piui-surface-1); color: var(--piui-text); font: inherit; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .name-row input { flex: 1; }
  textarea { resize: vertical; min-height: 100px; }
  fieldset { display: grid; gap: var(--piui-space-2); min-width: 0; margin: var(--piui-space-3) 0 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); }
  summary { cursor: pointer; padding: var(--piui-space-2) 0; }
  .document { display: block; box-sizing: border-box; width: 100%; min-height: 260px; margin: var(--piui-space-2) 0; font-family: var(--piui-font-mono); }
  .file-input { display: none; }
  @media (max-width: 800px) { .workspace { grid-template-columns: 1fr; } aside { border-left: 0; border-top: 1px solid var(--piui-border); } }
</style>
