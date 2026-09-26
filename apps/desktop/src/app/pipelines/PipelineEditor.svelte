<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import Save from '@lucide/svelte/icons/save';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import Upload from '@lucide/svelte/icons/upload';
  import Download from '@lucide/svelte/icons/download';
  import Bot from '@lucide/svelte/icons/bot';
  import Split from '@lucide/svelte/icons/split';
  import Library from '@lucide/svelte/icons/library';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import { Badge, Button, Dialog, Menu, Picker, Spinner, matchesShortcut, toasts, type PickerItem } from '../../lib/ui';
  import type { AgentProfile, OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { orchestrationHost } from '../../host-api/orchestrationClient';
  import FlowCanvas from './canvas/FlowCanvas.svelte';
  import type { FlowApi } from './canvas/FlowBridge.svelte';
  import NodeInspector from './NodeInspector.svelte';
  import { PipelineEditorStore } from './editorStore.svelte';
  import { TEMPLATES, buildTemplate, type TemplateId } from './templates';
  import { useWorkspace } from '../shell/context';

  interface Props {
    workspaceId: string;
    safeMode: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onRun: (run: OrchestrationRunV6) => void;
    onLibrary: () => void;
  }
  let { workspaceId, safeMode, onDirtyChange, onRun, onLibrary }: Props = $props();
  const workspace = useWorkspace();
  const editor = new PipelineEditorStore(untrack(() => workspaceId), untrack(() => safeMode));

  let api = $state.raw<FlowApi | undefined>();
  let filePicker = $state<HTMLInputElement | null>(null);
  let addMenuOpen = $state(false);

  const selected = $derived(editor.selected);
  const dirty = $derived(editor.dirty);
  const problemCount = $derived(editor.issues.length + editor.preflight.length);
  const defaultHarness = $derived<AgentProfile['harness']>(
    (workspace.catalog.harnesses.find((item) => item.status === 'available')?.kind as AgentProfile['harness'] | undefined) ?? 'codex',
  );
  const systemItems = $derived<PickerItem[]>(editor.systems.map((item) => ({ value: item.id, label: item.name || $t('Untitled pipeline') })));
  const profileItems = $derived<PickerItem[]>(editor.profiles.map((item) => ({ value: item.id, label: item.name })));

  $effect(() => onDirtyChange(dirty));
  $effect(() => {
    if (editor.lastRun) {
      onRun(editor.lastRun);
      editor.lastRun = undefined;
    }
  });

  onMount(() => {
    void editor.refresh();
    return () => onDirtyChange(false);
  });

  function addAt(kind: 'agent' | 'router', screen?: { x: number; y: number }): void {
    if (editor.readOnly) return;
    const point = screen && api ? api.toFlow(screen) : (api?.viewportCenter() ?? { x: 80, y: 80 });
    const id = editor.addNode(kind, { x: point.x - 124, y: point.y - 50 });
    if (kind === 'agent') editor.updateProfile(id, { harness: defaultHarness });
  }

  async function addFromLibrary(profileId: string): Promise<void> {
    try {
      const stored = await orchestrationHost.orchestration_get_profile_v6({ workspaceId, id: profileId });
      if (!stored) return;
      const point = api?.viewportCenter() ?? { x: 80, y: 80 };
      editor.addFromProfile(stored.value, { x: point.x - 124, y: point.y - 50 });
    } catch {
      toasts.error($t('Could not add the saved agent'));
    }
  }

  function useTemplate(id: TemplateId): void {
    editor.startFrom(buildTemplate(id, defaultHarness, (value) => $t(value)));
    setTimeout(() => api?.fitView(), 60);
  }

  async function exportFile(): Promise<void> {
    try {
      const text = await editor.exportText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(editor.graph.name || 'pipeline').replace(/[^\p{L}\p{N}_-]+/gu, '-')}.piui.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      toasts.error($t('Could not export'), error instanceof Error ? error.message : undefined);
    }
  }

  async function importPicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) editor.importText(await file.text());
  }

  async function save(): Promise<void> {
    if (await editor.save()) toasts.success($t('Pipeline saved'));
    else if (editor.issues.length) toasts.error($t('Fix the problems before saving'), $t('{0} problems found', [editor.issues.length]));
  }

  async function run(): Promise<void> {
    const ok = await editor.save(true);
    if (!ok && problemCount) toasts.error($t('The pipeline has problems'), $t('Open a highlighted node to see what to fix.'));
  }

  function focusNode(id: string): void {
    editor.selectedId = id;
    const node = editor.graph.nodes.find((item) => item.id === id);
    if (node) api?.center(node.x + 124, node.y + 60);
  }

  function keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (matchesShortcut(event, 'Mod+Z')) {
      event.preventDefault();
      editor.undo();
    } else if (matchesShortcut(event, 'Mod+Shift+Z') || matchesShortcut(event, 'Mod+Y')) {
      event.preventDefault();
      editor.redo();
    } else if (matchesShortcut(event, 'Mod+S')) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && target.closest('.editor__canvas')) {
      event.preventDefault();
      addMenuOpen = true;
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<section class="editor" aria-label={$t('Pipeline editor')}>
  <header class="bar">
    <div class="identity">
      <input
        class="name"
        value={editor.graph.name}
        placeholder={$t('Untitled pipeline')}
        aria-label={$t('Pipeline name')}
        disabled={editor.readOnly}
        oninput={(event) => editor.rename(event.currentTarget.value)}
        onblur={() => editor.settle()}
      />
      {#if editor.busy}
        <Badge><Spinner size={10} /> {editor.operation === 'open' ? $t('Opening…') : editor.operation === 'check' ? $t('Checking…') : editor.operation === 'run' ? $t('Starting…') : $t('Saving…')}</Badge>
      {:else if dirty}
        <Badge tone="warning">{$t('Unsaved')}</Badge>
      {:else if editor.graph.nodes.length}
        <Badge tone="success">{$t('Saved')}</Badge>
      {/if}
    </div>

    <Picker items={systemItems} value={editor.graph.id} label={$t('Open pipeline')} searchPlaceholder={$t('Search pipelines')} emptyText={$t('No saved pipelines')} onSelect={(id) => editor.open(id)}>
      {#snippet trigger(props)}
        <button type="button" class="switcher" {...props}>
          <Workflow size={14} />
          <span>{$t('Open')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>

    <div class="spacer"></div>

    {#if editor.checkedNotice && !editor.stale && !problemCount}
      <span class="ok"><CircleCheck size={14} /> {$t('Checked')}</span>
    {/if}
    <Button size="sm" variant="ghost" onclick={() => void editor.runCheck()} disabled={editor.readOnly || editor.graph.nodes.length === 0}>
      {#snippet leading()}{#if problemCount}<CircleAlert />{:else}<ShieldCheck />{/if}{/snippet}
      {problemCount ? $t('{0} problems', [problemCount]) : $t('Check')}
    </Button>
    <Button size="sm" onclick={() => void save()} disabled={editor.readOnly || (!dirty && editor.graph.nodes.length > 0)} loading={editor.operation === 'save'}>
      {#snippet leading()}<Save />{/snippet}
      {$t('Save')}
    </Button>
    <Button size="sm" variant="primary" onclick={() => void run()} disabled={editor.readOnly || editor.graph.nodes.length === 0} loading={editor.operation === 'run'}>
      {#snippet leading()}<Play />{/snippet}
      {$t('Run')}
    </Button>
    <Menu
      align="end"
      items={[
        { label: $t('New pipeline'), icon: FilePlus, onSelect: () => editor.newGraph() },
        { label: $t('Import JSON…'), icon: Upload, disabled: safeMode, onSelect: () => filePicker?.click() },
        { label: $t('Export JSON'), icon: Download, disabled: editor.graph.nodes.length === 0, onSelect: () => void exportFile() },
        { type: 'separator' },
        { label: $t('Agent library'), icon: Library, onSelect: onLibrary },
      ]}
    >
      {#snippet trigger(props)}
        <button type="button" class="icon-trigger" aria-label={$t('More pipeline actions')} {...props}><Ellipsis size={16} /></button>
      {/snippet}
    </Menu>
    <input bind:this={filePicker} type="file" accept=".json,application/json" hidden onchange={(event) => void importPicked(event)} />
  </header>

  {#if editor.errors.length}
    <div class="error" role="alert">
      {#each editor.errors as error (error)}<p>{$t(error)}</p>{/each}
    </div>
  {/if}

  <div class="workspace">
    <div class="editor__canvas">
      <FlowCanvas {editor} onready={(next) => (api = next)} onAddRequest={(point) => addAt('agent', point)} />

      <div class="add">
        <Menu
          bind:open={addMenuOpen}
          align="start"
          items={[
            { type: 'label', label: $t('Add to canvas') },
            { label: $t('Agent'), icon: Bot, onSelect: () => addAt('agent') },
            { label: $t('Router'), icon: Split, onSelect: () => addAt('router') },
            ...(profileItems.length
              ? [{ type: 'separator' as const }, { type: 'label' as const, label: $t('From library') }, ...profileItems.slice(0, 8).map((item) => ({ label: item.label, icon: Library, onSelect: () => void addFromLibrary(item.value) }))]
              : []),
          ]}
        >
          {#snippet trigger(props)}
            <Button size="sm" variant="secondary" disabled={editor.readOnly} {...props}>
              {#snippet leading()}<Plus />{/snippet}
              {$t('Add')}
            </Button>
          {/snippet}
        </Menu>
      </div>

      {#if editor.graph.nodes.length === 0 && !editor.busy}
        <div class="start">
          <h2>{$t('Build a pipeline')}</h2>
          <p>{$t('Start from a template or add an agent. Double-click the canvas to add one where you click.')}</p>
          <div class="templates">
            {#each TEMPLATES as template (template.id)}
              <button type="button" class="template" onclick={() => useTemplate(template.id)} disabled={editor.readOnly}>
                <strong>{$t(template.title)}</strong>
                <span>{$t(template.description)}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if problemCount && !selected}
        <div class="problems">
          <strong><CircleAlert size={14} /> {$t('{0} problems', [problemCount])}</strong>
          <ul>
            {#each editor.issues as issue, index (index)}
              <li><button type="button" onclick={() => issue.nodeIds[0] && focusNode(issue.nodeIds[0])}>{$t(issue.message)}</button></li>
            {/each}
            {#each editor.preflight as issue, index (index)}
              <li><button type="button" onclick={() => focusNode(issue.nodeId)}>{$t(issue.message)}</button></li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    {#if selected}
      {#key selected.id}
        <NodeInspector {editor} node={selected} onClose={() => (editor.selectedId = '')} onFocusNode={focusNode} />
      {/key}
    {/if}
  </div>
</section>

<Dialog
  open={editor.pending !== undefined}
  title={$t('Save changes to this pipeline?')}
  description={$t('The draft has unsaved changes.')}
  size="sm"
  dismissible={false}
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void editor.resolvePending('keep')}>{$t('Keep editing')}</Button>
    <Button variant="danger" onclick={() => void editor.resolvePending('discard')}>{$t('Discard')}</Button>
    <Button variant="primary" onclick={() => void editor.resolvePending('save')}>{$t('Save')}</Button>
  {/snippet}
</Dialog>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .name {
    width: clamp(160px, 26vw, 360px);
    height: 30px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .name:hover {
    border-color: var(--piui-border-subtle);
  }
  .name:focus-visible {
    border-color: var(--piui-focus);
    outline: none;
  }
  .switcher,
  .icon-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .switcher:hover,
  .icon-trigger:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .spacer {
    flex: 1;
  }
  .ok {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--piui-success);
    font-size: var(--piui-text-sm);
  }
  .error {
    padding: 6px var(--piui-space-4);
    border-bottom: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    flex: none;
  }
  .error p {
    margin: 0;
  }
  .workspace {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .editor__canvas {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .add {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 5;
  }
  .start {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 4;
    width: min(720px, calc(100% - 48px));
    padding: var(--piui-space-6);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-lg);
    background: color-mix(in srgb, var(--piui-bg-raised) 94%, transparent);
    box-shadow: var(--piui-shadow-2);
    text-align: center;
    transform: translate(-50%, -50%);
  }
  .start h2 {
    margin: 0;
    font-size: var(--piui-text-2xl);
    font-weight: var(--piui-weight-semibold);
  }
  .start p {
    margin: 6px 0 var(--piui-space-4);
    color: var(--piui-text-muted);
  }
  .templates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--piui-space-2);
    text-align: left;
  }
  .template {
    display: grid;
    gap: 4px;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    text-align: left;
  }
  .template:hover:not(:disabled) {
    border-color: var(--piui-accent);
  }
  .template span {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: 1.4;
  }
  .problems {
    position: absolute;
    top: 60px;
    left: 12px;
    z-index: 5;
    width: min(360px, calc(100% - 24px));
    max-height: 40%;
    padding: var(--piui-space-3);
    overflow-y: auto;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
    box-shadow: var(--piui-shadow-2);
  }
  .problems strong {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-danger);
  }
  .problems ul {
    display: grid;
    gap: 2px;
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .problems button {
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .problems button:hover {
    background: var(--piui-hover);
  }
</style>
