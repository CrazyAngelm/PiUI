<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { runtimeSettings } from '../../host-api/runtimeSettings';
  import type { RuntimeSettings } from '../../../../../contracts/workspace-settings-v16';
  import type { WorkspaceModel, WorkspaceSession } from '../../../../../contracts/workspace-v15';
  import { Spinner } from '../../lib/ui';
  import ModelPicker, { type ModelOption } from '../shell/ModelPicker.svelte';
  import { errorMessage } from '../workspaceStore.svelte';

  interface Props {
    session: WorkspaceSession;
    disabled?: boolean;
    onchange?: () => void;
  }
  let { session, disabled = false, onchange = () => {} }: Props = $props();

  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  let settings = $state.raw<RuntimeSettings | undefined>();

  const current = $derived(settings?.sessionId === session.id ? settings : undefined);
  const model = $derived(current?.model ?? session.model);
  const keyOf = (value: WorkspaceModel | null | undefined) => (value ? JSON.stringify([value.provider, value.id]) : '');
  const levels = $derived(
    current?.models.find((entry) => keyOf(entry) === keyOf(model))?.thinkingLevels ?? model?.thinkingLevels ?? [],
  );
  const option = (entry: WorkspaceModel & { supportsFast?: boolean }): ModelOption => ({
    key: keyOf(entry),
    name: entry.name,
    id: entry.id,
    ...(entry.provider ? { provider: entry.provider } : {}),
    reasoning: Boolean(entry.thinkingLevels?.length),
    fast: Boolean(entry.supportsFast),
  });
  const options = $derived<ModelOption[]>([
    ...(model && !current?.models.some((entry) => keyOf(entry) === keyOf(model)) ? [option(model)] : []),
    ...(current?.models ?? []).map(option),
  ]);

  $effect(() => {
    if (!open) return;
    const id = session.id;
    busy = true;
    error = '';
    runtimeSettings({ type: 'get', sessionId: id })
      .then((result) => {
        if (session.id === id) settings = result;
      })
      .catch((cause: unknown) => (error = errorMessage(cause)))
      .finally(() => (busy = false));
  });

  async function apply(next: WorkspaceModel | null | undefined, patch: { thinkingLevel?: string; serviceTier?: 'standard' | 'fast' }): Promise<void> {
    if (!current || !next || busy || disabled) return;
    const sameModel = keyOf(next) === keyOf(current.model);
    busy = true;
    error = '';
    const id = session.id;
    try {
      const thinkingLevel = patch.thinkingLevel ?? (sameModel && current.thinkingLevel ? current.thinkingLevel : undefined);
      const serviceTier = patch.serviceTier ?? current.serviceTier ?? undefined;
      const result = await runtimeSettings({
        type: 'set',
        sessionId: id,
        model: next,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      });
      if (session.id === id) settings = result;
      onchange();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function selectModel(value: string): void {
    const next = current?.models.find((entry) => keyOf(entry) === value);
    if (next) void apply(next, {});
  }
</script>

<ModelPicker
  bind:open
  models={options}
  value={keyOf(model)}
  loading={open && busy && !current}
  {error}
  {levels}
  level={current?.thinkingLevel ?? ''}
  fastAvailable={Boolean(current && current.serviceTier !== null)}
  fast={current?.serviceTier === 'fast'}
  {busy}
  side="top"
  onModel={selectModel}
  onLevel={(value) => void apply(current?.model, { thinkingLevel: value })}
  onFast={(value) => void apply(current?.model, { serviceTier: value ? 'fast' : 'standard' })}
>
  {#snippet trigger(props)}
    <button type="button" class="chip" {...props} {disabled} title={disabled ? $t('Available while the agent is idle') : undefined}>
      {#if busy}<Spinner size={12} />{:else}<Brain size={14} />{/if}
      <span>{model?.name ?? $t('Default model')}</span>
      {#if current?.thinkingLevel}<span class="chip__sub">{current.thinkingLevel}</span>{/if}
      {#if current?.serviceTier === 'fast'}<Zap size={12} />{/if}
      <ChevronDown size={12} />
    </button>
  {/snippet}
</ModelPicker>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 280px;
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
  .chip:disabled {
    opacity: 0.55;
  }
  .chip__sub {
    color: var(--piui-text-disabled);
  }
</style>
