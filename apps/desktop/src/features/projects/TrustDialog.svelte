<script lang="ts">
  import type { ProjectSummary } from '../../host-api/types';

  export let project: ProjectSummary | undefined;
  export let open = false;
  export let busy = false;
  export let onClose: () => void;
  export let onTrust: () => void;

  function closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget && !busy) onClose();
  }
</script>

{#if open && project}
  <div class="backdrop" role="presentation" onclick={closeOnBackdrop}>
    <dialog open class="dialog" aria-labelledby="trust-title" aria-describedby="trust-description">
      <p class="eyebrow">Trust decision</p>
      <h2 id="trust-title">Trust {project.name}?</h2>
      <p id="trust-description">Pi and this project's extensions may read and modify files and run processes with your user permissions. Trust is not a sandbox.</p>
      <dl>
        <div><dt>Folder</dt><dd class="mono">{project.displayPath}</dd></div>
        <div><dt>Current access</dt><dd>Read-only history until you explicitly start a runtime.</dd></div>
      </dl>
      <div class="actions">
        <button class="button button--quiet" type="button" onclick={onClose} disabled={busy}>Keep restricted</button>
        <button class="button button--primary" type="button" onclick={onTrust} disabled={busy}>{busy ? 'Updating trust…' : 'Trust project'}</button>
      </div>
    </dialog>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: var(--piui-space-4); background: rgba(12, 15, 12, .72); }
  .dialog { width: min(100%, 560px); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-lg); background: var(--piui-bg-raised); padding: clamp(24px, 5vw, 40px); box-shadow: 0 24px 72px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .04); }
  .eyebrow { margin: 0 0 var(--piui-space-3); color: var(--piui-warning); font-size: 11px; font-weight: 720; letter-spacing: .11em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(24px, 4vw, 32px); letter-spacing: -.035em; line-height: 1.1; }
  p:not(.eyebrow) { margin: var(--piui-space-4) 0 0; color: var(--piui-text-muted); line-height: 1.55; }
  dl { display: grid; gap: var(--piui-space-3); margin: var(--piui-space-6) 0; padding: var(--piui-space-4); border-top: 1px solid var(--piui-border); border-bottom: 1px solid var(--piui-border); }
  dl div { display: grid; gap: var(--piui-space-1); }
  dt { color: var(--piui-text-faint); font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
  dd { margin: 0; overflow-wrap: anywhere; color: var(--piui-text); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--piui-space-2); }
  .button { min-height: 38px; padding: 0 var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 13px; font-weight: 700; }
  .button--quiet { background: transparent; color: var(--piui-text-muted); }
  .button--quiet:hover { background: var(--piui-surface-1); color: var(--piui-text); }
  .button--primary { background: var(--piui-accent); color: var(--piui-accent-ink); }
  .button:disabled { opacity: .6; }
</style>
