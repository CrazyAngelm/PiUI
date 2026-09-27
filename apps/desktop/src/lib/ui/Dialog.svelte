<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Hide the close button when the dialog requires an explicit choice. */
    dismissible?: boolean;
    closeLabel?: string;
    children?: Snippet;
    footer?: Snippet;
    onOpenChange?: (open: boolean) => void;
  }
  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    dismissible = true,
    closeLabel = 'Close',
    children,
    footer,
    onOpenChange,
  }: Props = $props();

  /**
   * A body taller than the dialog scrolls; it joins the tab order only then,
   * so keyboard users can scroll content that has nothing else to focus.
   */
  function keyboardScroll(node: HTMLElement): () => void {
    const update = () => {
      if (node.scrollHeight > node.clientHeight + 1) node.setAttribute('tabindex', '0');
      else node.removeAttribute('tabindex');
    };
    const resize = new ResizeObserver(update);
    resize.observe(node);
    const mutations = new MutationObserver(update);
    mutations.observe(node, { childList: true, subtree: true, characterData: true });
    update();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="piui-dialog__overlay" />
    <Dialog.Content
      class="piui-dialog piui-dialog--{size}"
      interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
      escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
    >
      <header class="piui-dialog__head">
        <div>
          <Dialog.Title class="piui-dialog__title">{title}</Dialog.Title>
          {#if description}
            <Dialog.Description class="piui-dialog__description">{description}</Dialog.Description>
          {/if}
        </div>
        {#if dismissible}
          <Dialog.Close class="piui-dialog__close" aria-label={closeLabel}>
            <X size={16} />
          </Dialog.Close>
        {/if}
      </header>
      {#if children}<div class="piui-dialog__body" {@attach keyboardScroll}>{@render children()}</div>{/if}
      {#if footer}<footer class="piui-dialog__foot">{@render footer()}</footer>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.piui-dialog__overlay) {
    position: fixed;
    inset: 0;
    z-index: var(--piui-z-overlay);
    background: var(--piui-overlay);
    animation: piui-fade-in var(--piui-duration) var(--piui-ease-out);
  }
  :global(.piui-dialog) {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: var(--piui-z-modal);
    display: flex;
    flex-direction: column;
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-lg);
    background: var(--piui-bg-raised);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-3);
    transform: translate(-50%, -50%);
    outline: none;
    animation: piui-dialog-in var(--piui-duration) var(--piui-ease-out);
  }
  :global(.piui-dialog--sm) {
    width: min(400px, calc(100vw - 32px));
  }
  :global(.piui-dialog--lg) {
    width: min(720px, calc(100vw - 32px));
  }
  :global(.piui-dialog--xl) {
    width: min(960px, calc(100vw - 32px));
  }
  .piui-dialog__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--piui-space-3);
    padding: var(--piui-space-4) var(--piui-space-4) 0;
  }
  :global(.piui-dialog__title) {
    margin: 0;
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
    line-height: var(--piui-leading-tight);
  }
  :global(.piui-dialog__description) {
    margin: 6px 0 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  :global(.piui-dialog__close) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: -4px -6px 0 0;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
  }
  :global(.piui-dialog__close:hover) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .piui-dialog__body {
    min-height: 0;
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  .piui-dialog__body:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
  .piui-dialog__foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3) var(--piui-space-4);
    border-top: 1px solid var(--piui-border-subtle);
  }
</style>
