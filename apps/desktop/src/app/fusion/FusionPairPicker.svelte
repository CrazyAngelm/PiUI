<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { t } from '../../features/locale/language';
  import { fusionHost, type BriefPolicyV1, type FusionPairV1, type FusionRefusalV1, type FusionRoleNameV1, type FusionRoleV1 } from '../../host-api/fusionClient';
  import { Segmented, Spinner, Switch } from '../../lib/ui';
  import FusionRolePicker, { type FusionHarnessOption } from './FusionRolePicker.svelte';
  import { defaultPair, fusionErrorText, pairKey, refusalCopy, rememberablePair, restorePair, withOptions, withRole } from './fusionPair';

  /**
   * The pair of a new Fusion chat (ADR-043): who leads, who is the sidekick,
   * what each may do, and how they work together. The host checks every
   * change (`checkPair`) and says which role a refusal concerns; the pair
   * can start only after the host accepted exactly this selection.
   */
  interface Props {
    workspaceId: string;
    /** Model catalogs load only for a trusted project. */
    trusted: boolean;
    harnesses: readonly FusionHarnessOption[];
    disabled: boolean;
    pair?: FusionPairV1 | undefined;
    /** True while the shown selection is the one the host accepted. */
    ready?: boolean;
  }
  let { workspaceId, trusted, harnesses, disabled, pair = $bindable(undefined), ready = $bindable(false) }: Props = $props();

  const REMEMBER_KEY = 'piui.fusion.pair.v1';
  const CHECK_DELAY_MS = 250;

  type Verdict =
    | { key: string; kind: 'ok' }
    | { key: string; kind: 'refused'; refusal: FusionRefusalV1; role: FusionRoleNameV1 }
    | { key: string; kind: 'error'; message: string };

  let verdict = $state<Verdict | undefined>();
  let checking = $state(false);

  const availableKinds = $derived(harnesses.filter((item) => item.available).map((item) => item.kind));

  // Start from the remembered pair, else a cross-vendor default; a catalog that
  // arrives later fills in a pair that could not be built before.
  $effect.pre(() => {
    if (pair !== undefined) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(REMEMBER_KEY);
    } catch {
      // Remembering is a convenience only.
    }
    pair = restorePair(raw, availableKinds) ?? defaultPair(availableKinds);
  });

  $effect(() => {
    const current = pair;
    if (current === undefined) return;
    try {
      localStorage.setItem(REMEMBER_KEY, rememberablePair(current));
    } catch {
      // Remembering is a convenience only.
    }
  });

  // The host judges the pair; a stale answer never decides for a newer selection.
  $effect(() => {
    const current = pair;
    const id = workspaceId;
    verdict = undefined;
    if (current === undefined || !id) {
      checking = false;
      return;
    }
    const key = pairKey(current);
    checking = true;
    let cancelled = false;
    const timer = setTimeout(() => {
      fusionHost
        .request({ type: 'checkPair', workspaceId: id, pair: current })
        .then((result): Verdict => {
          if (result.type !== 'pairCheck') return { key, kind: 'error', message: fusionErrorText(undefined) };
          return result.ok ? { key, kind: 'ok' } : { key, kind: 'refused', refusal: result.refusal, role: result.role };
        })
        .catch((error: unknown): Verdict => ({ key, kind: 'error', message: fusionErrorText(error) }))
        .then((answer) => {
          if (cancelled) return;
          verdict = answer;
          checking = false;
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  const settled = $derived(pair !== undefined && !checking && verdict !== undefined && verdict.key === pairKey(pair));
  $effect(() => {
    ready = settled && verdict?.kind === 'ok';
  });

  const refusalFor = (role: FusionRoleNameV1) => (verdict?.kind === 'refused' && verdict.role === role ? refusalCopy(verdict.refusal) : undefined);

  function change(role: FusionRoleNameV1, next: FusionRoleV1): void {
    if (pair) pair = withRole(pair, role, next);
  }
  function option(change: Partial<FusionPairV1['options']>): void {
    if (pair) pair = withOptions(pair, change);
  }
</script>

<section class="picker" aria-label={$t('Fusion pair')}>
  <p class="intro">{$t('The lead chats with you and hands work to a sidekick that keeps its own context between briefs.')}</p>

  {#if pair}
    <div class="roles">
      <FusionRolePicker role="lead" value={pair.lead} {workspaceId} modelsEnabled={trusted} {harnesses} {disabled} refusal={refusalFor('lead')} onChange={(next) => change('lead', next)} />
      <FusionRolePicker role="sidekick" value={pair.sidekick} {workspaceId} modelsEnabled={trusted} {harnesses} {disabled} refusal={refusalFor('sidekick')} onChange={(next) => change('sidekick', next)} />
    </div>

    <details class="options">
      <summary>{$t('Pair options')}</summary>
      <div class="options__body">
        <div class="option">
          <span class="option__label" id="fusion-policy-label">{$t('Brief detail')}</span>
          <Segmented
            value={pair.options.briefPolicy}
            label={$t('Brief detail')}
            size="sm"
            options={[
              { value: 'prescriptive', label: $t('Prescriptive'), title: $t('The lead spells out each step; fewer rounds of rework.') },
              { value: 'outline', label: $t('Outline'), title: $t('The lead states the goal; the sidekick decides the details.') },
            ]}
            onValueChange={(value: BriefPolicyV1) => option({ briefPolicy: value })}
          />
        </div>
        <Switch label={$t('Sidekick may push back on a brief')} checked={pair.options.pushback} {disabled} onCheckedChange={(checked) => option({ pushback: checked })} />
        <Switch label={$t('Deliver reports to the lead automatically')} checked={pair.options.autoDeliver} {disabled} onCheckedChange={(checked) => option({ autoDeliver: checked })} />
        <Switch label={$t('Lead may also use its own subagents')} checked={pair.options.leadNativeSubagents} {disabled} onCheckedChange={(checked) => option({ leadNativeSubagents: checked })} />
      </div>
    </details>

    <p class="status" role="status" aria-live="polite">
      {#if checking}
        <Spinner size={12} /> {$t('Checking the pair…')}
      {:else if verdict?.kind === 'ok'}
        <Check size={14} aria-hidden="true" /> {$t('This pair can start.')}
      {:else if verdict?.kind === 'refused'}
        {$t('This pair cannot start yet. See the highlighted role.')}
      {:else if verdict?.kind === 'error'}
        {$t(verdict.message)}
      {/if}
    </p>
  {:else}
    <p class="status status--problem" role="status">{$t('Fusion needs Claude Code or Codex as the lead. Install and sign in to one of them.')}</p>
  {/if}
</section>

<style>
  .picker {
    display: grid;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: 14px;
    background:
      radial-gradient(120% 70% at 100% 0%, color-mix(in srgb, var(--piui-chaos) 7%, transparent), transparent 60%),
      var(--piui-surface-1);
  }
  .intro {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .roles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--piui-space-3);
  }
  .options summary {
    width: fit-content;
    padding: 2px 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .options summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .options__body {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-2) 4px 0;
  }
  .option {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-3);
  }
  .option__label {
    color: var(--piui-text);
    font-size: var(--piui-text-md);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 20px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .status--problem {
    color: var(--piui-warning-text);
  }
</style>
