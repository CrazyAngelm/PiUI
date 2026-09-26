<script lang="ts">
  import Trash from '@lucide/svelte/icons/trash-2';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import { t } from '../../features/locale/language';

  /**
   * Exactly what deleting a run removes (PiUI's own records) and what it
   * never touches, stated before the person confirms.
   */
  interface Props {
    /** Linked native sessions of the run (agents and model calls). */
    sessions: number;
    /** Script steps that ran; their working copies are PiUI's. */
    scripts: number;
  }
  let { sessions, scripts }: Props = $props();
</script>

<div class="summary">
  <section aria-labelledby="run-delete-removed">
    <h3 id="run-delete-removed"><Trash size={13} /> {$t('Removed from PiUI')}</h3>
    <ul>
      <li>{$t('This run in PiUI’s run journal: its steps, the results PiUI recorded, attempts and messages')}</li>
      <li>{$t('Its entry in the run list')}</li>
      {#if scripts > 0}<li>{$t('Script working copies PiUI may still hold for it')}</li>{/if}
    </ul>
  </section>
  <section aria-labelledby="run-delete-kept">
    <h3 id="run-delete-kept"><ShieldCheck size={13} /> {$t('Not touched')}</h3>
    <ul>
      <li>
        {sessions > 0
          ? $t('The agents’ conversations in their harnesses ({0} sessions and their native history)', [sessions])
          : $t('Agent conversations in their harnesses (native sessions and history)')}
      </li>
      <li>{$t('Files in the project folder')}</li>
      <li>{$t('The saved pipeline, its pinned data and automations')}</li>
    </ul>
  </section>
  <p class="final">{$t('This cannot be undone.')}</p>
</div>

<style>
  .summary {
    display: grid;
    gap: var(--piui-space-3);
  }
  section {
    display: grid;
    gap: 4px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  ul {
    margin: 0;
    padding-left: var(--piui-space-5);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .final {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
