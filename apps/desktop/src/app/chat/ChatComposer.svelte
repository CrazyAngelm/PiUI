<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Square from '@lucide/svelte/icons/square';
  import Pencil from '@lucide/svelte/icons/pencil';
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
  import ImageIcon from '@lucide/svelte/icons/image';
  import X from '@lucide/svelte/icons/x';
  import { onMount, tick, untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { composerRequest, listenComposer, type ComposerCommand, type ComposerSnapshot } from '../../host-api/composerClient';
  import type { ComposerImage } from '../../host-api/composerInputsClient';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import { composerSupport, imageSupport } from '../../harness-adapters/composer';
  import { Button, IconButton, Segmented, Spinner, Textarea } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
  import { errorMessage } from '../workspaceStore.svelte';
  import { runLauncher } from '../triggers/runLauncher.svelte';
  import RuntimeChip from './RuntimeChip.svelte';
  import ExecutorPicker, { type Executor } from '../chatPipelines/ExecutorPicker.svelte';
  import PipelineInputsBar from '../chatPipelines/PipelineInputsBar.svelte';
  import { chatPipelines, type ChatPipelineDetail } from '../chatPipelines/chatPipelines.svelte';
  import AttachButton from './composer/AttachButton.svelte';
  import AttachmentChips from './composer/AttachmentChips.svelte';
  import AttachmentNotices from './composer/AttachmentNotices.svelte';
  import MentionMenu from './composer/MentionMenu.svelte';
  import ReferenceDialog from './composer/ReferenceDialog.svelte';
  import { ComposerAttachments } from './composer/composerAttachments.svelte';
  import { FileMentions, loadComposerCatalog, type NativeEntries } from './composer/composerLookups.svelte';
  import { composerDropTargets } from './composer/dropTargets.svelte';
  import { activeMention, fileMention, rankFiles, rankNamed, replaceMention } from './composer/mentions';
  import type { ComposerMenuItem } from './composer/menuItems';
  import HandoffChips from '../board/HandoffChips.svelte';
  import { boards } from '../board/boardStore.svelte';
  import { rankTeammates } from '../team/handle';
  import { teammates } from '../team/teammatesStore.svelte';

  interface Props {
    snapshot: SessionSnapshot;
    draft: string;
    updateDraft: (text: string) => void;
    /** Pending images of this chat's draft (composer inputs v1). */
    images?: readonly ComposerImage[];
    updateImages?: (images: readonly ComposerImage[]) => void;
    refresh: () => void;
    interrupt: () => Promise<boolean>;
    interruptBusy?: boolean;
    safeMode?: boolean;
  }
  let { snapshot, draft, updateDraft, images = [], updateImages = () => undefined, refresh, interrupt, interruptBusy = false, safeMode = false }: Props = $props();

  interface Pending {
    id: string;
    text: string;
    mode: 'prompt' | 'follow-up' | 'steer';
    attachments?: string[];
  }

  let composer = $state.raw<ComposerSnapshot | undefined>();
  let mode = $state<'follow-up' | 'steer'>('follow-up');
  let busy = $state(false);
  let error = $state('');
  let editing = $state('');
  let editText = $state('');
  let menuIndex = $state(0);
  let menuDismissed = $state(false);
  // Keyed per chat by the parent: the saved draft seeds the editor once.
  let text = $state(untrack(() => draft));
  let caret = $state(untrack(() => draft.length));
  let input = $state<HTMLTextAreaElement | null>(null);
  let catalog = $state.raw<NativeEntries>({ commands: [], skills: [] });
  let htmlDragging = $state(false);
  const attachments = new ComposerAttachments(untrack(() => images), (next) => updateImages(next));
  const fileMentions = new FileMentions();

  const sessionId = $derived(snapshot.session.id);
  const workspaceId = $derived(snapshot.session.workspaceId);
  const harness = $derived(snapshot.session.harness);
  const harnessLabel = $derived(harnessMeta(harness).short);
  const support = $derived(composerSupport(harness));
  // The open session's report is authoritative; before it arrives, the manifest.
  const imageState = $derived(imageSupport(harness, composer ? Boolean(composer.capabilities.images) : undefined));
  const identityKey = $derived(`piui.composer.request.${sessionId}`);
  const running = $derived(snapshot.session.status === 'running');
  const stopping = $derived(snapshot.session.status === 'stopping');
  const canSteer = $derived(Boolean(composer?.capabilities.steer));
  const commands = $derived([
    ...(composer?.capabilities.compact
      ? [{ name: 'compact', description: 'Compact conversation context', enabled: snapshot.session.status === 'idle' && !composer.queue.items.length }]
      : []),
    { name: 'stop', description: 'Stop the current turn', enabled: running },
    { name: 'run', description: 'Run a saved pipeline of this project', enabled: true },
  ]);
  // A PiUI command wins over a native one of the same name: PiUI runs it on send.
  const nativeCommands = $derived(catalog.commands.filter((command) => !commands.some((own) => own.name === command.name)));
  // `@` also mentions teammates when the project board is on (ADR-041).
  const teamMentions = $derived(boards.stores.get(workspaceId)?.enabled === true);
  const mention = $derived(
    menuDismissed
      ? undefined
      : activeMention(text, caret, { slash: true, at: Boolean(workspaceId), dollar: support.skillMentions && catalog.skills.length > 0 }),
  );
  $effect(() => {
    const id = workspaceId;
    if (mention?.trigger !== '@' || !id) return;
    untrack(() => {
      boards.ensure([id]);
      void teammates.ensure(id);
    });
  });
  const SOURCE_LABELS: Readonly<Record<string, string>> = { extension: 'extension', prompt: 'prompt', skill: 'skill' };

  type Menu =
    | { kind: 'slash'; items: ComposerMenuItem[] }
    | { kind: 'file'; items: ComposerMenuItem[]; paths: string[]; handles: string[] }
    | { kind: 'skill'; items: ComposerMenuItem[]; mentions: string[] };
  const menu = $derived.by((): Menu | undefined => {
    if (!mention) return undefined;
    if (mention.trigger === '/') {
      const own = commands
        .filter((command) => command.name.startsWith(mention.query))
        .map((command): ComposerMenuItem => ({
          key: `piui:${command.name}`,
          title: `/${command.name}`,
          detail: $t(command.description),
          badge: 'PiUI',
          disabled: !command.enabled,
          ...(command.enabled ? {} : { note: $t('Unavailable now') }),
        }));
      const native = rankNamed(nativeCommands, mention.query).map((command): ComposerMenuItem => ({
        key: `native:${command.name}`,
        title: `/${command.name}`,
        ...(command.description ? { detail: command.description } : {}),
        ...(command.hint ? { hint: command.hint } : {}),
        badge: SOURCE_LABELS[command.source] ? `${harnessLabel} · ${$t(SOURCE_LABELS[command.source] ?? '')}` : harnessLabel,
      }));
      return own.length || native.length ? { kind: 'slash', items: [...own, ...native] } : undefined;
    }
    if (mention.trigger === '@') {
      // Teammates of a project with a board come first, as their own group (ADR-041).
      const team = teamMentions ? rankTeammates(teammates.list(workspaceId), mention.query) : [];
      const paths = rankFiles(fileMentions.files, mention.query);
      const people = team.map((teammate): ComposerMenuItem => ({
        key: `teammate:${teammate.id}`,
        title: `@${teammate.handle}`,
        ...(teammate.role ? { detail: teammate.role } : {}),
        group: $t('Teammates'),
        avatar: { avatar: teammate.avatar, color: teammate.color },
      }));
      const files = paths.map((path): ComposerMenuItem => ({ key: `file:${path}`, title: path, ...(people.length ? { group: $t('Project files') } : {}) }));
      return { kind: 'file', paths, handles: team.map((teammate) => teammate.handle), items: [...people, ...files] };
    }
    const skills = rankNamed(catalog.skills, mention.query);
    return {
      kind: 'skill',
      mentions: skills.map((skill) => skill.mention),
      items: skills.map((skill) => ({
        key: `skill:${skill.name}`,
        title: skill.mention,
        ...(skill.description ? { detail: skill.description } : {}),
        badge: harnessLabel,
      })),
    };
  });
  const menuId = $derived(`composer-menu-${sessionId}`);
  const menuLabel = $derived(
    menu?.kind === 'file' ? (menu.handles.length ? $t('Teammates and project files') : $t('Project files')) : menu?.kind === 'skill' ? $t('Skills') : $t('Available commands'),
  );
  const menuEmpty = $derived(
    menu?.kind === 'file'
      ? fileMentions.loading
        ? $t('Loading project files…')
        : fileMentions.error
          ? $t(fileMentions.error)
          : $t('No matching files')
      : $t('No matches'),
  );
  const activeIndex = $derived(menu && menu.items.length ? menuIndex % menu.items.length : 0);
  const queue = $derived(composer?.queue.items.filter((item) => item.status !== 'sent' && item.status !== 'cancelled') ?? []);

  // The next message may go through a saved pipeline instead (ADR-040); after
  // that run starts, the chat talks to its own agent again.
  const pipelineId = $derived(chatPipelines.chats[sessionId]?.launchCommandId ?? '');
  const executor = $derived<Executor>(pipelineId ? { kind: 'pipeline', commandId: pipelineId } : { kind: 'direct', harness });
  const pendingResults = $derived(chatPipelines.pendingResults(sessionId).filter((run) => run.status === 'succeeded').length);
  let pipelineDetail = $state.raw<ChatPipelineDetail | undefined>();
  let pipelineLoading = $state(false);
  let pipelineError = $state('');
  let inputsBar = $state<ReturnType<typeof PipelineInputsBar> | undefined>();
  $effect(() => {
    const id = pipelineId;
    const workspace = workspaceId;
    pipelineDetail = undefined;
    pipelineError = '';
    if (!id) return;
    let cancelled = false;
    pipelineLoading = true;
    chatPipelines
      .detail(workspace, id)
      .then((detail) => {
        if (!cancelled) pipelineDetail = detail;
      })
      .catch((cause: unknown) => {
        if (!cancelled) pipelineError = errorMessage(cause);
      })
      .finally(() => {
        if (!cancelled) pipelineLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  async function chooseExecutor(next: Executor): Promise<void> {
    try {
      await chatPipelines.setChatPipeline(sessionId, workspaceId, next.kind === 'pipeline' ? next.commandId : undefined);
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  async function sendThroughPipeline(): Promise<void> {
    if (attachments.images.length) {
      error = 'Pipelines take text only. Remove the images, or talk to the agent directly.';
      return;
    }
    const values = inputsBar?.collect();
    if (!values || busy) return;
    const message = text;
    busy = true;
    error = '';
    try {
      await chatPipelines.send({ workspaceId, sessionId, commandId: pipelineId, text: message, values, safeMode });
      if (text === message) setText('');
      await chatPipelines.setChatPipeline(sessionId, workspaceId, undefined).catch(() => undefined);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (!running || !canSteer) mode = 'follow-up';
  });

  // Loads the project file names for `@` as it is typed.
  $effect(() => {
    if (mention?.trigger === '@') fileMentions.update(workspaceId, mention.query);
  });

  // Native commands and skills of the live session: loaded once, then again
  // when a `/` or `$` menu opens after a minute (commands can change).
  let catalogLoadedAt = 0;
  const catalogWanted = $derived(support.nativeCommands || support.skillMentions);
  const menuTrigger = $derived(mention?.trigger);
  $effect(() => {
    const id = sessionId;
    const opening = menuTrigger === '/' || menuTrigger === '$';
    if (!catalogWanted) return;
    untrack(() => {
      if (catalogLoadedAt && (!opening || Date.now() - catalogLoadedAt < 60_000)) return;
      catalogLoadedAt = Date.now();
      void loadComposerCatalog(id, opening).then(
        (result) => {
          if (id === sessionId) catalog = { commands: result.commands, skills: result.skills };
        },
        () => {
          catalogLoadedAt = 0;
        },
      );
    });
  });

  // The model may change what the session accepts; read the capabilities again.
  const modelId = $derived(snapshot.session.model?.id);
  $effect(() => {
    void modelId;
    if (untrack(() => composer)) void read();
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
    const unregister = composerDropTargets.register((dropId) => void attachments.redeem(workspaceId, dropId, imageState));
    queueMicrotask(() => input?.focus());
    return () => {
      disposed = true;
      unlisten?.();
      unregister();
      fileMentions.dispose();
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

  /** Replaces the text and puts the caret at `position` once the editor updated. */
  async function place(value: string, position: number): Promise<void> {
    setText(value);
    caret = position;
    menuIndex = 0;
    await tick();
    input?.focus();
    input?.setSelectionRange(position, position);
  }

  function syncCaret(): void {
    caret = input?.selectionStart ?? text.length;
  }

  async function runCommand(name: string): Promise<void> {
    const command = commands.find((item) => item.name === name);
    if (!command || !command.enabled) {
      error = 'This command is unavailable in the current session state.';
      return;
    }
    if (name === 'run') {
      // Opens the run dialog; nothing is sent to the chat.
      runLauncher.open(snapshot.session.workspaceId, sessionId);
      setText('');
    } else if (name === 'stop') {
      if (await interrupt()) setText('');
    } else if (await action({ type: 'compact', sessionId })) {
      setText('');
    }
    menuDismissed = true;
  }

  /** Applies a menu entry: PiUI commands run, everything else inserts native text. */
  function choose(index: number, key: 'Enter' | 'Tab' | 'click'): void {
    const current = menu;
    const item = current?.items[index];
    if (!current || !item || !mention) return;
    if (current.kind === 'slash') {
      if (item.key.startsWith('piui:')) {
        const name = item.title.slice(1);
        if (key === 'Tab') void place(`/${name}`, name.length + 1);
        else void runCommand(name);
        return;
      }
      // The harness runs its own command when the message is sent.
      void place(`${item.title} `, item.title.length + 1);
      return;
    }
    const replacement =
      current.kind === 'file'
        ? index < current.handles.length
          ? `@${current.handles[index] ?? ''}`
          : fileMention(current.paths[index - current.handles.length] ?? '')
        : current.mentions[index];
    if (!replacement) return;
    const next = replaceMention(text, mention, replacement);
    void place(next.text, next.caret);
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
    if (pipelineId) {
      await sendThroughPipeline();
      return;
    }
    const typed = text;
    // Finished runs of this chat reach its agent inside this message, labelled.
    const handed = await chatPipelines.withResults(sessionId, typed);
    const message = handed.text;
    const imageIds = attachments.ids;
    const effectiveMode = running ? mode : 'prompt';
    // A durable request id prevents duplicate delivery if the reply is lost.
    let identity = loadIdentity();
    if (!identity || identity.text !== message || (identity.attachments ?? []).join() !== imageIds.join()) {
      identity = { id: crypto.randomUUID(), text: message, mode: effectiveMode, ...(imageIds.length ? { attachments: imageIds } : {}) };
      try {
        localStorage.setItem(identityKey, JSON.stringify(identity));
      } catch {
        error = 'Could not preserve the send request. Your message has not been sent.';
        return;
      }
    }
    const sent = await action({
      type: 'send',
      sessionId,
      requestId: identity.id,
      text: message,
      mode: identity.mode,
      ...(identity.attachments?.length ? { attachments: identity.attachments } : {}),
    });
    if (sent) {
      if (text === typed) setText('');
      void chatPipelines.consume(sessionId, handed.runIds);
      // The host now owns the images of the queued message.
      if (attachments.ids.join() === imageIds.join()) attachments.handOver();
      try {
        localStorage.removeItem(identityKey);
      } catch {
        // The durable request id already prevents duplicate delivery.
      }
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const items = menu?.items ?? [];
    if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      menuIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    } else if (event.key === 'Escape' && menu) {
      event.preventDefault();
      menuDismissed = true;
    } else if (items.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(activeIndex, event.key === 'Tab' ? 'Tab' : 'Enter');
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  function pasted(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    void attachments.paste(workspaceId, files, imageState);
  }

  const carriesFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer?.types.includes('Files'));

  function dropped(event: DragEvent): void {
    htmlDragging = false;
    if (!carriesFiles(event)) return;
    event.preventDefault();
    void attachments.paste(workspaceId, [...(event.dataTransfer?.files ?? [])], imageState);
  }

  function insertReferences(): void {
    const references = attachments.confirmReferences();
    if (!references) return;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const lead = before && !/\s$/u.test(before) ? ' ' : '';
    const trail = after.startsWith(' ') ? '' : ' ';
    void place(`${before}${lead}${references}${trail}${after}`, before.length + lead.length + references.length + trail.length);
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
            {#if item.attachments?.length}
              <p class="queue__images" aria-label={$t('Attached images')}>
                <ImageIcon size={12} />
                {item.attachments.map((image) => image.name).join(', ')}
              </p>
            {/if}
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

  <!-- svelte-ignore a11y_no_static_element_interactions (Drop target for files; the paperclip is the keyboard path.) -->
  <div
    class="composer"
    class:composer--running={running}
    class:composer--drop={htmlDragging || composerDropTargets.dragging}
    ondragover={(event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      htmlDragging = true;
    }}
    ondragleave={() => (htmlDragging = false)}
    ondrop={dropped}
  >
    {#if menu}
      <MentionMenu
        id={menuId}
        label={menuLabel}
        items={menu.items}
        active={activeIndex}
        loading={menu.kind === 'file' && fileMentions.loading}
        emptyText={menuEmpty}
        onPick={(index) => choose(index, 'click')}
      />
    {/if}
    <AttachmentChips images={attachments.images} disabled={busy} onRemove={(id) => void attachments.remove(id)} />
    {#if attachments.images.length && !imageState.supported}
      <p class="composer__warning" role="alert">{$t(imageState.reason ?? '')} {$t('Remove the images to send this message.')}</p>
    {/if}
    <AttachmentNotices notices={attachments.notices} onDismiss={() => attachments.dismissNotices()} />
    {#if pipelineId}
      <PipelineInputsBar bind:this={inputsBar} detail={pipelineDetail} loading={pipelineLoading} error={pipelineError} disabled={busy} existingChat={true} />
    {:else if pendingResults}
      <p class="handoff">{$t('The next message hands the pipeline result to {0}.', [harnessMeta(harness).label])}</p>
    {/if}
    {#if !pipelineId}
      <HandoffChips {workspaceId} {sessionId} {text} disabled={busy || safeMode} onHandedOff={() => void place('', 0)} />
    {/if}
    <Textarea
      bind:ref={input}
      value={text}
      oninput={(event) => {
        setText(event.currentTarget.value);
        syncCaret();
        menuDismissed = false;
        menuIndex = 0;
      }}
      onkeydown={keydown}
      onkeyup={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncCaret();
      }}
      onclick={syncCaret}
      onpaste={pasted}
      minRows={1}
      maxRows={14}
      class="composer__input"
      aria-label={$t('Message')}
      aria-autocomplete="list"
      aria-controls={menu ? menuId : undefined}
      aria-activedescendant={menu && menu.items.length ? `${menuId}-${activeIndex}` : undefined}
      placeholder={pipelineId ? $t('Describe the task for the pipeline…') : running ? $t('Queue a follow-up…') : $t('Reply, type / for commands or @ to mention a file…')}
    />
    <div class="composer__bar">
      <div class="composer__left">
        <AttachButton images={imageState} busy={attachments.busy} disabled={busy || Boolean(pipelineId)} onPick={() => void attachments.pick(workspaceId, imageState)} />
        <ExecutorPicker
          {workspaceId}
          value={executor}
          harnesses={[{ kind: harness, name: harnessMeta(harness).label, available: true }]}
          disabled={busy || safeMode}
          onChange={(next) => void chooseExecutor(next)}
        />
        {#if !pipelineId}
          <RuntimeChip
            session={snapshot.session}
            disabled={busy || snapshot.session.status !== 'idle' || !snapshot.capabilities.models.supported}
            onchange={refresh}
          />
        {/if}
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
    {#if htmlDragging || composerDropTargets.dragging}
      <div class="composer__drop" aria-hidden="true">{$t('Drop images or files to attach')}</div>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
</div>
{#if attachments.references.length}
  <ReferenceDialog references={attachments.references} onConfirm={insertReferences} onCancel={() => attachments.cancelReferences()} />
{/if}

<style>
  .composer-wrap {
    display: grid;
    gap: var(--piui-space-2);
  }
  .handoff {
    margin: 0;
    padding: 6px 14px 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
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
  .queue__images {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
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
  .composer--drop {
    border-color: var(--piui-focus);
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
  .composer__warning {
    margin: 8px 12px 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
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
  .composer__drop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 14px;
    background: color-mix(in srgb, var(--piui-surface-1) 88%, transparent);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    pointer-events: none;
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
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
