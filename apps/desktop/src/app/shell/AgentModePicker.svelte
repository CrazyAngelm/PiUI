<script lang="ts">
  import type { SessionModesV1 } from '../../../../../contracts/workspace-session-mode-v1';
  import { t } from '../../features/locale/language';
  import { setSessionMode } from '../../host-api/sessionMode';

  /**
   * Session modes an ACP agent advertises (ADR-034). Names and descriptions
   * are the agent's own text; the agent keeps enforcing its own permissions.
   */
  interface Props {
    sessionId: string;
    modes: SessionModesV1;
    disabled: boolean;
    /** Refresh the snapshot, which carries the agent's current mode. */
    onChanged: () => Promise<void>;
  }
  let { sessionId, modes, disabled, onChanged }: Props = $props();

  let busy = $state(false);
  let error = $state<string>();
  const current = $derived(modes.available.find((mode) => mode.id === modes.current));

  async function change(select: HTMLSelectElement): Promise<void> {
    const modeId = select.value;
    if (modeId === modes.current) return;
    busy = true;
    error = undefined;
    try {
      await setSessionMode({ sessionId, modeId });
      await onChanged();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The workspace operation could not be completed.';
      select.value = modes.current;
    } finally {
      busy = false;
    }
  }
</script>

<select
  class="select"
  aria-label={$t('Agent mode')}
  value={modes.current}
  disabled={disabled || busy}
  aria-busy={busy || undefined}
  onchange={(event) => void change(event.currentTarget)}
>
  {#if current === undefined}<option value={modes.current} disabled>{$t('Unknown mode')}</option>{/if}
  {#each modes.available as mode (mode.id)}
    <option value={mode.id}>{mode.name}</option>
  {/each}
</select>
{#if current?.description}<small class="muted">{current.description}</small>{/if}
{#if error}<small class="error" role="alert">{$t(error)}</small>{/if}

<style>
  .select {
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .select option {
    background: var(--piui-surface-1);
    color: var(--piui-text);
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .error {
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
  }
</style>
