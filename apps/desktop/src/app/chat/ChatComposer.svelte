<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Square from '@lucide/svelte/icons/square';
  import Pencil from '@lucide/svelte/icons/pencil';
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import { composerRequest, listenComposer, type ComposerCommand, type ComposerSnapshot } from '../../host-api/composerClient';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import { Button, IconButton, Segmented, Spinner, Textarea } from '../../lib/ui';
  import { errorMessage } from '../workspaceStore.svelte';
  import RuntimeChip from './RuntimeChip.svelte';

  interface Props {
    snapshot: SessionSnapshot;
    draft: string;
    updateDraft: (text: string) => void;
    refresh: () => void;
    interrupt: () => Promise<boolean>;
    interruptBusy?: boolean;
  }
  let { snapshot, draft, updateDraft, refresh, interrupt, interruptBusy = false }: Props = $props();

  interface Pending {
    id: string;
    text: string;
    mode: 'prompt' | 'follow-up' | 'steer';
  }

  let composer = $state.raw<ComposerSnapshot | undefined>();
  let mode = $state<'follow-up' | 'steer'>('follow-up');
  let busy = $state(false);
  let error = $state('');
  let editing = $state('');
  let editText = $state('');
  let slashIndex = $state(0);
  let slashDismissed = $state(false);
  let text = $state(draft);
  let input = $state<HTMLTextAreaElement | null>(null);

  const sessionId = $derived(snapshot.session.id);
  const identityKey = $derived(`piui.composer.request.${sessionId}`);
  const running = $derived(snapshot.session.status === 'running');
  const stopping = $derived(snapshot.session.status === 'stopping');
  const canSteer = $derived(Boolean(composer?.capabilities.steer));
  const commands = $derived([
    ...(composer?.capabilities.compact
      ? [{ name: 'compact', description: 'Compact conversation context', enabled: snapshot.session.status === 'idle' && !composer.queue.items.length }]
      : []),
    { name: 'stop', description: 'Stop the current turn', enabled: running },
  ]);
  const slash = $derived(
    !slashDismissed && /^\/[^\s]*$/.test(text) ? commands.filter((command) => command.name.startsWith(text.slice(1))) : [],
  );
  const queue = $derived(composer?.queue.items.filter((item) => item.status !== 'sent' && item.status !== 'cancelled') ?? []);

  $effect(() => {
    if (!running || !canSteer) mode = 'follow-up';
  });

  function accept(next: ComposerSnapshot): void {
    if (!composer || next.queue.revision >= composer.queue.revision) composer = next;
  }

  async function read(): Promise<void> {
    try {
      accept(await composerRequest({ type: 'snapshot', sessionId }));
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenComposer(sessionId, () => void read()).then((stop) => {
      if (disposed) stop();
      else {
        unlisten = stop;
        void read();
      }
    });
    queueMicrotask(() => input?.focus());
    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  async function action(command: ComposerCommand): Promise<boolean> {
    if (busy) return false;
    busy = true;
    error = '';
    try {
      accept(await composerRequest(command));
      refresh();
      return true;
    } catch (cause) {
      error = errorMessage(cause);
      await read();
      return false;
    } finally {
      busy = false;
    }
  }

  function setText(value: string): void {
    text = value;
    updateDraft(value);
  }

  async function runCommand(name: string): Promise<void> {
    const command = commands.find((item) => item.name === name);
    if (!command || !command.enabled) {
      error = 'This command is unavailable in the current session state.';
      return;
    }
    if (name === 'stop') {
      if (await interrupt()) setText('');
    } else if (await action({ type: 'compact', sessionId })) {
      setText('');
    }
    slashDismissed = true;
  }

  function loadIdentity(): Pending | undefined {
    try {
      return (JSON.parse(localStorage.getItem(identityKey) ?? 'null') as Pending | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function send(): Promise<void> {
    if (busy || !text.trim() || !composer) return;
    if (commands.some((command) => text.trim() === `/${command.name}`)) {
      await runCommand(text.trim().slice(1));
      return;
    }
    const message = text;
    const effectiveMode = running ? mode : 'prompt';
    // A durable request id prevents duplicate delivery if the reply is lost.
    let identity = loadIdentity();
    if (!identity || identity.text !== message) {
      identity = { id: crypto.randomUUID(), text: message, mode: effectiveMode };
      try {
        localStorage.setItem(identityKey, JSON.stringify(identity));
      } catch {
        error = 'Could not preserve the send request. Your message has not been sent.';
        return;
      }
    }
    if (await action({ type: 'send', sessionId, requestId: identity.id, text: message, mode: identity.mode })) {
      if (text === message) setText('');
      try {
        localStorage.removeItem(identityKey);
      } catch {
        // The durable request id already prevents duplicate delivery.
      }
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (slash.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length;
    } else if (event.key === 'Escape' && slash.length) {
      event.preventDefault();
      slashDismissed = true;
    } else if (slash.length && event.key === 'Tab') {
      event.preventDefault();
      setText(`/${slash[slashIndex % slash.length].name}`);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (slash.length) void runCommand(slash[slashIndex % slash.length].name);
      else void send();
    }
  }

  function statusText(status: string): string {
    if (status === 'queued') return $t('Queued');
    if (status === 'sending') return $t('Sending…');
    return $t('Delivery uncertain — check the chat before dismissing. It will not be resent automatically.');
  }
</script>

<div class="composer-wrap">
  {#if queue.length}
    <section class="queue" aria-label={$t('Message queue')}>
      <header>
        <span>{$t('Queued messages')}</span>
        {#if composer?.queue.paused}
          <span class="queue__paused">{$t('Queue paused')}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || queue.some((item) => item.status === 'uncertain' || item.status === 'sending')}
            onclick={() => void action({ type: 'resume', sessionId })}>{$t('Resume queue')}</Button
          >
        {/if}
      </header>
      {#each queue as item (item.id)}
        <article class="queue__item" class:queue__item--warn={item.status === 'uncertain'}>
          {#if editing === item.id && item.status === 'queued'}
            <Textarea bind:value={editText} minRows={2} maxRows={6} aria-label={$t('Edit queued message')} />
            <div class="queue__actions">
              <Button size="sm" variant="ghost" onclick={() => (editing = '')}>{$t('Cancel')}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !editText.trim()}
                onclick={async () => {
                  if (await action({ type: 'edit', sessionId, requestId: item.id, text: editText })) editing = '';
                }}>{$t('Save')}</Button
              >
            </div>
          {:else}
            <p class="queue__text">{item.text}</p>
            <div class="queue__actions">
              <span class="queue__status">
                {#if item.status === 'sending'}<Spinner size={10} />{/if}
                {statusText(item.status)}
              </span>
              {#if item.error}<span class="queue__error">{$t(item.error)}</span>{/if}
              {#if item.status === 'queued'}
                <IconButton
                  size="sm"
                  label={$t('Edit')}
                  onclick={() => {
                    editing = item.id;
                    editText = item.text;
                  }}><Pencil /></IconButton
                >
                {#if running && canSteer}
                  <IconButton size="sm" label={$t('Send now as Steer')} onclick={() => void action({ type: 'promote', sessionId, requestId: item.id })}><CornerDownRight /></IconButton>
                {/if}
              {/if}
              {#if item.status !== 'sending'}
                <IconButton
                  size="sm"
                  label={item.status === 'uncertain' ? $t('Dismiss after checking history') : $t('Remove')}
                  onclick={() => void action({ type: 'remove', sessionId, requestId: item.id })}><X /></IconButton
                >
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}

  <div class="composer" class:composer--running={running}>
    {#if slash.length}
      <div class="slash" id="composer-commands" role="listbox" aria-label={$t('Available commands')}>
        {#each slash as command, index (command.name)}
          <button
            type="button"
            id={`composer-command-${index}`}
            role="option"
            aria-selected={index === slashIndex % slash.length}
            aria-disabled={!command.enabled}
            onclick={() => void runCommand(command.name)}
          >
            <strong>/{command.name}</strong>
            <span>{$t(command.description)}</span>
            {#if !command.enabled}<small>{$t('Unavailable now')}</small>{/if}
          </button>
        {/each}
      </div>
    {/if}
    <Textarea
      bind:ref={input}
      value={text}
      oninput={(event) => {
        setText(event.currentTarget.value);
        slashDismissed = false;
        slashIndex = 0;
      }}
      onkeydown={keydown}
      minRows={1}
      maxRows={14}
      class="composer__input"
      aria-label={$t('Message')}
      aria-controls={slash.length ? 'composer-commands' : undefined}
      aria-activedescendant={slash.length ? `composer-command-${slashIndex % slash.length}` : undefined}
      placeholder={running ? $t('Queue a follow-up…') : $t('Reply, ask for changes or type / for commands…')}
    />
    <div class="composer__bar">
      <div class="composer__left">
        <RuntimeChip
          session={snapshot.session}
          disabled={busy || snapshot.session.status !== 'idle' || !snapshot.capabilities.models.supported}
          onchange={refresh}
        />
        {#if running && canSteer}
          <Segmented
            size="sm"
            label={$t('Send mode')}
            bind:value={mode}
            options={[
              { value: 'follow-up', label: $t('Follow up'), title: $t('Send after the current turn finishes') },
              { value: 'steer', label: $t('Steer'), title: $t('Redirect the running turn now') },
            ]}
          />
        {/if}
      </div>
      <div class="composer__right">
        {#if running || stopping}
          <IconButton label={interruptBusy || stopping ? $t('Stopping…') : $t('Stop turn')} shortcut="Mod+." variant="subtle" disabled={interruptBusy || stopping} onclick={() => void interrupt()}>
            <Square />
          </IconButton>
        {/if}
        <button
          type="button"
          class="send"
          onclick={() => void send()}
          disabled={busy || !composer || !text.trim()}
          aria-label={running ? (mode === 'steer' ? $t('Steer') : $t('Follow up')) : $t('Send')}
        >
          {#if busy}<Spinner size={14} />{:else}<ArrowUp size={16} />{/if}
        </button>
      </div>
    </div>
  </div>
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
</div>

<style>
  .composer-wrap {
    display: grid;
    gap: var(--piui-space-2);
  }
  .queue {
    display: grid;
    gap: 6px;
    max-height: 30vh;
    padding: var(--piui-space-2) var(--piui-space-3);
    overflow-y: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .queue header {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .queue__paused {
    margin-left: auto;
    color: var(--piui-warning);
    letter-spacing: 0;
    text-transform: none;
  }
  .queue__item {
    display: grid;
    gap: 4px;
    padding: 6px 0;
  }
  .queue__item + .queue__item {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .queue__item--warn .queue__status {
    color: var(--piui-warning);
  }
  .queue__text {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .queue__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
  }
  .queue__status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .queue__error {
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
  .composer {
    position: relative;
    border: 1px solid var(--piui-border);
    border-radius: 14px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    transition: border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .composer:focus-within {
    border-color: var(--piui-border-strong);
  }
  .composer :global(.composer__input) {
    padding: 12px 14px 4px;
    border: 0;
    background: transparent;
    font-size: var(--piui-chat-composer-font-size);
    resize: none;
  }
  .composer :global(.composer__input:focus-visible) {
    box-shadow: none;
  }
  .composer__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
    padding: 4px 8px 8px 8px;
  }
  .composer__left,
  .composer__right {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 50%;
    background: var(--piui-action);
    color: var(--piui-action-ink);
    transition: background-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .send:hover:not(:disabled) {
    background: var(--piui-action-hover);
  }
  .send:disabled {
    background: var(--piui-surface-3);
    color: var(--piui-text-disabled);
    opacity: 1;
  }
  .slash {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: var(--piui-z-dropdown);
    display: grid;
    padding: 4px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
  }
  .slash button {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    padding: 8px 10px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .slash button[aria-selected='true'] {
    background: var(--piui-hover);
  }
  .slash button[aria-disabled='true'] {
    opacity: 0.5;
  }
  .slash span {
    color: var(--piui-text-muted);
  }
  .slash small {
    margin-left: auto;
    color: var(--piui-text-disabled);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
