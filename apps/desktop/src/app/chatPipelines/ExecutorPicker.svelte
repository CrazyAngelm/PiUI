<script lang="ts" module>
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';

  /**
   * Who handles the next message: the harness directly, a saved pipeline, or a
   * template that is saved as a pipeline when the message is sent (`id` is
   * `builtin:<TemplateId>` or `saved:<templateId>`).
   */
  export type Executor =
    | { kind: 'direct'; harness: HarnessKind | '' }
    | { kind: 'pipeline'; commandId: string }
    | { kind: 'template'; id: string; name: string };

  type Tab = 'direct' | 'pipelines';
  type Section = 'direct' | 'teammates' | 'pipelines' | 'templates';
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Route from '@lucide/svelte/icons/route';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import { Picker, Segmented, Spinner, type PickerItem } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { TEMPLATES, type TemplateId } from '../pipelines/templateCatalog';
  import { chatPipelines } from './chatPipelines.svelte';
  import { rememberedPipeline, templateKey } from './templateRun';
  import { untrack } from 'svelte';
  import { teammates } from '../team/teammatesStore.svelte';
  import TeammateAvatar from '../team/TeammateAvatar.svelte';

  interface Props {
    workspaceId: string;
    value: Executor;
    /** Harnesses offered for direct chats; an existing chat offers only its own. */
    harnesses: readonly { kind: HarnessKind; name: string; version?: string; available: boolean; reason?: string }[];
    /** Offer templates (new chats only): a chosen template becomes the executor and is saved as a pipeline when the message is sent. */
    templates?: boolean;
    disabled?: boolean;
    onChange: (next: Executor) => void;
    onManage?: () => void;
  }
  let { workspaceId, value, harnesses, templates = false, disabled = false, onChange, onManage }: Props = $props();

  type Row = PickerItem & { section: Section };

  let open = $state(false);
  let tab = $state<Tab>('direct');
  let search = $state('');
  const commands = $derived(chatPipelines.commands[workspaceId] ?? []);
  const library = $derived(chatPipelines.libraries[workspaceId]);
  const loading = $derived(chatPipelines.loadingProjects.has(workspaceId));
  const selectedDetail = $derived(value.kind === 'pipeline' ? chatPipelines.detailFor(workspaceId, value.commandId) : undefined);
  const selectedName = $derived(
    value.kind === 'pipeline'
      ? (selectedDetail?.name ?? commands.find((item) => item.id === value.commandId)?.name ?? $t('Pipeline'))
      : value.kind === 'template'
        ? value.name
        : '',
  );

  // The picker opens on the tab of the current executor.
  $effect.pre(() => {
    if (open) untrack(() => (tab = value.kind === 'direct' ? 'direct' : 'pipelines'));
  });

  // Pipelines load when the picker first opens (and again for another project). The load runs untracked:
  // its loading flag is reactive, so after a failed request the effect would otherwise ask again forever.
  // A failure shows `commandErrors` and is retried when the picker reopens.
  $effect(() => {
    const id = workspaceId;
    if ((open || value.kind === 'pipeline') && id && chatPipelines.commands[id] === undefined) untrack(() => void chatPipelines.loadProject(id));
  });
  // Teammates (ADR-041) are listed with the pipelines; they resolve to a saved launch command.
  $effect(() => {
    const id = workspaceId;
    if ((open || value.kind === 'pipeline') && id) untrack(() => void teammates.ensure(id));
  });
  const team = $derived(teammates.list(workspaceId));
  const teammateCommands = $derived(new Set(team.map((teammate) => teammate.launchCommandId)));
  const selectedTeammate = $derived(value.kind === 'pipeline' ? teammates.byLaunchCommand(workspaceId, value.commandId) : undefined);

  const rows = $derived.by<Row[]>(() => {
    const list: Row[] = [];
    for (const item of harnesses) {
      list.push({
        section: 'direct',
        value: `direct:${item.kind}`,
        label: item.name,
        description: item.version ? `v${item.version}` : undefined,
        disabled: !item.available,
        disabledReason: $t(item.reason ?? 'Not available'),
      });
    }
    for (const teammate of team) {
      const detail = chatPipelines.detailFor(workspaceId, teammate.launchCommandId);
      const status = teammates.status(workspaceId, teammate.id);
      const reason = !teammate.enabled ? $t('Turned off') : detail !== undefined && !detail.accepts ? $t('No message input — open it in Pipelines') : undefined;
      list.push({
        section: 'teammates',
        value: `teammate:${teammate.id}`,
        label: `@${teammate.handle} · ${teammate.name}`,
        description: teammate.role || undefined,
        keywords: [teammate.handle, teammate.name, teammate.role],
        badges: status && status.availability !== 'idle' ? [$t(status.availability === 'working' ? 'Working' : 'Queued')] : undefined,
        disabled: reason !== undefined,
        disabledReason: reason,
      });
    }
    for (const command of commands) {
      if (teammateCommands.has(command.id)) continue;
      const detail = chatPipelines.detailFor(workspaceId, command.id);
      list.push({
        section: 'pipelines',
        value: `pipeline:${command.id}`,
        label: command.name || $t('Untitled pipeline'),
        description: detail?.reply ? $t('Answers: {0} · {1}', [harnessMeta(detail.reply.harness).label, detail.reply.stepName]) : undefined,
        keywords: [command.name],
        badges: library?.chatDefault === command.id ? [$t('default')] : undefined,
        disabled: detail !== undefined && !detail.accepts,
        disabledReason: $t('No message input — open it in Pipelines'),
      });
    }
    if (templates) {
      // A template already saved from this picker is listed as the pipeline it became.
      const known = new Set(commands.map((command) => command.id));
      const fresh = (key: string): boolean => {
        const saved = rememberedPipeline(workspaceId, key);
        return saved === undefined || !known.has(saved);
      };
      for (const template of library?.templates ?? []) {
        const key = templateKey({ kind: 'saved', template });
        if (!fresh(key)) continue;
        list.push({
          section: 'templates',
          value: key,
          label: template.name,
          description: template.description,
          badges: [template.scope.kind === 'global' ? $t('yours') : $t('project')],
        });
      }
      for (const template of TEMPLATES) {
        const key = templateKey({ kind: 'builtin', id: template.id });
        if (!fresh(key)) continue;
        list.push({ section: 'templates', value: key, label: $t(template.title), description: $t(template.description), badges: [$t('built-in')] });
      }
    }
    return list;
  });

  const searching = $derived(search.trim() !== '');
  // A search spans both tabs and groups its results; without one, a tab shows only its own rows.
  const items = $derived.by<PickerItem[]>(() => {
    const withTeam = rows.some((row) => row.section === 'teammates');
    const heading = (section: Section): string | undefined => {
      if (section === 'direct') return searching ? $t('Direct') : undefined;
      if (section === 'teammates') return $t('Teammates');
      if (section === 'pipelines') return searching || withTeam ? $t('Pipelines') : undefined;
      return $t('Templates');
    };
    return rows
      .filter((row) => searching || (tab === 'direct') === (row.section === 'direct'))
      .map(({ section, ...item }) => ({ ...item, group: heading(section) }));
  });

  const current = $derived(
    value.kind === 'template'
      ? value.id
      : value.kind === 'pipeline'
        ? selectedTeammate
          ? `teammate:${selectedTeammate.id}`
          : `pipeline:${value.commandId}`
        : `direct:${value.harness}`,
  );
  const showFooter = $derived(tab === 'pipelines' && (loading || Boolean(chatPipelines.commandErrors[workspaceId]) || Boolean(onManage)));
  const waiting = $derived(loading && (tab === 'pipelines' || searching));

  function select(next: string): void {
    const [kind, id = ''] = [next.slice(0, next.indexOf(':')), next.slice(next.indexOf(':') + 1)];
    if (kind === 'direct') onChange({ kind: 'direct', harness: id as HarnessKind });
    else if (kind === 'pipeline') onChange({ kind: 'pipeline', commandId: id });
    else if (kind === 'teammate') {
      const teammate = team.find((item) => item.id === id);
      if (teammate) onChange({ kind: 'pipeline', commandId: teammate.launchCommandId });
    } else if (kind === 'builtin') {
      const template = TEMPLATES.find((item) => item.id === (id as TemplateId));
      if (template) onChange({ kind: 'template', id: next, name: $t(template.title) });
    } else if (kind === 'saved') {
      const template = library?.templates.find((item) => item.id === id);
      if (template) onChange({ kind: 'template', id: next, name: template.name });
    }
  }

  /** Left and right switch the tab while the search is empty. */
  function searchKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || search !== '') return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    tab = tab === 'direct' ? 'pipelines' : 'direct';
  }
