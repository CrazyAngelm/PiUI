<script lang="ts" module>
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';

  /** Who handles the next message: the harness directly, or a saved pipeline. */
  export type Executor = { kind: 'direct'; harness: HarnessKind | '' } | { kind: 'pipeline'; commandId: string };
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Route from '@lucide/svelte/icons/route';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import { Picker, Spinner, type PickerItem } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { TEMPLATES, type TemplateId } from '../pipelines/templates';
  import type { PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';
  import { chatPipelines } from './chatPipelines.svelte';

  interface Props {
    workspaceId: string;
    value: Executor;
    /** Harnesses offered for direct chats; an existing chat offers only its own. */
    harnesses: readonly { kind: HarnessKind; name: string; version?: string; available: boolean; reason?: string }[];
    /** Offer templates (new chats only): choosing one opens it in the editor. */
    templates?: boolean;
    disabled?: boolean;
    onChange: (next: Executor) => void;
    onTemplate?: (template: { kind: 'builtin'; id: TemplateId } | { kind: 'saved'; template: PipelineTemplateV1 }) => void;
    onManage?: () => void;
  }
  let { workspaceId, value, harnesses, templates = false, disabled = false, onChange, onTemplate, onManage }: Props = $props();

  let open = $state(false);
  const commands = $derived(chatPipelines.commands[workspaceId] ?? []);
  const library = $derived(chatPipelines.libraries[workspaceId]);
  const loading = $derived(chatPipelines.loadingProjects.has(workspaceId));
  const selectedDetail = $derived(value.kind === 'pipeline' ? chatPipelines.detailFor(workspaceId, value.commandId) : undefined);
  const selectedName = $derived(
    value.kind === 'pipeline' ? (selectedDetail?.name ?? commands.find((item) => item.id === value.commandId)?.name ?? $t('Pipeline')) : '',
  );

  // Pipelines load when the picker first opens (and again for another project).
  $effect(() => {
    if ((open || value.kind === 'pipeline') && workspaceId && chatPipelines.commands[workspaceId] === undefined) void chatPipelines.loadProject(workspaceId);
  });

  const items = $derived.by<PickerItem[]>(() => {
    const direct = $t('Talk directly');
    const saved = $t('Pipelines of this project');
    const list: PickerItem[] = harnesses.map((item) => ({
      value: `direct:${item.kind}`,
      label: item.name,
      description: item.version ? `v${item.version}` : undefined,
      group: direct,
      disabled: !item.available,
      disabledReason: item.reason ?? $t('Not available'),
    }));
    for (const command of commands) {
      const detail = chatPipelines.detailFor(workspaceId, command.id);
      list.push({
        value: `pipeline:${command.id}`,
        label: command.name || $t('Untitled pipeline'),
        description: detail?.reply ? $t('Answers: {0} · {1}', [harnessMeta(detail.reply.harness).label, detail.reply.stepName]) : undefined,
        group: saved,
        keywords: [command.name],
        badges: library?.chatDefault === command.id ? [$t('default')] : undefined,
        disabled: detail !== undefined && !detail.accepts,
        disabledReason: $t('No message input — open it in Pipelines'),
      });
    }
    if (templates) {
      const group = $t('Start from a template');
      for (const template of library?.templates ?? []) {
        list.push({
          value: `saved:${template.id}`,
          label: template.name,
          description: template.description,
          group,
          badges: [template.scope.kind === 'global' ? $t('yours') : $t('project')],
        });
      }
      for (const template of TEMPLATES) {
        list.push({ value: `builtin:${template.id}`, label: $t(template.title), description: $t(template.description), group, badges: [$t('built-in')] });
      }
    }
    return list;
  });

  const current = $derived(value.kind === 'pipeline' ? `pipeline:${value.commandId}` : `direct:${value.harness}`);

  function select(next: string): void {
    const [kind, id = ''] = [next.slice(0, next.indexOf(':')), next.slice(next.indexOf(':') + 1)];
    if (kind === 'direct') onChange({ kind: 'direct', harness: id as HarnessKind });
    else if (kind === 'pipeline') onChange({ kind: 'pipeline', commandId: id });
    else if (kind === 'builtin') onTemplate?.({ kind: 'builtin', id: id as TemplateId });
    else if (kind === 'saved') {
      const template = library?.templates.find((item) => item.id === id);
      if (template) onTemplate?.({ kind: 'saved', template });
    }
  }
</script>

<Picker
  bind:open
  {items}
  value={current}
  label={$t('Who answers')}
  searchPlaceholder={$t('Search harnesses and pipelines')}
  emptyText={loading ? $t('Loading pipelines…') : $t('Nothing found')}
  width={360}
  onSelect={select}
>
  {#snippet trigger(props)}
    <button type="button" class="chip" class:chip--pipeline={value.kind === 'pipeline'} {...props} {disabled} title={$t('Who answers')}>
      {#if value.kind === 'pipeline'}
        <Route size={14} />
        <span>{selectedName}</span>
      {:else}
        {#if value.harness}<HarnessMark kind={value.harness} size={16} />{/if}
        <span>{value.harness ? harnessMeta(value.harness).label : $t('No harness available')}</span>
      {/if}
      <ChevronDown size={12} />
    </button>
  {/snippet}
  {#snippet footer()}
    <div class="footer">
      {#if loading}<Spinner size={12} />{/if}
      {#if chatPipelines.commandErrors[workspaceId]}<span class="footer__error">{$t(chatPipelines.commandErrors[workspaceId] ?? '')}</span>{/if}
      {#if onManage}
        <button type="button" class="footer__link" onclick={() => { open = false; onManage?.(); }}>
          <Workflow size={13} />
          {$t('Manage pipelines')}
        </button>
      {/if}
    </div>
  {/snippet}
</Picker>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover:not(:disabled),
  .chip[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chip--pipeline {
    background: var(--piui-accent-soft);
    color: var(--piui-accent);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 6px 8px;
    border-top: 1px solid var(--piui-border-subtle);
  }
  .footer:empty {
    display: none;
  }
  .footer__error {
    color: var(--piui-danger);
    font-size: var(--piui-text-xs);
  }
  .footer__link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    padding: 2px 4px;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
  }
</style>
