<script lang="ts">
  import { onMount } from 'svelte';
  import { hostListen } from '../../host-api/transport';
  import { composerRequest, type ComposerCommand, type ComposerSnapshot } from '../../host-api/composerClient';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import { t } from '../locale/language';
  import RuntimePicker from './RuntimePicker.svelte';

  export let snapshot: SessionSnapshot;
  export let draft: string;
  export let updateDraft: (text: string) => void;
  export let refresh: () => void;
  export let interrupt: () => Promise<boolean>;
  export let interruptBusy = false;
  let state: ComposerSnapshot | undefined;
  let mode: 'follow-up' | 'steer' = 'follow-up';
  let busy = false;
  let error = '';
  let editing = '';
  let editText = '';
  let slashIndex = 0;
  let slashDismissed = false;
  let requestIdentity: { id: string; text: string; mode: 'prompt' | 'follow-up' | 'steer' } | undefined;
  const identityKey = () => `piui.composer.request.${snapshot.session.id}`;
  function accept(next: ComposerSnapshot): void {
    if (!state || next.queue.revision >= state.queue.revision) state = next;
  }
  $: running = snapshot.session.status === 'running';
  $: commands = [
    ...(state?.capabilities.compact ? [{ name: 'compact', description: 'Compact conversation context', enabled: snapshot.session.status === 'idle' && !state.queue.items.length }] : []),
    { name: 'stop', description: 'Stop the current turn', enabled: running },
  ];
  $: slash = !slashDismissed && /^\/[^\s]*$/.test(draft) ? commands.filter(command => command.name.startsWith(draft.slice(1))) : [];
  $: if (!running || !state?.capabilities.steer) mode = 'follow-up';

  async function read(): Promise<void> {
    try { accept(await composerRequest({ type: 'snapshot', sessionId: snapshot.session.id })); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The workspace operation could not be completed.'; }
  }
  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try { requestIdentity = JSON.parse(localStorage.getItem(identityKey()) ?? 'null') ?? undefined; } catch { /* A missing browser draft has no effect on the durable queue. */ }
    void hostListen<string>('piui://composer-v19', payload => { if (payload === snapshot.session.id) void read(); }).then(stop => { if (disposed) stop(); else { unlisten = stop; void read(); } });
    return () => { disposed = true; unlisten?.(); };
  });

  async function action(command: ComposerCommand): Promise<boolean> {
    if (busy) return false;
    busy = true; error = '';
    try { accept(await composerRequest(command)); refresh(); return true; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The workspace operation could not be completed.'; await read(); return false; }
    finally { busy = false; }
  }
  async function runCommand(name: string): Promise<void> {
    const command = commands.find(item => item.name === name);
    if (!command || !command.enabled) { error = 'This command is unavailable in the current session state.'; return; }
    if (name === 'stop') { if (await interrupt()) updateDraft(''); }
    else if (await action({ type: 'compact', sessionId: snapshot.session.id })) updateDraft('');
    slashDismissed = true;
  }
  async function send(): Promise<void> {
    if (busy || !draft.trim() || !state) return;
    if (commands.some(command => draft.trim() === `/${command.name}`)) { await runCommand(draft.trim().slice(1)); return; }
    const text = draft;
    const effectiveMode = running ? mode : 'prompt';
    if (!requestIdentity || requestIdentity.text !== text) {
      requestIdentity = { id: crypto.randomUUID(), text, mode: effectiveMode };
      try { localStorage.setItem(identityKey(), JSON.stringify(requestIdentity)); }
      catch { error = 'Could not preserve the send request. Your message has not been sent.'; requestIdentity = undefined; return; }
    }
    if (await action({ type: 'send', sessionId: snapshot.session.id, requestId: requestIdentity.id, text, mode: requestIdentity.mode })) {
      if (draft === text) updateDraft('');
      requestIdentity = undefined; try { localStorage.removeItem(identityKey()); } catch { /* Durable request ID already prevents duplicate delivery. */ }
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (slash.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length;
    } else if (event.key === 'Escape') { slashDismissed = true; }
    else if (slash.length && event.key === 'Tab') {
      event.preventDefault(); updateDraft(`/${slash[slashIndex % slash.length].name}`);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (slash.length) void runCommand(slash[slashIndex % slash.length].name); else void send();
    }
  }
</script>

{#if state?.queue.items.length}
  <section class="outbox" aria-label={$t('Message queue')}>
    <div class="queue-heading"><strong>{$t('Message queue')}</strong>{#if state.queue.paused}<span>{$t('Queue paused')}</span><button disabled={busy || state.queue.items.some(item => item.status === 'uncertain' || item.status === 'sending')} on:click={() => action({ type: 'resume', sessionId: snapshot.session.id })}>{$t('Resume queue')}</button>{/if}</div>
    {#each state.queue.items as item (item.id)}
      <article>
        {#if editing === item.id && item.status === 'queued'}
          <label for={`queued-${item.id}`}>{$t('Edit queued message')}</label><textarea id={`queued-${item.id}`} bind:value={editText}></textarea>
          <button disabled={busy || !editText.trim()} on:click={async () => { if (await action({ type: 'edit', sessionId: snapshot.session.id, requestId: item.id, text: editText })) editing = ''; }}>{$t('Save')}</button>
          <button on:click={() => editing = ''}>{$t('Cancel')}</button>
        {:else}
          <p class="queued-text">{item.text}</p>{#if item.error}<p class="error" role="status">{$t(item.error)}</p>{/if}
          <div class="queue-actions"><span>{$t(item.status === 'queued' ? 'Queued' : item.status === 'sending' ? 'Sending…' : 'Delivery uncertain — check chat history before dismissing. It will not be resent automatically.')}</span>
            {#if item.status === 'queued'}<button disabled={busy} on:click={() => { editing = item.id; editText = item.text; }}>{$t('Edit')}</button>
              {#if running && state.capabilities.steer}<button disabled={busy} on:click={() => action({ type: 'promote', sessionId: snapshot.session.id, requestId: item.id })}>{$t('Send now as Steer')}</button>{/if}
            {/if}
            {#if item.status !== 'sending'}<button disabled={busy} on:click={() => action({ type: 'remove', sessionId: snapshot.session.id, requestId: item.id })}>{$t(item.status === 'uncertain' ? 'Dismiss after checking history' : 'Remove')}</button>{/if}
          </div>
        {/if}
      </article>
    {/each}
  </section>
{/if}
<div class="composer">
  {#if slash.length}<div class="slash-list" id="composer-commands" role="listbox" aria-label={$t('Available commands')}>
    {#each slash as command, index}<button id={`composer-command-${index}`} type="button" role="option" aria-selected={index === slashIndex % slash.length} aria-disabled={!command.enabled} on:click={() => runCommand(command.name)}><strong>/{command.name}</strong><span>{$t(command.description)}</span>{#if !command.enabled}<small>{$t('Unavailable now')}</small>{/if}</button>{/each}
  </div>{/if}
  <label class="sr-only" for="session-draft">{$t('Message')}</label>
  <textarea id="session-draft" value={draft} on:input={event => { updateDraft(event.currentTarget.value); slashDismissed = false; slashIndex = 0; }} on:keydown={keydown} aria-controls={slash.length ? 'composer-commands' : undefined} aria-activedescendant={slash.length ? `composer-command-${slashIndex % slash.length}` : undefined} placeholder={$t(running ? 'Queue a follow-up…' : 'Write a message…')} rows="2"></textarea>
  <div class="composer-actions"><div class="runtime-options">
    <RuntimePicker session={snapshot.session} disabled={busy || snapshot.session.status !== 'idle' || !snapshot.capabilities.models.supported} onchange={refresh} />
    {#if running}<label>{$t('Send mode')}<select bind:value={mode}><option value="follow-up">{$t('Follow up')}</option><option value="steer" disabled={!state?.capabilities.steer}>{$t('Steer')}</option></select></label>{#if state && !state.capabilities.steer}<span class="mode-help">{$t('This harness cannot steer an active turn.')}</span>{/if}{/if}
  </div>
  {#if running || snapshot.session.status === 'stopping'}<button class="stop" type="button" on:click={interrupt} disabled={interruptBusy || snapshot.session.status === 'stopping'}>{$t(interruptBusy ? 'Stopping…' : 'Stop turn')}</button>{/if}
  <button class="accent" type="button" on:click={send} disabled={busy || !state || !draft.trim()}>{$t(busy ? 'Sending…' : running ? mode === 'steer' ? 'Steer' : 'Follow up' : 'Send')}</button></div>
</div>
<p class="composer-hint">{$t('Enter to send · Shift+Enter for a new line · / for commands')}</p>
{#if error}<p class="error" role="alert">{$t(error)}</p>{/if}

<style>
  button, select { color: var(--piui-text); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-bg-raised); padding: 6px 10px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.accent { background: var(--piui-action); color: var(--piui-action-ink); border-color: var(--piui-accent); }
  button.stop { color: var(--piui-danger); border-color: var(--piui-danger-border); }
  button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .composer { flex-shrink:0; position: relative; border: 1px solid var(--piui-border); border-radius: 14px; padding: 12px; background: var(--piui-bg-raised); }
  textarea { width: 100%; resize: vertical; border: 0; background: transparent; color: inherit; font: inherit; min-height: 64px; }
  .composer-actions, .runtime-options, .queue-heading, .queue-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .composer-actions { justify-content: flex-end; } .runtime-options { margin-right: auto; }
  label { display: flex; align-items: center; gap: 8px; }
  .outbox { min-height:0; overflow:auto; border: 1px solid var(--piui-border); border-radius: 12px; margin-bottom: 8px; padding: 12px; }
  article + article { border-top: 1px solid var(--piui-border); margin-top: 8px; padding-top: 8px; }
  .queued-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
  .queue-actions span, .queue-heading span, .composer-hint, .mode-help { font-size: 12px; color: var(--piui-text-muted); }
  .queue-actions span { margin-right: auto; } .queue-heading strong { margin-right: auto; }
  .slash-list { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--piui-bg-raised); border: 1px solid var(--piui-border); border-radius: 10px; padding: 6px; z-index: 2; }
  .slash-list button { display: flex; width: 100%; text-align: left; gap: 12px; padding: 10px; } .slash-list button[aria-selected="true"] { outline: 2px solid var(--piui-accent); } .slash-list small { margin-left: auto; }
  .composer-hint { flex-shrink:0; text-align: center; margin: 8px 0; } .error { color: var(--piui-danger); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