</script>

<Picker
  bind:open
  bind:search
  {items}
  value={current}
  label={$t('Who answers')}
  searchPlaceholder={$t('Search teammates, harnesses and pipelines')}
  emptyText={waiting ? $t('Loading pipelines…') : $t('Nothing found')}
  width={360}
  onSelect={select}
  onSearchKeydown={searchKeydown}
  footer={showFooter ? footerContent : undefined}
>
  {#snippet trigger(props)}
    <button type="button" class="chip" class:chip--pipeline={value.kind !== 'direct'} {...props} {disabled} title={$t('Who answers')}>
      {#if selectedTeammate}
        <TeammateAvatar avatar={selectedTeammate.avatar} color={selectedTeammate.color} size={16} />
        <span>@{selectedTeammate.handle}</span>
      {:else if value.kind !== 'direct'}
        <Route size={14} />
        <span>{selectedName}</span>
      {:else}
        {#if value.harness}<HarnessMark kind={value.harness} size={16} />{/if}
        <span>{value.harness ? harnessMeta(value.harness).label : $t('No harness available')}</span>
      {/if}
      <ChevronDown size={12} />
    </button>
  {/snippet}
  {#snippet header({ focusSearch })}
    <Segmented
      size="sm"
      label={$t('Executor type')}
      bind:value={tab}
      options={[
        { value: 'direct', label: $t('Direct') },
        { value: 'pipelines', label: $t('Pipelines') },
      ]}
      onValueChange={focusSearch}
    />
  {/snippet}
</Picker>

{#snippet footerContent()}
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
