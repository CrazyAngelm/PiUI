<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { CommentMentionV1 } from '../../host-api/boardClient';
  import type { TeammateV1 } from '../../host-api/teammatesClient';
  import { activeHandleQuery, insertHandle, mentionSpans, rankTeammates } from './handle';
  import TeammateAvatar from './TeammateAvatar.svelte';

  /**
   * A textarea with `@handle` autocomplete for teammates (ADR-041). Used by
   * card comments; the chat composer can reuse it for `@teammate` handoffs.
   * Submits the body with `CommentMentionV1` spans for known handles.
   */
  interface Props {
    teammates: readonly TeammateV1[];
    label: string;
    placeholder?: string;
    submitLabel: string;
    disabled?: boolean;
    busy?: boolean;
    /** Resolves when the host accepted the text; the box then clears. */
    onSubmit: (body: string, mentions: CommentMentionV1[]) => Promise<void>;
  }
  let { teammates, label, placeholder = '', submitLabel, disabled = false, busy = false, onSubmit }: Props = $props();

  const id = `mention-${Math.random().toString(36).slice(2, 9)}`;
  let text = $state('');
  let caret = $state(0);
  let index = $state(0);
  let dismissed = $state(false);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  const query = $derived(dismissed ? undefined : activeHandleQuery(text, caret));
  const options = $derived(query === undefined ? [] : rankTeammates(teammates, query.query));
  const open = $derived(options.length > 0);
  const active = $derived(options.length ? index % options.length : 0);

  function sync(): void {
    caret = textarea?.selectionStart ?? text.length;
  }

  async function choose(teammate: TeammateV1): Promise<void> {
    const next = insertHandle(text, caret, teammate.handle);
    text = next.text;
    caret = next.caret;
    index = 0;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(next.caret, next.caret);
  }

  async function submit(): Promise<void> {
    const body = text.trim();
    if (!body || busy || disabled) return;
    await onSubmit(body, mentionSpans(body, teammates));
    text = '';
    caret = 0;
  }

  function keydown(event: KeyboardEvent): void {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = (active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const teammate = options[active];
        if (teammate) {
          event.preventDefault();
          void choose(teammate);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissed = true;
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit().catch(() => undefined);
    }
  }
</script>

<div class="mention">
  <textarea
    bind:this={textarea}
    bind:value={text}
    class="mention__input"
    rows="3"
    aria-label={label}
    {placeholder}
    {disabled}
    role="combobox"
    aria-expanded={open}
    aria-autocomplete="list"
    aria-controls={open ? `${id}-list` : undefined}
    aria-activedescendant={open ? `${id}-${active}` : undefined}
    oninput={() => {
      sync();
      dismissed = false;
      index = 0;
    }}
    onkeyup={(event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) sync();
    }}
    onclick={sync}
    onkeydown={keydown}
  ></textarea>
  {#if open}
    <ul class="mention__list" id={`${id}-list`} role="listbox" aria-label={$t('Teammates')}>
      {#each options as teammate, position (teammate.id)}
        <li
          id={`${id}-${position}`}
          role="option"
          aria-selected={position === active}
          class="mention__option"
          class:mention__option--active={position === active}
          onpointerdown={(event) => {
            event.preventDefault();
            void choose(teammate);
          }}
        >
          <TeammateAvatar avatar={teammate.avatar} color={teammate.color} size={18} />
          <span class="mention__handle">@{teammate.handle}</span>
          <span class="mention__name">{teammate.name}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="mention__bar">
    <span class="mention__hint">{$t('Type @ to mention a teammate · Ctrl+Enter sends')}</span>
    <button type="button" class="mention__send" onclick={() => void submit().catch(() => undefined)} disabled={disabled || busy || !text.trim()}>
      {submitLabel}
    </button>
  </div>
</div>

<style>
  .mention {
    position: relative;
    display: grid;
    gap: 6px;
  }
  .mention__input {
    width: 100%;
    min-height: 64px;
    padding: 8px 10px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font: inherit;
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
    resize: vertical;
  }
  .mention__input:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -1px;
  }
  .mention__list {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% - 64px + 4px);
    z-index: var(--piui-z-dropdown);
    display: grid;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
    list-style: none;
  }
  .mention__option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: var(--piui-radius-sm);
    cursor: pointer;
  }
  .mention__option--active {
    background: var(--piui-chaos-streak), var(--piui-hover);
  }
  .mention__handle {
    font-weight: var(--piui-weight-medium);
  }
  .mention__name {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .mention__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mention__hint {
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .mention__send {
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-action);
    color: var(--piui-action-ink);
    font-size: var(--piui-text-sm);
  }
  .mention__send:disabled {
    opacity: 0.5;
  }
</style>
