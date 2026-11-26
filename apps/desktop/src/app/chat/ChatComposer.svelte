<script lang="ts">
  import { readPastedAttachments, unreadableClipboardImage } from './composer/clipboardImages';
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
  import { Button, IconButton, Spinner, Textarea } from '../../lib/ui';
  import ComposerTextarea from '../../lib/ui/ComposerTextarea.svelte';
  import { harnessMeta } from '../harnessMeta';
  import { errorMessage } from '../workspaceStore.svelte';
  import { runLauncher } from '../triggers/runLauncher.svelte';
  import RuntimeChip from './RuntimeChip.svelte';
  import { steerEchoes, userBlockIds } from './steerEcho.svelte';
  import ExecutorPicker, { type Executor } from '../chatPipelines/ExecutorPicker.svelte';
  import PipelineInputsBar from '../chatPipelines/PipelineInputsBar.svelte';
  import { chatPipelines, type ChatPipelineDetail } from '../chatPipelines/chatPipelines.svelte';
  import AttachButton from './composer/AttachButton.svelte';
  import DictateButton from '../nano/DictateButton.svelte';
  import DictationPending from '../nano/DictationPending.svelte';
  import { insertAtCaret } from '../nano/dictation';
  import AttachmentChips from './composer/AttachmentChips.svelte';
  import AttachmentNotices from './composer/AttachmentNotices.svelte';
  import MentionMenu from './composer/MentionMenu.svelte';
  import MacroLayer from './composer/MacroLayer.svelte';
  import { macros } from '../macros/macros.svelte';
  import { expandMacros, type SkillSyntax } from '../macros/expand';
  import { findMacroTokens, MACRO_DIGIT_ROWS, MACRO_LIMITS, macroShortcutIndex, macroSummary, macroTokenAt, type Macro } from '../macros/macro';
  import ReferenceDialog from './composer/ReferenceDialog.svelte';
  import { ComposerAttachments } from './composer/composerAttachments.svelte';
  import { FileMentions, loadComposerCatalog, type NativeEntries } from './composer/composerLookups.svelte';
  import { composerDropTargets } from './composer/dropTargets.svelte';
  import { activeMention, fileMention, macroKeysOpen, type ActiveMention, rankFiles, rankNamed, replaceMention } from './composer/mentions';
  import type { ComposerMenuItem } from './composer/menuItems';
  import HandoffChips from '../board/HandoffChips.svelte';
  import { boards } from '../board/boardStore.svelte';
  import { rankTeammates } from '../team/handle';
  import { teammates } from '../team/teammatesStore.svelte';
  import { remoteMode } from '../nano/remoteMode';
  import { btwQuestion, startBranch } from '../branch/branchChat';
  import { announceBranch } from '../branch/branchFeedback';
  import { useWorkspace } from '../shell/context';

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
    onEditMacro?: (macroId: string) => void;
    /** False in a split pane that is not the selected chat: it takes neither focus on open nor dropped files. */
    active?: boolean;
  }
  let { snapshot, draft, updateDraft, images = [], updateImages = () => undefined, refresh, interrupt, interruptBusy = false, safeMode = false, onEditMacro, active = true }: Props = $props();

  const store = useWorkspace();

  interface Pending {
    id: string;
    text: string;
    mode: 'prompt' | 'follow-up' | 'steer';
    attachments?: string[];
  }

  let composer = $state.raw<ComposerSnapshot | undefined>();
  let busy = $state(false);
  let error = $state('');
  let editing = $state('');
  let editText = $state('');
  let queueEditor = $state<HTMLTextAreaElement | null>(null);
  let root = $state<HTMLElement | null>(null);
  /** Closes the queue editor and gives the focus back to that message's Edit button. */
  function closeEditor(id: string): void {
    editing = '';
    void tick().then(() => root?.querySelector<HTMLElement>(`[data-queue-edit="${CSS.escape(id)}"]`)?.focus());
  }
  // "Edit" puts the caret at the end of the queued text, ready to type.
  $effect(() => {
    const field = queueEditor;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  let menuIndex = $state(0);
  /** The key that last picked a macro, while it may still repeat. */
  let shortcutHeld: string | undefined;
  let menuDismissed = $state(false);
  /** The macro space Escape turned into an ordinary space: it stays closed while the text before it is unchanged. */
  let dismissedSpace = $state<string | undefined>();
  const spaceKey = (value: string, start: number): string => `${start}:${value.slice(0, start + 1)}`;
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
  // Macros (ADR-060): `//name` is marked while typed and replaced by its text on send.
  const macroTokens = $derived(findMacroTokens(text, macros.list));
  const skillSyntax = $derived<SkillSyntax>({ skills: catalog.skills, commands: catalog.commands, dollar: support.skillMentions, ...(snapshot.session.harness === 'pi' ? { prefix: 'skill:' } : {}) });
  // The open session's report is authoritative; before it arrives, the manifest.
  const imageState = $derived(imageSupport(harness, composer ? Boolean(composer.capabilities.images) : undefined));
  const identityKey = $derived(`piui.composer.request.${sessionId}`);
  const running = $derived(snapshot.session.status === 'running');
  const stopping = $derived(snapshot.session.status === 'stopping');
  const canSteer = $derived(Boolean(composer?.capabilities.steer));
  // While dictating, Send (button or Enter) stops the recording and sends what was said.
  let dictate = $state<{ stopAndSend: () => void } | null | undefined>();
  let dictationActive = $state(false);
  const dictating = $derived(dictationActive && Boolean(dictate));
  const submit = (): void => (dictating ? dictate?.stopAndSend() : void send());
  const commands = $derived([
    ...(composer?.capabilities.compact
      ? [{ name: 'compact', description: 'Compact conversation context', enabled: snapshot.session.status === 'idle' && !composer.queue.items.length }]
      : []),
    { name: 'stop', description: 'Stop the current turn', enabled: running },
    // Pipelines run on the desktop's screen; a remote browser has no `/run`.
    ...(remoteMode ? [] : [{ name: 'run', description: 'Run a saved pipeline of this project', enabled: true }]),
    // A branch is made by the desktop host; a remote browser has no `/btw`.
    ...(remoteMode ? [] : [{ name: 'btw', description: 'Ask a side question in a branch of this chat', enabled: !safeMode }]),
  ]);
  // A PiUI command wins over a native one of the same name: PiUI runs it on send.
  const nativeCommands = $derived(catalog.commands.filter((command) => !commands.some((own) => own.name === command.name)));
  // `@` also mentions teammates when the project board is on (ADR-041).
  const teamMentions = $derived(boards.stores.get(workspaceId)?.enabled === true);
  const unlessDismissed = (found: ActiveMention | undefined): ActiveMention | undefined =>
    found?.trigger === 'space' && dismissedSpace === spaceKey(text, found.start) ? undefined : found;
  const mention = $derived(
    menuDismissed
      ? undefined
      // A remote browser cannot read the desktop's files or skills: no `@` file or `$` skill menus.
      : unlessDismissed(activeMention(text, caret, { slash: true, at: !remoteMode && Boolean(workspaceId), dollar: !remoteMode && support.skillMentions && catalog.skills.length > 0, macros: macros.list.length > 0 })),
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
    | { kind: 'macro'; items: ComposerMenuItem[]; names: string[]; found: readonly Macro[] }
    | { kind: 'file'; items: ComposerMenuItem[]; paths: string[]; handles: string[] }
    | { kind: 'skill'; items: ComposerMenuItem[]; mentions: string[] };
  const menu = $derived.by((): Menu | undefined => {
    if (!mention) return undefined;
    if (mention.trigger === 'space') {
      const found = rankNamed(macros.list, mention.query, MACRO_LIMITS.macros);
      // A space that names no macro is an ordinary space.
      if (found.length === 0) return undefined;
      // Until a name is typed, a digit or a macro's own letter picks a row: the keys are shown on the rows.
      const keyed = macroKeysOpen(mention);
      return {
        kind: 'macro',
        names: found.map((macro) => macro.name),
        found,
        items: found.map((macro, row): ComposerMenuItem => {
          const detail = macroSummary(macro);
          return {
            key: `macro:${macro.id}`,
            title: macro.name,
            ...(detail ? { detail } : {}),
            ...(keyed && row < MACRO_DIGIT_ROWS ? { number: row + 1 } : {}),
            ...(keyed && macro.key ? { accelerator: macro.key } : {}),
          };
        }),
      };
    }
    if (mention.trigger === '/') {
      const own = commands
        .filter((command) => command.name.startsWith(mention.query))
        .map((command): ComposerMenuItem => ({
          key: `piui:${command.name}`,
          title: `/${command.name}`,
          detail: $t(command.description),
          badge: 'Nano',
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
    menu?.kind === 'macro' ? $t('Macros') : menu?.kind === 'file' ? (menu.handles.length ? $t('Teammates and project files') : $t('Project files')) : menu?.kind === 'skill' ? $t('Skills') : $t('Available commands'),
  );
  const menuEmpty = $derived(
    menu?.kind === 'macro' ? $t('No matching macros') : menu?.kind === 'file'
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
  // Images alone are a message: the host takes no empty text, so they go with a short line that says what to look at.
  const imageOnly = $derived(!text.trim() && attachments.images.length > 0 && !pipelineId);
  const imageOnlyText = $derived($t(attachments.images.length === 1 ? 'See the attached image.' : 'See the attached images.'));
  // A running turn shows Stop in the send button's place until there is something to send.
  const showStop = $derived((running || stopping) && !dictating && !text.trim() && !imageOnly);
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
    // Templates are offered to new chats only.
    if (next.kind === 'template') return;
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
    const typed = text;
    const message = expandMacros(typed, macros.list, skillSyntax);
    busy = true;
    error = '';
    try {
      await chatPipelines.send({ workspaceId, sessionId, commandId: pipelineId, text: message, values, safeMode });
      if (text === typed) setText('');
      await chatPipelines.setChatPipeline(sessionId, workspaceId, undefined).catch(() => undefined);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  // Loads the project file names for `@` as it is typed.
  $effect(() => {
    if (mention?.trigger === '@') fileMentions.update(workspaceId, mention.query);
  });

  // Native commands and skills of the live session: loaded once, then again
  // when a `/` or `$` menu opens after a minute (commands can change).
  let catalogLoadedAt = 0;
  const catalogWanted = $derived(!remoteMode && (support.nativeCommands || support.skillMentions));
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
    if (untrack(() => active)) queueMicrotask(() => input?.focus());
    return () => {
      disposed = true;
      unlisten?.();
      fileMentions.dispose();
    };
  });
  // Files dropped on the desktop window belong to the desktop and go to the selected chat's composer only,
  // not to every pane. A remote browser takes text only.
  $effect(() => {
    if (remoteMode || !active) return;
    return composerDropTargets.register((dropId) => void attachments.redeem(workspaceId, dropId, imageState));
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
    if (active) input?.focus();
    input?.setSelectionRange(position, position);
  }

  function syncCaret(): void {
    caret = input?.selectionStart ?? text.length;
  }

  /** Dictated words go in at the caret. */
  function dictated(words: string, origin: string): boolean {
    if (origin !== `chat:${sessionId}`) return false;
    const next = insertAtCaret(text, input?.selectionStart ?? caret, words);
    void place(next.text, next.caret);
    return true;
  }

  /** `/btw`: a branch of this chat at its end, opened beside it; the question is the branch's first message. */
  async function branchBeside(question: string): Promise<boolean> {
    if (busy) return false;
    // A side question carries text only: the text and the attachments stay where they are.
    if (attachments.images.length) {
      error = 'A side question carries text only. Remove the attachments or send them in this chat.';
      return false;
    }
    busy = true;
    error = '';
    try {
      // The pane beside mounts this composer again from the saved draft: the command leaves it before that.
      const result = await startBranch(store, snapshot, { at: 'end' }, { ...(question ? { prompt: question } : {}), open: 'beside', translate: $t, created: () => setText('') });
      if (!result.ok) {
        error = result.error;
        return false;
      }
      // The branch exists with the question as its draft: nothing is lost.
      if (result.error) error = result.error;
      announceBranch(result, $t, (id) => void store.openSession(id));
      return true;
    } finally {
      busy = false;
    }
  }

  async function runCommand(name: string, argument: string | undefined = undefined): Promise<void> {
    const command = commands.find((item) => item.name === name);
    if (!command || !command.enabled) {
      error = 'This command is unavailable in the current session state.';
      return;
    }
    if (name === 'run') {
      // Opens the run dialog; nothing is sent to the chat.
      runLauncher.open(snapshot.session.workspaceId, sessionId);
      setText('');
    } else if (name === 'btw') {
      // `branchBeside` empties the text itself, as soon as the branch exists.
      await branchBeside(argument ?? '');
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
      current.kind === 'macro' ? (current.names[index] === undefined ? undefined : `//${current.names[index]}`) : current.kind === 'file'
        ? index < current.handles.length
          ? `@${current.handles[index] ?? ''}`
          : fileMention(current.paths[index - current.handles.length] ?? '')
        : current.mentions[index];
    if (!replacement) return;
    const next = replaceMention(text, mention, replacement);
    void place(next.text, next.caret);
  }

  /** The chat's user messages when the pending request was first sent. */
  let firstAttempt: { id: string; known: Set<string> } | undefined;

  function loadIdentity(): Pending | undefined {
    try {
      return (JSON.parse(localStorage.getItem(identityKey) ?? 'null') as Pending | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function send(): Promise<void> {
    if (busy || !composer || !(text.trim() || imageOnly)) return;
    const onlyImages = imageOnly;
    // `/btw` also takes a question after it; the other commands are the whole message.
    const question = commands.some((command) => command.name === 'btw') ? btwQuestion(text) : undefined;
    if (question !== undefined) {
      await runCommand('btw', question);
      return;
    }
    if (commands.some((command) => text.trim() === `/${command.name}`)) {
      await runCommand(text.trim().slice(1));
      return;
    }
    if (pipelineId) {
      await sendThroughPipeline();
      return;
    }
    const typed = text;
    // What is sent is fixed here: the person can still remove an image while the results are read, and a
    // message that says "see the attached image" must never leave without it.
    const imageIds = attachments.ids;
    const placeholder = imageOnlyText;
    // Finished runs of this chat reach its agent inside this message, labelled.
    const handed = await chatPipelines.withResults(sessionId, onlyImages ? placeholder : expandMacros(typed, macros.list, skillSyntax));
    const message = handed.text;
    // A message written during a turn waits in the queue; its "Send now" steers it into the turn.
    const effectiveMode = running ? 'follow-up' : 'prompt';
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
    const request = identity;
    // A retry keeps the first attempt's view: a message the runtime reported meanwhile is still new.
    const attempt = firstAttempt?.id === request.id ? firstAttempt : (firstAttempt = { id: request.id, known: userBlockIds(snapshot.blocks) });
    const known = attempt.known;
    const sent = await action({
      type: 'send',
      sessionId,
      requestId: request.id,
      text: message,
      mode: request.mode,
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    });
    if (sent) {
      // The agent has taken a steered message: the chat shows it until the agent's runtime reports it.
      if (request.mode === 'steer' && !composer?.queue.items.some((item) => item.id === request.id)) {
        steerEchoes.add(sessionId, { id: request.id, text: message, images: request.attachments?.length ?? 0, known });
      }
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

  /** Sends a queued message into the running turn. The chat shows it until the agent's runtime reports it. */
  async function promote(item: ComposerSnapshot['queue']['items'][number]): Promise<void> {
    const known = userBlockIds(snapshot.blocks);
    const sent = await action({ type: 'promote', sessionId, requestId: item.id });
    if (sent && !composer?.queue.items.some((queued) => queued.id === item.id)) {
      steerEchoes.add(sessionId, { id: item.id, text: item.text, images: item.attachments?.length ?? 0, known });
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'F2' && onEditMacro && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const token = macroTokenAt(macroTokens, input?.selectionStart ?? caret);
      if (token) {
        event.preventDefault();
        onEditMacro(token.macro.id);
        return;
      }
    }
    // A key held down after it picked a macro must not type itself into the message.
    if (event.repeat && shortcutHeld === event.key) {
      event.preventDefault();
      return;
    }
    if (!event.repeat) shortcutHeld = undefined;
    // Right after the space, a digit or a macro's own letter picks that macro; once a name is typed, keys type.
    if (menu?.kind === 'macro' && macroKeysOpen(mention)) {
      const picked = macroShortcutIndex(event, menu.found);
      if (picked >= 0) {
        event.preventDefault();
        shortcutHeld = event.key;
        choose(picked, 'Enter');
        return;
      }
    }
    const items = menu?.items ?? [];
    if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      menuIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    } else if (event.key === 'Escape' && menu) {
      event.preventDefault();
      // Escape after a macro space keeps the space as typed, and only that space stays closed.
      if (mention?.trigger === 'space') dismissedSpace = spaceKey(text, mention.start);
      else menuDismissed = true;
    } else if (items.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(activeIndex, event.key === 'Tab' ? 'Tab' : 'Enter');
    }
  }

  function pasted(event: ClipboardEvent): void {
    const paste = readPastedAttachments(event, !remoteMode);
    if (!paste || remoteMode) return;
    const targetWorkspace = workspaceId;
    const targetSession = sessionId;
    void paste.files.then((files) => {
      if (!root?.isConnected || workspaceId !== targetWorkspace || sessionId !== targetSession) return;
      if (files.length) return attachments.paste(targetWorkspace, files, imageState);
      if (paste.reportEmpty) attachments.notices = [{ kind: 'error', message: unreadableClipboardImage }];
    });
  }

  const carriesFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer?.types.includes('Files'));

  function dropped(event: DragEvent): void {
    htmlDragging = false;
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (remoteMode) return;
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
    if (status === 'sending') return $t('Sending…');
    return $t('Delivery uncertain — check the chat before dismissing. It will not be resent automatically.');
  }
</script>

<div class="composer-wrap" data-nano-composer="root" bind:this={root}>
  {#if queue.length || composer?.queue.paused}
    <section class="queue" aria-label={$t('Message queue')}>
      {#if composer?.queue.paused}
        <p class="queue__paused">
          <span>{$t('Queue paused')}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || queue.some((item) => item.status === 'uncertain' || item.status === 'sending')}
            onclick={() => void action({ type: 'resume', sessionId })}>{$t('Resume queue')}</Button
          >
        </p>
      {/if}
      {#each queue as item (item.id)}
        {@const editingThis = editing === item.id && item.status === 'queued'}
        <article class="queue__item" class:queue__item--warn={item.status === 'uncertain'} class:queue__item--editing={editingThis}>
          {#if editingThis}
            <Textarea bind:ref={queueEditor} bind:value={editText} minRows={2} maxRows={6} aria-label={$t('Edit queued message')}
              onkeydown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeEditor(item.id);
                }
              }} />
            <div class="queue__actions">
              <Button size="sm" variant="ghost" onclick={() => closeEditor(item.id)}>{$t('Cancel')}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !(editText.trim() || item.attachments?.length)}
                onclick={async () => {
                  // A queued message that carries images may lose its words, as a new one may be sent without any.
                  const edited = editText.trim() ? editText : $t(item.attachments?.length === 1 ? 'See the attached image.' : 'See the attached images.');
                  if (await action({ type: 'edit', sessionId, requestId: item.id, text: edited })) closeEditor(item.id);
                }}>{$t('Save')}</Button
              >
            </div>
          {:else}
            <span class="queue__mark" aria-hidden="true"><CornerDownRight size={14} /></span>
            <div class="queue__body">
              <!-- A message whose delivery is unknown is shown whole, to compare it with the chat before removing it. -->
              <p class="queue__text" class:queue__text--whole={item.status === 'uncertain'} title={item.text}>{item.text}</p>
              {#if item.attachments?.length}
                <p class="queue__images" aria-label={$t('Attached images')}>
                  <ImageIcon size={12} />
                  {item.attachments.map((image) => image.name).join(', ')}
                </p>
              {/if}
              {#if item.status !== 'queued'}
                <p class="queue__status">
                  {#if item.status === 'sending'}<Spinner size={10} />{/if}
                  {statusText(item.status)}
                </p>
              {/if}
              {#if item.error}<p class="queue__error">{$t(item.error)}</p>{/if}
            </div>
            <div class="queue__actions">
              {#if item.status === 'queued'}
                {#if running && canSteer}
                  <IconButton size="sm" label={$t('Send now')} onclick={() => void promote(item)}><ArrowUp /></IconButton>
                {/if}
                <IconButton
                  size="sm"
                  data-queue-edit={item.id}
                  label={$t('Edit')}
                  onclick={() => {
                    editing = item.id;
                    editText = item.text;
                  }}><Pencil /></IconButton
                >
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
    data-nano-composer="surface"
    class:composer--running={running}
    class:composer--drop={htmlDragging || (active && composerDropTargets.dragging)}
    ondragover={(event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      htmlDragging = !remoteMode;
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
    {#if !pipelineId && !remoteMode}
      <HandoffChips {workspaceId} {sessionId} {text} disabled={busy || safeMode} onHandedOff={() => void place('', 0)} />
    {/if}
    <div class="composer__field">
      <ComposerTextarea
        bind:ref={input}
        value={text}
        oninput={(event) => {
          setText(event.currentTarget.value);
          syncCaret();
          menuDismissed = false;
          menuIndex = 0;
        }}
        beforeKeyDown={keydown}
        onSubmit={submit}
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
        placeholder={pipelineId ? $t('Describe the task for the pipeline…') : remoteMode ? $t('Message') : attachments.images.length ? imageOnlyText : running ? $t('Queue a follow-up…') : $t('Reply, type / for commands or @ to mention a file…')}
      />
      {#if macroTokens.length}
        <MacroLayer {input} {text} tokens={macroTokens} syntax={skillSyntax} quiet={Boolean(menu)} onEdit={onEditMacro ? (macro) => onEditMacro(macro.id) : undefined} />
      {/if}
    </div>
    {#if !remoteMode}
      <DictationPending scope={`chat:${sessionId}`} onText={dictated} disabled={busy || safeMode} />
    {/if}
    <div data-nano-composer="bar">
      <div class="composer__left">
        <!-- Attachments, dictation and pipelines need this computer's files, microphone and library: not offered to a remote browser.
             While dictating, only Cancel, Stop and Send are left in the bar. -->
        {#if !remoteMode && !dictating}
          <AttachButton images={imageState} busy={attachments.busy} disabled={busy || Boolean(pipelineId)} onPick={() => void attachments.pick(workspaceId, imageState)} />
          <ExecutorPicker
            {workspaceId}
            value={executor}
            harnesses={[{ kind: harness, name: harnessMeta(harness).label, available: true }]}
            disabled={busy || safeMode}
            onChange={(next) => void chooseExecutor(next)}
          />
        {/if}
        {#if !pipelineId && !dictating}
          <RuntimeChip
            session={snapshot.session}
            disabled={busy || snapshot.session.status !== 'idle' || !snapshot.capabilities.models.supported}
            {safeMode}
            onchange={refresh}
          />
        {/if}
      </div>
      <div class="composer__right">
        {#if !remoteMode}
          <DictateButton bind:this={dictate} bind:active={dictationActive} onText={dictated} onSend={() => void send()} scope={`chat:${sessionId}`} disabled={busy || safeMode} />
        {/if}
        {#if showStop}
          <button
            type="button"
            data-nano-composer="send"
            onclick={() => void interrupt()}
            disabled={interruptBusy || stopping}
            aria-label={interruptBusy || stopping ? $t('Stopping…') : $t('Stop turn')}
            aria-keyshortcuts="Control+."
          >
            {#if interruptBusy || stopping}<Spinner size={14} />{:else}<Square size={12} fill="currentColor" />{/if}
          </button>
        {:else}
          <button
            type="button"
            data-nano-composer="send"
            onclick={submit}
            disabled={dictating ? busy : busy || !composer || !(text.trim() || imageOnly)}
            aria-label={dictating ? $t('Stop dictation and send') : running ? $t('Add to queue') : $t('Send')}
          >
            {#if busy}<Spinner size={14} />{:else}<ArrowUp size={16} />{/if}
          </button>
        {/if}
      </div>
    </div>
    {#if htmlDragging || (active && composerDropTargets.dragging)}
      <div class="composer__drop" aria-hidden="true">{$t('Drop images or files to attach')}</div>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
</div>
{#if attachments.references.length}
  <ReferenceDialog references={attachments.references} onConfirm={insertReferences} onCancel={() => attachments.cancelReferences()} />
{/if}

<style>
  .composer__field { position: relative; }
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
    max-height: 30vh;
    padding: 2px var(--piui-space-1);
    overflow-y: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .queue__paused {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 2px 6px;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .queue__item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: var(--piui-control-md);
    padding: 2px 2px 2px 8px;
  }
  .queue__item--editing {
    grid-template-columns: minmax(0, 1fr);
    padding: 6px;
  }
  .queue__item + .queue__item {
    border-top: 1px solid var(--piui-border-subtle);
  }
  .queue__mark {
    display: inline-flex;
    color: var(--piui-text-muted);
  }
  .queue__body {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .queue__text {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .queue__text--whole {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .queue__images,
  .queue__status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .queue__item--warn .queue__status {
    color: var(--piui-warning-text);
  }
  .queue__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
  }
  .queue__error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
  .composer--drop {
    border-color: var(--piui-focus);
  }
  .composer__warning {
    margin: 8px 12px 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
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
    border-radius: var(--piui-radius-lg);
    background: color-mix(in srgb, var(--piui-surface-1) 88%, transparent);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    pointer-events: none;
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
    font-size: var(--piui-text-sm);
  }
</style>
