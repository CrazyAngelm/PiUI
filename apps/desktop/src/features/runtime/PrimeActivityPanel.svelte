<script lang="ts">
  import type { PrimeActivity } from '../../host-api/types';
  import {
    primeActivityDetail,
    primeActivityStatus,
    primeActivityStatusClass,
    primeActivityTitle,
  } from './primeActivityView';

  export let activities: PrimeActivity[] = [];
</script>

{#if activities.length > 0}
  <details class="prime-activity" aria-label="Prime Agent activity">
    <summary>
      <span class="activity-mark" aria-hidden="true"></span>
      <span>Prime activity</span>
      <span
        class="activity-count"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${activities.length} Prime Agent activities`}
      >{activities.length}</span>
      <span class="activity-chevron" aria-hidden="true">›</span>
    </summary>
    <div class="activity-list">
      {#each activities as activity (activity.id)}
        {@const state = primeActivityStatus(activity)}
        {@const description = primeActivityDetail(activity)}
        <article class="activity-row">
          <span class={`activity-status ${primeActivityStatusClass(state)}`} aria-hidden="true"></span>
          <div class="activity-copy">
            <div class="activity-heading"><strong>{primeActivityTitle(activity)}</strong><span>{state}</span></div>
            {#if description}<p>{description}</p>{/if}
          </div>
        </article>
      {/each}
    </div>
  </details>
{/if}

<style>
  .prime-activity { width: min(calc(100% - 24px), 760px); margin: 0 auto 8px; border: 1px solid var(--piui-border-subtle); border-radius: 10px; background: color-mix(in srgb, var(--piui-surface-1) 78%, var(--piui-bg)); color: var(--piui-text-muted); }
  .prime-activity > summary { display: flex; min-height: 34px; align-items: center; gap: 8px; padding: 0 11px; cursor: pointer; list-style: none; font-size: 11px; font-weight: 700; }
  .prime-activity > summary::-webkit-details-marker { display: none; }
  .prime-activity > summary:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .activity-mark { width: 7px; height: 7px; border-radius: 50%; background: var(--piui-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-accent) 13%, transparent); }
  .activity-count { min-width: 19px; padding: 1px 5px; border-radius: 999px; background: var(--piui-surface-2); color: var(--piui-text-faint); font-size: 9px; text-align: center; }
  .activity-chevron { margin-left: auto; color: var(--piui-text-faint); font-size: 17px; line-height: 1; transition: transform 140ms ease; }
  .prime-activity[open] .activity-chevron { transform: rotate(90deg); }
  .activity-list { display: grid; max-height: min(280px, 34vh); overflow: auto; border-top: 1px solid var(--piui-border-subtle); padding: 5px 8px 8px; }
  .activity-row { display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 8px; padding: 7px 4px; }
  .activity-row + .activity-row { border-top: 1px solid color-mix(in srgb, var(--piui-border-subtle) 65%, transparent); }
  .activity-status { width: 6px; height: 6px; margin-top: 5px; border: 1px solid var(--piui-border); border-radius: 50%; background: var(--piui-text-faint); }
  .activity-status--active { border-color: var(--piui-accent); background: var(--piui-accent); }
  .activity-status--failed { border-color: var(--piui-danger-border); background: var(--piui-danger); }
  .activity-copy { min-width: 0; }
  .activity-heading { display: flex; min-width: 0; align-items: baseline; justify-content: space-between; gap: 12px; }
  .activity-heading strong { overflow: hidden; color: var(--piui-text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .activity-heading span { flex: 0 0 auto; color: var(--piui-text-faint); font-size: 9px; font-weight: 700; text-transform: uppercase; }
  .activity-copy p { margin: 3px 0 0; overflow-wrap: anywhere; color: var(--piui-text-muted); font-size: 10px; line-height: 1.45; }
  @media (max-width: 700px) { .prime-activity { width: calc(100% - 16px); } }
</style>
