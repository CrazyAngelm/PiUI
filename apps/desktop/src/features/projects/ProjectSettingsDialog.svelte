<script lang="ts">
  import { tick } from 'svelte';
  import type { ProjectSummary } from '../../host-api/types';

  export let project: ProjectSummary | undefined;
  export let open = false;
  export let busy = false;
  export let error: string | undefined;
  export let draftName = '';
  export let onClose: () => void;
  export let onRename: (name: string) => void;
  export let onTogglePin: () => void;
  export let onRemove: () => void;

  let removeConfirmation = false;
  let dialog: HTMLDialogElement | undefined;

  $: if (!open) removeConfirmation = false;
  $: if (open && project) void focusFirstControl();

  async function focusFirstControl(): Promise<void> {
    await tick();
    dialog?.querySelector<HTMLInputElement>('#project-display-name')?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!open || project === undefined) return;
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || dialog === undefined) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const current = document.activeElement;
    const currentIndex = focusable.indexOf(current as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget && !busy) onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open && project}
  <div class="backdrop" role="presentation" onclick={closeOnBackdrop}>
    <dialog bind:this={dialog} open class="dialog" aria-modal="true" aria-labelledby="project-settings-title" aria-describedby="project-settings-description">
      <p class="eyebrow">Local project</p>
      <h2 id="project-settings-title">Project settings</h2>
      <p id="project-settings-description">These actions change PiUI’s local registry only. They never rename or delete the folder or Pi session files.</p>

      <section class="rename-section" aria-label="Project display name">
        <label for="project-display-name">Display name</label>
        <input id="project-display-name" bind:value={draftName} autocomplete="off" disabled={busy} />
        <div class="actions">
          <button class="button button--quiet" type="button" onclick={onClose} disabled={busy}>Cancel</button>
          <button class="button button--primary" type="button" onclick={() => onRename(draftName)} disabled={busy || draftName.trim().length === 0}>{busy ? 'Saving…' : 'Save name'}</button>
        </div>
      </section>

      <section class="registry-section" aria-label="Project registry controls">
        <div>
          <strong>{project.pinned ? 'Pinned project' : 'Project order'}</strong>
          <p>{project.pinned ? 'This project stays at the top of your local list.' : 'Pin it to keep it at the top of your local list.'}</p>
        </div>
        <button class="button button--quiet" type="button" onclick={onTogglePin} disabled={busy}>{project.pinned ? 'Unpin' : 'Pin project'}</button>
      </section>

      <section class="danger-section" aria-label="Remove project from PiUI">
        <div>
          <strong>Remove from PiUI</strong>
          <p>Removes the local registry record and rebuildable cache. The folder and Pi JSONL files remain untouched.</p>
        </div>
        {#if removeConfirmation}
          <div class="remove-confirmation">
            <p>Remove <span class="mono">{project.name}</span> from this PiUI installation?</p>
            <div class="actions">
              <button class="button button--quiet" type="button" onclick={() => removeConfirmation = false} disabled={busy}>Keep project</button>
              <button class="button button--danger" type="button" onclick={onRemove} disabled={busy}>{busy ? 'Removing…' : 'Remove registry entry'}</button>
            </div>
          </div>
        {:else}
          <button class="button button--danger-outline" type="button" onclick={() => removeConfirmation = true} disabled={busy}>Remove…</button>
        {/if}
      </section>

      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </dialog>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: var(--piui-space-4); background: rgba(12, 15, 12, .72); }
  .dialog { width: min(100%, 580px); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-lg); background: var(--piui-bg-raised); padding: clamp(24px, 5vw, 40px); box-shadow: 0 24px 72px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .04); }
  .eyebrow { margin: 0 0 var(--piui-space-3); color: var(--piui-accent); font-size: 11px; font-weight: 720; letter-spacing: .11em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(24px, 4vw, 32px); letter-spacing: -.035em; line-height: 1.1; }
  #project-settings-description, p { color: var(--piui-text-muted); font-size: 12px; line-height: 1.55; }
  #project-settings-description { margin: var(--piui-space-4) 0 0; }
  .rename-section { display: grid; gap: var(--piui-space-2); margin-top: var(--piui-space-6); }
  label, strong { color: var(--piui-text); font-size: 12px; font-weight: 700; }
  input { width: 100%; min-height: 42px; padding: 0 var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--piui-space-2); margin-top: var(--piui-space-3); }
  .button { min-height: 36px; padding: 0 var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 12px; font-weight: 700; }
  .button--quiet { background: transparent; color: var(--piui-text-muted); }.button--quiet:hover { background: var(--piui-surface-1); color: var(--piui-text); }
  .button--primary { background: var(--piui-accent); color: var(--piui-accent-ink); }
  .registry-section, .danger-section { display: flex; align-items: center; justify-content: space-between; gap: var(--piui-space-4); margin-top: var(--piui-space-5); padding-top: var(--piui-space-5); border-top: 1px solid var(--piui-border-subtle); }
  .registry-section p, .danger-section p { max-width: 42ch; margin: var(--piui-space-1) 0 0; }
  .button--danger-outline { border: 1px solid #704946; background: transparent; color: var(--piui-danger); }
  .button--danger { background: var(--piui-danger); color: #211110; }
  .remove-confirmation { width: 100%; margin-top: var(--piui-space-3); padding: var(--piui-space-3); border: 1px solid #704946; border-radius: var(--piui-radius-sm); background: rgba(116, 54, 45, .16); }
  .remove-confirmation p { margin: 0; color: var(--piui-text); }.mono { font-family: var(--piui-font-mono); }
  .error { margin: var(--piui-space-4) 0 0; color: var(--piui-danger); }
  .button:disabled { opacity: .55; }
  @media (max-width: 520px) { .registry-section, .danger-section { align-items: flex-start; flex-direction: column; }.registry-section > .button, .danger-section > .button { width: 100%; } }
</style>
