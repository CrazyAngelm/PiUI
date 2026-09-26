<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Info from '@lucide/svelte/icons/info';
  import { toasts, type ToastTone } from './toast.svelte';

  interface Props {
    dismissLabel?: string;
  }
  let { dismissLabel = 'Dismiss' }: Props = $props();

  const icons: Record<ToastTone, typeof Info> = {
    neutral: Info,
    success: CircleCheck,
    warning: TriangleAlert,
    danger: CircleAlert,
  };
</script>

<section class="toaster" aria-live="polite" aria-relevant="additions">
  {#each toasts.items as toast (toast.id)}
    {@const Icon = icons[toast.tone]}
    <div class="toast toast--{toast.tone}" role={toast.tone === 'danger' ? 'alert' : 'status'}>
      <span class="toast__icon"><Icon size={16} /></span>
      <div class="toast__body">
        <strong>{toast.title}</strong>
        {#if toast.description}<p>{toast.description}</p>{/if}
      </div>
      {#if toast.action}
        {@const action = toast.action}
        <button
          type="button"
          class="toast__action"
          onclick={() => {
            action.run();
            toasts.dismiss(toast.id);
          }}>{action.label}</button
        >
      {/if}
      <button type="button" class="toast__close" aria-label={dismissLabel} onclick={() => toasts.dismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  {/each}
</section>

<style>
  .toaster {
    position: fixed;
    right: var(--piui-space-4);
    bottom: var(--piui-space-4);
    z-index: var(--piui-z-toast);
    display: grid;
    gap: var(--piui-space-2);
    width: min(380px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
    pointer-events: auto;
    animation: piui-toast-in var(--piui-duration) var(--piui-ease-out);
  }
  .toast__icon {
    display: inline-flex;
    margin-top: 1px;
    color: var(--piui-text-muted);
  }
  .toast--success .toast__icon {
    color: var(--piui-success);
  }
  .toast--warning .toast__icon {
    color: var(--piui-warning);
  }
  .toast--danger {
    border-color: var(--piui-danger-border);
  }
  .toast--danger .toast__icon {
    color: var(--piui-danger);
  }
  .toast__body {
    flex: 1;
    min-width: 0;
  }
  .toast__body strong {
    display: block;
    font-weight: var(--piui-weight-semibold);
  }
  .toast__body p {
    margin: 2px 0 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .toast__action {
    flex: none;
    padding: 2px 8px;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-hover);
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .toast__close {
    display: inline-flex;
    flex: none;
    padding: 2px;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
  }
  .toast__close:hover {
    color: var(--piui-text);
  }
</style>
