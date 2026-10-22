<script lang="ts" module>
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';

  /** One harness as the catalog reports it. */
  export interface FusionHarnessOption {
    kind: HarnessKind;
    name: string;
    available: boolean;
    reason?: string | undefined;
  }
</script>

<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { cachedHarnessModels, workspaceModel } from '../../host-api/harnessModels';
  import type { HarnessCatalogModel } from '../../../../../contracts/harness-models-v18';
  import type { PermissionMode } from '../../../../../contracts/workspace-v15';
  import type { FusionRoleNameV1, FusionRoleV1 } from '../../host-api/fusionClient';
  import { Spinner } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import ModelPicker, { type ModelOption } from '../shell/ModelPicker.svelte';
  import { errorMessage } from '../workspaceStore.svelte';
  import { FUSION_LEADS, FUSION_PERMISSION_CHOICES, FUSION_SIDEKICKS, roleLabel, withHarness, withModel, withPermission, withServiceTier, withThinkingLevel, type RefusalCopy } from './fusionPair';

  /**
   * One column of the pair picker: harness, model and permission mode of the
   * lead or the sidekick. The model list is the harness's own native catalog.
   */
  interface Props {
    role: FusionRoleNameV1;
    value: FusionRoleV1;
    workspaceId: string;
    /** Model catalogs start native processes; they load only for a trusted project. */
    modelsEnabled: boolean;
    harnesses: readonly FusionHarnessOption[];
    disabled: boolean;
    /** The host's refusal when it concerns this role. */
    refusal: RefusalCopy | undefined;
    onChange: (next: FusionRoleV1) => void;
  }
  let { role, value, workspaceId, modelsEnabled, harnesses, disabled, refusal, onChange }: Props = $props();

  const uid = $props.id();
  const kinds: readonly HarnessKind[] = $derived(role === 'lead' ? FUSION_LEADS : FUSION_SIDEKICKS);
  const options = $derived<FusionHarnessOption[]>(
    kinds.map((kind) => harnesses.find((item) => item.kind === kind) ?? { kind, name: harnessMeta(kind).label, available: false }),
  );
  const current = $derived(options.find((item) => item.kind === value.harness));

  let models = $state.raw<HarnessCatalogModel[]>([]);
  let loading = $state(false);
  let catalogReady = $state(false);
  let loadError = $state('');

  $effect(() => {
    const id = workspaceId;
    const kind = value.harness;
    const enabled = modelsEnabled && current?.available === true;
    models = [];
    loadError = '';
    loading = false;
    catalogReady = false;
    if (!id || !enabled) {
      catalogReady = true;
      return;
    }
    let cancelled = false;
    loading = true;
    const show = (result: { models: HarnessCatalogModel[] }): void => {
      if (!cancelled) {
        models = result.models;
        catalogReady = true;
      }
    };
    cachedHarnessModels(
      { workspaceId: id, harness: kind },
      {
        onFresh: show,
        onError: (error) => {
          if (!cancelled) {
            loadError = errorMessage(error);
            catalogReady = true;
          }
        },
      },
    )
      .then(show)
      .catch((error: unknown) => {
        if (!cancelled) {
          loadError = errorMessage(error);
          catalogReady = true;
        }
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const keyOf = (model: { provider?: string | null | undefined; id: string }): string => JSON.stringify([model.provider ?? null, model.id]);
  const modelOptions = $derived<ModelOption[]>(
    models.map((item) => ({
      key: keyOf(item),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: false,
    })),
  );
  const modelKey = $derived(value.model ? keyOf(value.model) : '');
  const selectedModel = $derived(models.find((item) => keyOf(item) === modelKey));
  const levels = $derived(selectedModel?.thinkingLevels ?? value.model?.thinkingLevels ?? []);
  const fastAvailable = $derived(Boolean(selectedModel?.supportsFast));
  const fast = $derived(value.serviceTier === 'fast');

  $effect(() => {
    if (catalogReady && value.serviceTier === 'fast' && !fastAvailable) onChange(withServiceTier(value, false));
  });

  function chooseModel(key: string): void {
    if (key === '') return onChange(withModel(value, undefined, false));
    const found = models.find((item) => keyOf(item) === key);
    if (found) onChange(withModel(value, workspaceModel(found), Boolean(found.supportsFast)));
  }
</script>

<section class="role" class:role--refused={refusal !== undefined} aria-labelledby="{uid}-title">
  <h3 id="{uid}-title">{$t(roleLabel(role))}</h3>

  <div class="field">
    <label for="{uid}-harness">{$t('Harness')}</label>
    <select
      id="{uid}-harness"
      class="select"
      value={value.harness}
      {disabled}
      aria-invalid={refusal !== undefined}
      aria-describedby={refusal ? `${uid}-refusal` : undefined}
      onchange={(event) => onChange(withHarness(value, event.currentTarget.value as HarnessKind))}
    >
      {#each options as option (option.kind)}
        <option value={option.kind} disabled={!option.available && option.kind !== value.harness}>
          {option.name}{option.available ? '' : ` — ${$t(option.reason ?? 'Not available')}`}
        </option>
      {/each}
    </select>
  </div>

  <div class="field">
    <span class="label" id="{uid}-model-label">{$t('Model')}</span>
    <ModelPicker
      models={modelOptions}
      value={modelKey}
      defaultOption={true}
      {loading}
      error={loadError}
      {levels}
      level={value.thinkingLevel ?? ''}
      levelDefault={true}
      {fastAvailable}
      {fast}
      busy={disabled || loading}
      hint={value.model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
      width={340}
      onModel={chooseModel}
      onLevel={(level) => onChange(withThinkingLevel(value, level))}
      onFast={(enabled) => onChange(withServiceTier(value, enabled))}
    >
      {#snippet trigger(props)}
        <button type="button" class="model" {...props} {disabled} aria-labelledby="{uid}-model-label {uid}-model">
          {#if loading}<Spinner size={12} />{:else}<Brain size={14} />{/if}
          <span id="{uid}-model">{value.model?.name ?? $t('Default model')}</span>
          {#if value.thinkingLevel}<span class="model__sub">{value.thinkingLevel}</span>{/if}
          {#if fast}<Zap size={12} />{/if}
        </button>
      {/snippet}
    </ModelPicker>
  </div>

  <div class="field">
    <label for="{uid}-permission">{$t('Permissions')}</label>
    <select
      id="{uid}-permission"
      class="select"
      value={value.permissionMode}
      {disabled}
      aria-invalid={refusal !== undefined}
      aria-describedby={refusal ? `${uid}-refusal` : undefined}
      onchange={(event) => onChange(withPermission(value, event.currentTarget.value as PermissionMode))}
    >
      {#each FUSION_PERMISSION_CHOICES as choice (choice.value)}
        <option value={choice.value}>{$t(choice.label)}</option>
      {/each}
    </select>
    <p class="hint">{$t(FUSION_PERMISSION_CHOICES.find((choice) => choice.value === value.permissionMode)?.description ?? '')}</p>
  </div>

  {#if refusal}
    <div class="refusal" id="{uid}-refusal">
      <strong>{$t(refusal.title)}</strong>
      <span>{$t(refusal.hint)}</span>
    </div>
  {/if}
</section>

<style>
  .role {
    display: grid;
    align-content: start;
    gap: var(--piui-space-3);
    min-width: 0;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-top: 2px solid var(--piui-chaos);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
  }
  .role:nth-of-type(2) {
    border-top-color: var(--piui-chaos-gold);
  }
  .role--refused {
    border-color: var(--piui-danger-border);
  }
  h3 {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: 10px;
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .field {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  label,
  .label {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .select,
  .model {
    width: 100%;
    min-width: 0;
    height: var(--piui-control-sm, 28px);
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .select:focus-visible,
  .model:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .select:disabled,
  .model:disabled {
    opacity: 0.5;
  }
  .model {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-align: left;
    white-space: nowrap;
  }
  .model span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model__sub {
    color: var(--piui-text-disabled);
  }
  .hint {
    margin: 0;
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .refusal {
    display: grid;
    gap: 2px;
    padding: 6px 10px;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
</style>
