<script lang="ts">
  export let eyebrow = 'PiUI';
  export let title: string;
  export let description: string;
  /** Use inside a chat workspace so its composer remains anchored at the bottom. */
  export let fill = false;
  export let actionLabel: string | undefined = undefined;
  export let action: (() => void) | undefined = undefined;
</script>

<section class:empty-state--fill={fill} class="empty-state" aria-live="polite">
  <p class="eyebrow">{eyebrow}</p>
  <h1>{title}</h1>
  <p>{description}</p>
  {#if actionLabel && action}
    <button class="button button--primary" type="button" onclick={action}>{actionLabel}</button>
  {/if}
</section>

<style>
  .empty-state {
    display: grid;
    align-content: center;
    justify-items: start;
    min-height: min(66dvh, 620px);
    max-width: 520px;
    margin: 0 auto;
    padding: var(--piui-space-8);
  }

  .empty-state.empty-state--fill {
    flex: 1 1 0;
    min-height: 0;
  }

  .eyebrow {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-accent);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  h1 {
    max-width: 14ch;
    margin: 0;
    font-size: clamp(28px, 4vw, 44px);
    font-weight: 680;
    letter-spacing: -0.045em;
    line-height: 1.04;
  }

  p:not(.eyebrow) {
    max-width: 52ch;
    margin: var(--piui-space-4) 0 0;
    color: var(--piui-text-muted);
    line-height: 1.6;
  }

  .button {
    margin-top: var(--piui-space-6);
    padding: 10px 14px;
    border-radius: var(--piui-radius-sm);
    font-weight: 700;
  }

  .button--primary {
    background: var(--piui-accent);
    color: var(--piui-accent-ink);
  }

  .button--primary:hover {
    background: #b2cf97;
  }
</style>
