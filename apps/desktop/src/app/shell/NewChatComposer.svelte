<script lang="ts">
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Zap from '@lucide/svelte/icons/zap';
  import Brain from '@lucide/svelte/icons/brain';
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { t } from '../../features/locale/language';
  import { cachedHarnessModels, catalogUnavailable, harnessModels, isNanoConnectorModel, rememberedHarnessModels, resourceNotices, type ResourceNotice } from '../../host-api/harnessModels';
  import { prewarmHarnessCatalogs } from '../../host-api/catalogPrewarm';
  import ModelPicker, { type ModelOption } from './ModelPicker.svelte';
  import type { HarnessCatalogModel, HarnessModelsResult, HarnessResource } from '../../../../../contracts/harness-models-v18';
  import type { HarnessKind, PermissionMode, WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { composerSupport, imageSupport } from '../../harness-adapters/composer';
  import { Spinner, toasts } from '../../lib/ui';
  import ComposerTextarea from '../../lib/ui/ComposerTextarea.svelte';
  import { harnessMeta } from '../harnessMeta';
  import { errorMessage } from '../workspaceStore.svelte';
  import { WorkspaceOperationError, workspaceError } from '../../host-api/workspaceClient';
  import AttachButton from '../chat/composer/AttachButton.svelte';
  import { dictationSource } from '../nano/dictationSource.svelte';
  import { nanoAccount } from '../nano/nanoAccount.svelte';
  import { remoteMode } from '../nano/remoteMode';
  import { NANO_SOURCE_HARNESSES } from '../nano/nanoView';
  import { ComposerAttachments } from '../chat/composer/composerAttachments.svelte';
  import { FileMentions } from '../chat/composer/composerLookups.svelte';
  import { composerDropTargets } from '../chat/composer/dropTargets.svelte';
  import { activeMention, fileMention, rankFiles, rankNamed, replaceMention } from '../chat/composer/mentions';
  import type { ComposerMenuItem } from '../chat/composer/menuItems';
  import { chatTitle } from '../chat/chatTitle';
  import { macros } from '../macros/macros.svelte';
  import type { SkillSyntax } from '../macros/expand';
  import { findMacroTokens, macroSummary, macroTokenAt, type Macro } from '../macros/macro';
  import ContextChip from './ContextChip.svelte';
  import ExecutorChip from '../chatPipelines/ExecutorChip.svelte';
  import type { Executor } from '../chatPipelines/ExecutorPicker.svelte';
  import type PipelineInputsBarComponent from '../chatPipelines/PipelineInputsBar.svelte';
  import type { ChatPipelineDetail } from '../chatPipelines/chatPipelines.svelte';
  import { lazyPipelines, type PipelineCode } from '../chatPipelines/lazyPipelines.svelte';
  import type { TemplateChoice, TemplateDraft } from '../chatPipelines/templateRun';
  import type { AgentProfile, RunInputValue } from '../../host-api/orchestrationClient';
  import { useWorkspace } from './context';
  import { modelSelectionKey, resolveModelSelection } from '../../host-api/modelSelection';
  import { choiceFor, executorOf, reconcileSelection, rememberedPipelineUsable, restoredSelection, startingExecutor, withChoice, withExecutorIn, type NewChatChoices, type NewChatSelection, type PipelineCandidate, type RememberedExecutor } from './newChatChoice';
  import { teammates } from '../team/teammatesStore.svelte';
  import FusionModeBar from '../fusion/FusionModeBar.svelte';
  import { fusionErrorText, refusalCopy, roleLabel } from '../fusion/fusionPair';
  import type { FusionPairV1 } from '../../host-api/fusionClient';

  const CATALOG_RETRY_DELAY_MS = 1500;

  /** A coded refusal (sign-in, trust, safe mode…) is the host's answer: waiting and asking again cannot change it. */
  function isVerdict(error: unknown): boolean {
    return error instanceof WorkspaceOperationError && error.code !== 'UNKNOWN';
  }

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { onTrust }: Props = $props();
  const store = useWorkspace();
  const DRAFT_KEY = 'new-chat';
  const CHOICE_KEY = 'piui.shell.newchat.v1';
  const LAST_CHOICE_KEY = 'piui.shell.newchat.last.v1';

  function readChoices(): NewChatChoices {
    const read = (key: string): unknown => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? 'null');
      } catch {
        return null;
      }
    };
    const projects = read(CHOICE_KEY);
    const last = read(LAST_CHOICE_KEY);
    return {
      projects: projects && typeof projects === 'object' && !Array.isArray(projects) ? (projects as NewChatChoices['projects']) : {},
      ...(last && typeof last === 'object' && !Array.isArray(last) ? { last: last as NonNullable<NewChatChoices['last']> } : {}),
    };
  }
  // Kept in memory too: a pick stays remembered for this composer even when storage refuses the write.
  let choices = readChoices();

  let text = $state(store.draftFor(DRAFT_KEY));
  let caret = $state(store.draftFor(DRAFT_KEY).length);
  let workspaceId = $state(store.selectedWorkspaceId);
  let harness = $state<HarnessKind | ''>('');
  let modelKey = $state('');
  let thinkingLevel = $state('');
  let fast = $state(false);
  let permissionMode = $state<PermissionMode>('native');
  /** A saved pipeline the first message goes through; empty talks to the harness directly. */
  let pipelineId = $state('');
  /** A template that becomes a pipeline of the project when the first message is sent (ADR-053). */
  let templateChoice = $state.raw<{ choice: TemplateChoice; key: string; name: string } | undefined>();
  let draft = $state.raw<TemplateDraft | undefined>();
  let draftLoading = $state(false);
  let draftError = $state('');
  // Fusion (ADR-043): while on, the pair picker replaces the single-agent choices.
  let fusionMode = $state(false);
  let fusionPair = $state.raw<FusionPairV1 | undefined>();
  let fusionReady = $state(false);
  let pipelineDetail = $state.raw<ChatPipelineDetail | undefined>();
  let pipelineLoading = $state(false);
  let pipelineError = $state('');
  let inputsBar = $state<ReturnType<typeof PipelineInputsBarComponent> | undefined>();
  // The bar and its input fields load when a pipeline is chosen, outside the first-paint bundle.
  const loadInputsBar = () => import('../chatPipelines/PipelineInputsBar.svelte');
  let models = $state.raw<HarnessCatalogModel[]>([]);
  let skills = $state.raw<HarnessResource[]>([]);
  let modelsLoading = $state(false);
  /** The list is another project's catalog of this harness, shown until this project's own answers. */
  let modelsProvisional = $state(false);
  let modelsResolved = $state(false);
  let modelsError = $state('');
  /** Resource discovery failures or MCP servers that failed to start. */
  let resourceNotes = $state.raw<ResourceNotice[]>([]);
  let catalogAttempt = $state(0);
  /** Set by a manual Retry for the load it starts: the harness is asked again, a remembered answer (even an empty one) is not reused. */
  let refreshCatalog = false;
  function retryCatalog(): void {
    refreshCatalog = true;
    catalogAttempt += 1;
  }
  let catalogFor = $state('');
  let busy = $state(false);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let menuIndex = $state(0);
  let menuDismissed = $state(false);
  let htmlDragging = $state(false);
  const attachments = new ComposerAttachments(store.attachmentsFor(DRAFT_KEY), (images) => store.updateAttachments(DRAFT_KEY, images));
  // A previous instance may acknowledge a send after Home was reopened. Keep
  // this editor on the authoritative draft without counting hydration as an edit.
  $effect(() => {
    const savedText = store.draftFor(DRAFT_KEY);
    const savedImages = store.attachmentsFor(DRAFT_KEY);
    untrack(() => {
      if (text !== savedText) {
        text = savedText;
        caret = Math.min(caret, text.length);
      }
      attachments.syncFromOwner(savedImages);
    });
  });
  const fileMentions = new FileMentions();

  const workspaces = $derived(store.catalog.workspaces.filter((workspace) => !workspace.missing));
  const workspace = $derived(workspaces.find((item) => item.id === workspaceId));
  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  // A string, not the entry: every session event replaces the catalog, only a new version asks again.
  const harnessVersion = $derived(store.catalog.harnesses.find((item) => item.kind === harness)?.version ?? '');
  const model = $derived(resolveModelSelection(models, modelKey, harness));
  const canUseDefaultModel = $derived(harness !== 'nano' || nanoAccount.availableModes.length > 0);
  const levels = $derived(model?.thinkingLevels ?? []);
  // Before a session exists only the manifest is known; the host decides at send.
  const imageState = $derived(imageSupport(fusionMode && fusionPair ? fusionPair.lead.harness : harness, undefined));
  const trusted = $derived(Boolean(workspace && (workspace.personal || workspace.trust === 'trusted')));
  const catalogBlocked = $derived(Boolean(workspace) && !trusted);
  // Harness-native `$` mentions from the harness catalog (Codex skills).
  const skillMentions = $derived(
    harness && composerSupport(harness).skillMentions
      ? skills
          .filter((item) => item.kind === 'skill' && item.enabled && /^[A-Za-z0-9._:-]+$/.test(item.name))
          .map((item) => ({ name: item.name, mention: `$${item.name}` }))
      : [],
  );
  const mention = $derived(
    menuDismissed || store.safeMode
      ? undefined
      // A remote browser cannot read the desktop's files or skills: no `@` file or `$` skill menus.
      : activeMention(text, caret, { slash: false, at: !remoteMode && Boolean(workspaceId), dollar: !remoteMode && skillMentions.length > 0, macros: macros.list.length > 0 }),
  );
  type Menu = { kind: 'macro'; items: ComposerMenuItem[]; names: string[] } | { kind: 'file'; items: ComposerMenuItem[]; paths: string[] } | { kind: 'skill'; items: ComposerMenuItem[]; mentions: string[] };
  const menu = $derived.by((): Menu | undefined => {
    if (!mention) return undefined;
    if (mention.trigger === '//') {
      const found = rankNamed(macros.list, mention.query);
      // A whole name with nothing longer to offer needs no menu: Enter sends the message.
      if (found.length === 1 && found[0]?.name === mention.query.toLowerCase()) return undefined;
      return {
        kind: 'macro',
        names: found.map((macro) => macro.name),
        items: found.map((macro): ComposerMenuItem => {
          const detail = macroSummary(macro);
          return { key: `macro:${macro.id}`, title: `//${macro.name}`, ...(detail ? { detail } : {}) };
        }),
      };
    }
    if (mention.trigger === '@') {
      const paths = trusted ? rankFiles(fileMentions.files, mention.query) : [];
      return { kind: 'file', paths, items: paths.map((path) => ({ key: `file:${path}`, title: path })) };
    }
    const found = rankNamed(skillMentions, mention.query);
    return {
      kind: 'skill',
      mentions: found.map((item) => item.mention),
      items: found.map((item) => ({ key: `skill:${item.name}`, title: item.mention, badge: harness ? harnessMeta(harness).short : undefined })),
    };
  });
  const activeIndex = $derived(menu && menu.items.length ? menuIndex % menu.items.length : 0);
  const menuEmpty = $derived(
    menu?.kind === 'macro' ? $t('No matching macros') : menu?.kind === 'file'
      ? !trusted
        ? $t('Trust this project to mention its files.')
        : fileMentions.loading
          ? $t('Loading project files…')
          : fileMentions.error
            ? $t(fileMentions.error)
            : $t('No matching files')
      : $t('No matches'),
  );

  // Follow the sidebar selection until the user picks a project here.
  $effect(() => {
    if (!workspaceId || !workspaces.some((item) => item.id === workspaceId)) {
      workspaceId = store.selectedWorkspaceId || workspaces[0]?.id || '';
    }
  });

  // Restore a project's remembered choice when the project changes. A catalog
  // refresh (any session event replaces it) only replaces a harness that is
  // no longer available; it never undoes the user's picks.
  let restoredFor: string | undefined;
  $effect(() => {
    const id = workspaceId;
    const kinds = available.map((item) => item.kind);
    untrack(() => {
      const current: NewChatSelection = { harness, modelKey, thinkingLevel, fast, permissionMode };
      const choice = choiceFor(choices, id);
      const next = restoredFor === id ? reconcileSelection(current, kinds, choice) : restoredSelection(choice, kinds);
      restoredFor = id;
      if (next === current) return;
      harness = next.harness;
      modelKey = next.modelKey;
      thinkingLevel = next.thinkingLevel;
      fast = next.fast;
      permissionMode = next.permissionMode;
    });
  });

  $effect(() => {
    const id = workspaceId;
    const kind = harness;
    const version = harnessVersion;
    // A retry asks again for the same project and harness: what is shown stays.
    void catalogAttempt;
    const refresh = refreshCatalog;
    refreshCatalog = false;
    // The Nano catalog is account state: a sign-in, a plan or a credit change loads it again.
    // An agent with a Nano model source lists the same modes as a separate group.
    const followsNano = kind === 'nano' || NANO_SOURCE_HARNESSES.includes(kind);
    if (followsNano) void nanoAccount.catalogRevision;
    const forKey = JSON.stringify([id, kind]);
    if (untrack(() => catalogFor) !== forKey) {
      models = [];
      skills = [];
      modelsProvisional = false;
      modelsResolved = false;
    } else if (followsNano) {
      models = untrack(() => kind === 'nano' ? [] : models.filter(model => !isNanoConnectorModel(kind, model)));
    }
    catalogFor = forKey;
    modelsError = '';
    resourceNotes = [];
    // The load this effect cancelled may never settle: no early exit below keeps its spinner.
    modelsLoading = false;
    if (!id || !kind) return;
    // A boolean, not the workspace: every session event replaces the catalog.
    if (catalogBlocked) {
      // A restricted project cannot ask the harness. What the harness listed elsewhere is shown
      // meanwhile, so the picks carry over; sending asks for trust first, and the project's own
      // catalog replaces this list once it is trusted.
      const remembered = rememberedHarnessModels({ workspaceId: id, harness: kind });
      if (remembered && untrack(() => models.length === 0)) {
        models = remembered.models;
        modelsProvisional = true;
      }
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    modelsLoading = true;
    const show = (result: HarnessModelsResult): void => {
      if (cancelled) return;
      models = result.models;
      modelsProvisional = false;
      modelsResolved = true;
      const unavailable = catalogUnavailable(result);
      // A failed discovery keeps the skills this picker already showed.
      if (!unavailable || result.resources.items.length) skills = result.resources.items;
      resourceNotes = resourceNotices(result);
      modelsError = '';
    };
    // A native probe can fail transiently (slow harness start); retry once
    // before reporting, unless the host refused with a code. A remembered
    // catalog stays selectable meanwhile.
    const load = (attempt: number): void => {
      const failed = (error: unknown): void => {
        if (cancelled) return;
        if (attempt === 0 && !isVerdict(error)) {
          retry = setTimeout(() => load(1), CATALOG_RETRY_DELAY_MS);
          return;
        }
        modelsError = errorMessage(error);
        modelsLoading = false;
        // Another project's models are not this project's answer.
        if (modelsProvisional) {
          models = [];
          modelsProvisional = false;
        }
      };
      // Another project's list of this harness shows while this one loads; the spinner stays.
      const provisional = (result: HarnessModelsResult): void => {
        // Called synchronously inside this effect: reading `models` must not make it a dependency.
        if (cancelled || untrack(() => models.length > 0)) return;
        models = result.models;
        modelsProvisional = true;
      };
      if (refresh && attempt === 0) {
        harnessModels({ workspaceId: id, harness: kind }, true, version)
          .then((result) => {
            show(result);
            if (!cancelled) modelsLoading = false;
          })
          .catch(failed);
        return;
      }
      cachedHarnessModels(
        { workspaceId: id, harness: kind },
        { onFresh: show, onError: failed, onProvisional: provisional, ...(version ? { version } : {}) },
      )
        .then((result) => {
          show(result);
          if (!cancelled) modelsLoading = false;
        })
        .catch(failed);
    };
    load(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  });

  // Harnesses picked before get this project's catalog in the background once the selected
  // one has answered: switching to them then shows the project's own list at once.
  $effect(() => {
    if (!workspaceId || !trusted || store.safeMode || !modelsResolved || modelsLoading || modelsProvisional) return;
    const id = workspaceId;
    const current = harness;
    const list = available;
    untrack(() => {
      const used = new Set<HarnessKind | undefined>([...Object.values(choices.projects), choices.last].map((choice) => choice?.harness));
      prewarmHarnessCatalogs(
        id,
        list
          .filter((item) => item.kind !== current && item.kind !== 'nano' && used.has(item.kind))
          .map((item) => ({ kind: item.kind, ...(item.version ? { version: item.version } : {}) })),
      );
    });
  });

  // A new chat starts like the project's last one (a saved pipeline or the harness), else through
  // the project's default chat pipeline, else directly (`startingExecutor`). Choosing in the picker
  // wins for that project until the project changes.
  // The pipeline store, the template helpers and the picker arrive after first paint (`lazyPipelines`).
  const pipelines = $derived(lazyPipelines.code?.chatPipelines);
  const library = $derived(pipelines?.libraries[workspaceId]);
  // Pipelines and templates are the desktop's screen: a remote browser starts direct chats only.
  // Code that could not load leaves direct chats, as safe mode does.
  const pipelinesAllowed = $derived(!remoteMode && trusted && !store.safeMode && !lazyPipelines.failed);
  /** Projects whose library was asked for, answered or not: a refused library no longer holds the start back. */
  const librariesAsked = new SvelteSet<string>();
  /** What a remembered pipeline is now, read once per project and pipeline in this composer (null: gone). Key `${workspaceId}:${commandId}`. */
  const pipelineChecks = new SvelteMap<string, PipelineCandidate | null>();
  const checkingPipelines = new Set<string>();
  /** The project in which the person chose an executor in the picker; what was remembered no longer decides there. */
  let executorPickedIn = $state<string | undefined>();
  /** The remembered executor is still being restored: sending now would start with the wrong one and overwrite the memory. */
  let executorPending = $state(true);
  $effect(() => {
    const id = workspaceId;
    const code = pipelines;
    if (!id || !pipelinesAllowed || !code) return;
    untrack(() => {
      if (!code.libraries[id]) void code.loadLibrary(id).finally(() => librariesAsked.add(id));
    });
  });
  $effect(() => {
    void workspaceId;
    untrack(() => (executorPickedIn = undefined));
  });
  $effect(() => {
    const id = workspaceId;
    if (!id) return;
    const allowed = pipelinesAllowed;
    const code = pipelines;
    const remembered = untrack(() => executorOf(choices.projects[id]));
    const check = allowed && code && remembered?.pipeline ? `${id}:${remembered.pipeline}` : undefined;
    const candidate = check === undefined ? undefined : pipelineChecks.get(check);
    if (code && check !== undefined && candidate === undefined) untrack(() => verifyPipeline(code, id, remembered?.pipeline ?? '', check));
    // The picker's own rules, read live: a teammate turned off or an agent installed later changes the answer.
    const usable = rememberedPipelineUsable({
      candidate,
      teammate: teammates.byLaunchCommand(id, remembered?.pipeline),
      teamKnown: teammates.teams[id] !== undefined,
      harnesses: executorHarnesses,
    });
    const start = startingExecutor(remembered, {
      allowed,
      chatDefault: library ? (library.chatDefault ?? '') : undefined,
      libraryFailed: !library && librariesAsked.has(id),
      rememberedUsable: usable,
    });
    untrack(() => {
      // Safe mode and a restricted project always talk directly, whatever was picked.
      const picked = executorPickedIn === id && allowed;
      executorPending = !start.ready && !picked;
      if (!start.ready || picked) return;
      if (pipelineId !== start.pipeline) pipelineId = start.pipeline;
    });
  });
  /**
   * A pipeline remembered from an earlier chat may have been deleted, lost its message input or its
   * teammate may have been turned off since: it is read again, with the project's teammates, before
   * it is selected for the person.
   */
  function verifyPipeline(code: PipelineCode['chatPipelines'], id: string, commandId: string, key: string): void {
    if (!commandId || checkingPipelines.has(key)) return;
    checkingPipelines.add(key);
    const read = code.detail(id, commandId, true).then(
      (detail): PipelineCandidate => ({ accepts: detail.accepts, ...(detail.reply ? { replyHarness: detail.reply.harness } : {}) }),
      () => null,
    );
    void Promise.all([read, teammates.ensure(id, true).catch(() => undefined)]).then(([candidate]) => pipelineChecks.set(key, candidate));
  }
  $effect(() => {
    const id = workspaceId;
    const command = pipelineId;
    const code = pipelines;
    pipelineDetail = undefined;
    pipelineError = '';
    if (!id || !command || !code) return;
    let cancelled = false;
    pipelineLoading = true;
    code
      .detail(id, command)
      .then((detail) => {
        if (!cancelled) pipelineDetail = detail;
      })
      .catch((error: unknown) => {
        if (!cancelled) pipelineError = errorMessage(error);
      })
      .finally(() => {
        if (!cancelled) pipelineLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // A template belongs to the project it was chosen in.
  $effect(() => {
    void workspaceId;
    untrack(() => (templateChoice = undefined));
  });
  // A chosen template is built once, outside the first-paint bundle; its preview feeds the inputs bar and the send check.
  $effect(() => {
    const picked = templateChoice;
    const id = workspaceId;
    draft = undefined;
    draftError = '';
    draftLoading = false;
    const code = lazyPipelines.code;
    if (!picked || !id || !code) return;
    let cancelled = false;
    draftLoading = true;
    const base = untrack(() => (harness || available[0]?.kind || 'codex') as AgentProfile['harness']);
    const names = untrack(() => (code.chatPipelines.commands[id] ?? []).map((command) => ({ id: command.id, name: command.name })));
    const translate = (value: string, parameters: readonly unknown[] | undefined = undefined): string => $t(value, parameters);
    code.templateRun.draftFromTemplate(picked.choice, base, translate, names)
      .then((next) => {
        if (!cancelled) draft = next;
      })
      .catch((error: unknown) => {
        if (!cancelled) draftError = errorMessage(error);
      })
      .finally(() => {
        if (!cancelled) draftLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (modelKey && !explicitModelReady) return;
    if (thinkingLevel && !levels.includes(thinkingLevel)) thinkingLevel = '';
    if (fast && !model?.supportsFast) fast = false;
  });

  // Project file names for `@`, only for a trusted project.
  $effect(() => {
    if (mention?.trigger === '@' && trusted) fileMentions.update(workspaceId, mention.query);
  });

  onMount(() => {
    // The picker and the pipeline store are a chunk of their own; a failure shows in lazyPipelines.failed.
    loadPipelineCode();
    // Files dropped on the desktop window belong to the desktop; a remote browser takes text only.
    const unregister = remoteMode ? () => undefined : composerDropTargets.register((dropId) => {
      if (workspaceId && trusted) void attachments.redeem(workspaceId, dropId, imageState);
    });
    return () => {
      unregister();
      fileMentions.dispose();
    };
  });

  function persist(next: NewChatChoices): void {
    choices = next;
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(choices.projects));
      if (choices.last) localStorage.setItem(LAST_CHOICE_KEY, JSON.stringify(choices.last));
    } catch {
      // Remembered choices are a convenience only.
    }
  }

  /**
   * Picks are remembered when they are made, so they survive a project switch without a sent
   * message. The executor is remembered only when one is chosen or a chat starts: any other
   * pick keeps what the project remembered (the composer may not have settled on it yet).
   */
  function remember(executor: RememberedExecutor | undefined = undefined): void {
    if (!workspaceId) return;
    const kept = executor ?? executorOf(choices.projects[workspaceId]);
    persist(withChoice(choices, workspaceId, { harness: harness || undefined, modelKey, thinkingLevel, fast, permissionMode, ...(kept ? { executor: kept } : {}) }));
  }

  /** The executor of a project's chat as it is remembered: the saved pipeline, or empty for the harness, with the project's default at that time. */
  function executorMemory(targetId: string, commandId: string): RememberedExecutor {
    const known = pipelines?.libraries[targetId];
    return { pipeline: commandId, ...(known ? { chatDefault: known.chatDefault ?? '' } : {}) };
  }

  /**
   * A template is saved before its chat starts, so this runs long after the picks were read: the
   * project may have changed, and another composer may have remembered newer picks. Only this
   * project's executor is written, into what is stored now.
   */
  function rememberExecutorIn(targetId: string, executor: RememberedExecutor): void {
    persist(withExecutorIn(readChoices(), choices, targetId, executor));
  }

  const executor = $derived<Executor>(
    templateChoice
      ? { kind: 'template', id: templateChoice.key, name: templateChoice.name }
      : pipelineId
        ? { kind: 'pipeline', commandId: pipelineId }
        : { kind: 'direct', harness },
  );
  /** The message goes through a pipeline: a saved one, or a template saved on send. */
  const usesPipeline = $derived(Boolean(templateChoice) || Boolean(pipelineId));
  /** What the inputs bar shows: the template's unsaved preview, else the saved pipeline. */
  const barDetail = $derived(templateChoice ? (draft?.detail.accepts ? draft.detail : undefined) : pipelineDetail);
  const barError = $derived(
    templateChoice ? (draftError || (draft && !draft.detail.accepts ? 'This template does not accept chat messages.' : '')) : pipelineError,
  );
  const barLoading = $derived(templateChoice ? draftLoading : pipelineLoading);
  const executorHarnesses = $derived(
    store.catalog.harnesses.map((item) => ({
      kind: item.kind,
      name: item.name,
      ...(item.version ? { version: item.version } : {}),
      available: item.status === 'available',
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  );
  /** The harness that holds the chat: the pipeline's answering agent, else the direct pick. */
  const chatHarness = $derived<HarnessKind | ''>(usesPipeline ? (barDetail?.reply?.harness ?? harness) : harness);
  // Macros (ADR-060). A skill is written for the agent that reads the message: the Fusion lead, else the chat's agent.
  const macroHarness = $derived<HarnessKind | ''>(fusionMode && fusionPair ? fusionPair.lead.harness : chatHarness);
  const macroTokens = $derived(findMacroTokens(text, macros.list));
  const skillSyntax = $derived<SkillSyntax>({ skills: macroHarness === harness ? skillMentions : [], dollar: macroHarness ? composerSupport(macroHarness).skillMentions : false, ...(macroHarness === 'pi' ? { prefix: 'skill:' } : {}) });
  /** The message as it is sent. The expansion rules load only for a message that has a macro. */
  async function expanded(typed: string, known: readonly Macro[], syntax: SkillSyntax): Promise<string> {
    if (findMacroTokens(typed, known).length === 0) return typed;
    return (await import('../macros/expand')).expandMacros(typed, known, syntax);
  }

  function chooseExecutor(next: Executor): void {
    executorPickedIn = workspaceId;
    executorPending = false;
    if (next.kind === 'template') {
      const code = lazyPipelines.code;
      const choice = code?.templateRun.choiceFromKey(next.id, code.chatPipelines.libraries[workspaceId]?.templates ?? []);
      if (!choice) return;
      pipelineId = '';
      templateChoice = { choice, key: next.id, name: next.name };
      return;
    }
    templateChoice = undefined;
    if (next.kind === 'pipeline') {
      pipelineId = next.commandId;
      remember(executorMemory(workspaceId, next.commandId));
      return;
    }
    pipelineId = '';
    if (next.harness && next.harness !== harness) {
      harness = next.harness;
      modelKey = '';
      thinkingLevel = '';
      fast = false;
    }
    remember(executorMemory(workspaceId, ''));
  }

  /** The model a template step runs on: this composer's model for its own harness, else the first of the harness's catalog (the editor's rule). */
  async function templateModel(targetId: string, kind: AgentProfile['harness']): Promise<Pick<AgentProfile, 'model' | 'modelProvider'> | undefined> {
    if (kind === harness && model) return { model: model.id, ...(model.provider ? { modelProvider: model.provider } : {}) };
    const version = store.catalog.harnesses.find((item) => item.kind === kind)?.version;
    const result = await cachedHarnessModels({ workspaceId: targetId, harness: kind as HarnessKind }, version ? { version } : {});
    const first = result.models[0];
    return first ? { model: first.id, ...(first.provider ? { modelProvider: first.provider } : {}) } : undefined;
  }

  const loadPipelineCode = (): void => void lazyPipelines.load().catch(() => undefined);

  function managePipelines(): void {
    if (!workspaceId) return;
    store.selectWorkspace(workspaceId);
    store.navigate({ name: 'pipelines', section: 'systems' });
  }

  const modelOptions = $derived<ModelOption[]>(
    models.map((item) => ({
      key: modelSelectionKey(item),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: Boolean(item.supportsFast),
    })),
  );
  const permissionItems = $derived<{ value: PermissionMode; label: string; description: string }[]>([
    { value: 'native', label: $t('Harness default'), description: $t('Use the permissions configured in the harness') },
    { value: 'read-only', label: $t('Read only'), description: $t('The agent can read but not change files') },
    { value: 'workspace-write', label: $t('Edit project'), description: $t('Changes limited to the project folder') },
    { value: 'full-access', label: $t('Full access'), description: $t('No native restrictions — use with care') },
  ]);

  const explicitModelReady = $derived(
    catalogFor === JSON.stringify([workspaceId, harness]) && modelsResolved && !modelsProvisional && Boolean(model),
  );
  const canSend = $derived(
    Boolean(text.trim()) &&
      Boolean(workspaceId) &&
      !busy &&
      !store.safeMode &&
      // An explicit model must be present in this project's own catalog. In a restricted
      // project Send only opens the trust review (`send()` returns after `onTrust`).
      (fusionMode
        ? fusionReady
        : executorPending
          ? false
          : templateChoice
            ? Boolean(draft?.detail.accepts) && available.length > 0
            : pipelineId
              ? Boolean(pipelineDetail?.accepts) && available.length > 0
              : Boolean(harness) && (modelKey ? explicitModelReady || catalogBlocked : canUseDefaultModel)),
  );

  function setText(value: string): void {
    text = value;
    store.updateDraft(DRAFT_KEY, value);
  }

  /** Clear only this acknowledged request, including across navigation away. */
  function captureDraftAcknowledgement(): () => void {
    return store.captureDraftAcknowledgement(DRAFT_KEY);
  }

  async function place(value: string, position: number): Promise<void> {
    setText(value);
    caret = position;
    menuIndex = 0;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(position, position);
  }

  function syncCaret(): void {
    caret = textarea?.selectionStart ?? text.length;
  }

  // The dictation button and its recorder load once a dictation source is ready,
  // outside the first-paint bundle.
  const loadDictate = () => import('../nano/DictateButton.svelte');
  const loadPending = () => import('../nano/DictationPending.svelte');
  const dictationScope = $derived(`new:${workspaceId || 'personal'}`);

  /** Dictated words go in at the caret. The helper arrives with the dictation button. */
  function dictated(words: string): void {
    void import('../nano/dictation').then(({ insertAtCaret }) => {
      const next = insertAtCaret(text, textarea?.selectionStart ?? caret, words);
      return place(next.text, next.caret);
    });
  }

  function choose(index: number): void {
    const current = menu;
    if (!current || !mention) return;
    const replacement = current.kind === 'macro' ? (current.names[index] === undefined ? undefined : `//${current.names[index]}`) : current.kind === 'file' ? (current.paths[index] ? fileMention(current.paths[index]) : undefined) : current.mentions[index];
    if (!replacement) return;
    const next = replaceMention(text, mention, replacement);
    void place(next.text, next.caret);
  }

  /**
   * Everything a pipeline chat needs, captured once before the first await: the
   * composer stays editable, so the project, text or mode may change meanwhile.
   */
  type PipelineRequest = {
    workspaceId: string;
    commandId: string;
    /** As typed: its macros are replaced when the chat starts. */
    text: string;
    macros: readonly Macro[];
    syntax: SkillSyntax;
    values: Record<string, RunInputValue>;
    permissionMode: PermissionMode;
    fallbackHarness: HarnessKind;
    available: HarnessKind[];
    title: string;
    acknowledgeDraft: () => void;
  };

  function capturePipelineRequest(commandId: string, values: Record<string, RunInputValue>, fallbackHarness: HarnessKind): PipelineRequest {
    const typed = text;
    return {
      workspaceId,
      commandId,
      text: typed,
      macros: macros.list,
      syntax: skillSyntax,
      values,
      permissionMode,
      fallbackHarness,
      available: available.map((item) => item.kind),
      title: chatTitle(typed),
      acknowledgeDraft: captureDraftAcknowledgement(),
    };
  }

  /** Starts the chat from a captured request. The caller owns `busy`. */
  async function runPipelineRequest(request: PipelineRequest): Promise<void> {
    try {
      const { chatPipelines } = await lazyPipelines.load();
      await chatPipelines.startChat(store, {
        workspaceId: request.workspaceId,
        commandId: request.commandId,
        text: await expanded(request.text, request.macros, request.syntax),
        values: request.values,
        permissionMode: request.permissionMode,
        fallbackHarness: request.fallbackHarness,
        available: request.available,
        safeMode: store.safeMode,
        title: request.title,
      });
      request.acknowledgeDraft();
    } catch (error) {
      toasts.error($t('Could not start the chat'), $t(errorMessage(error)));
    }
  }

  async function sendThroughPipeline(): Promise<void> {
    if (attachments.images.length) {
      toasts.error($t('Pipelines take text only'), $t('Remove the images, or talk to the harness directly.'));
      return;
    }
    const values = inputsBar?.collect();
    const fallback = harness || available[0]?.kind;
    if (!values || !fallback) return;
    const request = capturePipelineRequest(pipelineId, values, fallback);
    busy = true;
    try {
      await runPipelineRequest(request);
    } finally {
      busy = false;
    }
  }

  /**
   * A template is saved as a new pipeline of the project on its first message
   * (ADR-053), then runs like any saved one. Nothing is saved when the draft
   * is not ready; once saved, the executor is the saved pipeline, so a failed
   * run start is retried without saving again.
   */
  async function sendThroughTemplate(): Promise<void> {
    const current = draft;
    if (!current) return;
    if (attachments.images.length) {
      toasts.error($t('Pipelines take text only'), $t('Remove the images, or talk to the harness directly.'));
      return;
    }
    const values = inputsBar?.collect();
    const fallback = harness || available[0]?.kind;
    if (!values || !fallback) return;
    // The whole request is captured before the first await (the saved pipeline's id is the
    // only missing piece): the person may switch project or edit the text while it saves.
    const targetId = workspaceId;
    const request = capturePipelineRequest('', values, fallback);
    busy = true;
    try {
      let commandId: string;
      try {
        const code = await lazyPipelines.load();
        const taken = (code.chatPipelines.commands[targetId] ?? []).map((command) => command.name);
        const graph = await code.templateRun.readyToSave(current, (kind) => templateModel(targetId, kind), taken, (value, parameters) => $t(value, parameters));
        commandId = await code.chatPipelines.saveTemplate(targetId, graph);
        code.templateRun.rememberPipeline(targetId, current.key, commandId);
        rememberExecutorIn(targetId, executorMemory(targetId, commandId));
        toasts.show({ title: $t('Saved “{0}” to this project’s pipelines', [graph.name]) });
      } catch (error) {
        toasts.error($t('Could not save the pipeline'), $t(errorMessage(error)));
        return;
      }
      if (workspaceId === targetId) {
        templateChoice = undefined;
        pipelineId = commandId;
      }
      await runPipelineRequest({ ...request, commandId });
    } finally {
      busy = false;
    }
  }

  async function sendFusion(): Promise<void> {
    const pair = fusionPair;
    if (!pair) return;
    // Capture the whole request before the lazy import yields: the person may
    // pick another project or edit the text while the module loads.
    const targetId = workspaceId;
    const typed = text;
    const known = macros.list;
    const syntax = skillSyntax;
    const title = chatTitle(typed);
    const images = attachments.images;
    const acknowledgeDraft = captureDraftAcknowledgement();
    busy = true;
    try {
      const { startFusionChat } = await import('../fusion/startFusionChat');
      const message = await expanded(typed, known, syntax);
      const outcome = await startFusionChat(store, { workspaceId: targetId, pair, text: message, images, ...(title ? { title } : {}) });
      if (outcome.kind === 'refused') {
        toasts.error($t('The pair cannot start'), `${$t(roleLabel(outcome.role))}: ${$t(refusalCopy(outcome.refusal).title)}`);
        return;
      }
      // Only what was sent is cleared; text typed or images added meanwhile stay.
      acknowledgeDraft();
      if (outcome.error) toasts.error($t('The Fusion chat started, but the first message was not sent'), $t(outcome.error));
    } catch (error) {
      toasts.error($t('Could not start the chat'), $t(fusionErrorText(error)));
    } finally {
      busy = false;
    }
  }

  async function send(): Promise<void> {
    if (!canSend) return;
    if (workspace && !workspace.personal && workspace.trust !== 'trusted') {
      onTrust(workspace);
      return;
    }
    if (fusionMode) {
      await sendFusion();
      return;
    }
    if (templateChoice) {
      remember();
      await sendThroughTemplate();
      return;
    }
    if (pipelineId) {
      remember(executorMemory(workspaceId, pipelineId));
      await sendThroughPipeline();
      return;
    }
    if (!harness) return;
    busy = true;
    // A direct start that was forced (no pipelines here, or their code did not load) is not a choice: the project keeps what it remembered.
    remember(pipelinesAllowed ? executorMemory(workspaceId, '') : undefined);
    // Started now, with the text as it is: the macro rules may still be loading when the chat is created.
    const message = expanded(text, macros.list, skillSyntax);
    const title = chatTitle(text);
    // The images move to the new chat: to its queued message, or to its draft if sending fails.
    const images = attachments.images;
    const acknowledgeDraft = captureDraftAcknowledgement();
    try {
      await store.startChat({
        workspaceId,
        harness,
        model,
        permissionMode,
        thinkingLevel: thinkingLevel || undefined,
        serviceTier: model?.supportsFast ? (fast ? 'fast' : undefined) : undefined,
        // The picks above are read before this wait.
        text: await message,
        ...(title ? { title } : {}),
        ...(images.length ? { attachments: images } : {}),
      });
      acknowledgeDraft();
    } catch (error) {
      toasts.error($t('Could not start the chat'), errorMessage(error));
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'F2' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const token = macroTokenAt(macroTokens, textarea?.selectionStart ?? caret);
      if (token) {
        event.preventDefault();
        macros.requestEdit(token.macro.id);
        store.navigate({ name: 'settings', section: 'macros' });
        return;
      }
    }
    const items = menu?.items ?? [];
    if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      menuIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    } else if (event.key === 'Escape' && menu) {
      event.preventDefault();
      menuDismissed = true;
    } else if (items.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  function pasted(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || !workspaceId) return;
    event.preventDefault();
    if (remoteMode) return;
    void attachments.paste(workspaceId, files, imageState);
  }

  const carriesFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer?.types.includes('Files'));

  function dropped(event: DragEvent): void {
    htmlDragging = false;
    if (!carriesFiles(event) || !workspaceId) return;
    event.preventDefault();
    if (remoteMode) return;
    void attachments.paste(workspaceId, [...(event.dataTransfer?.files ?? [])], imageState);
  }

  function pick(): void {
    if (workspace && !trusted) {
      onTrust(workspace);
      return;
    }
    if (workspaceId) void attachments.pick(workspaceId, imageState);
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

  export function focus(): void {
    textarea?.focus();
  }
</script>

<div data-nano-composer="root" class="new-composer">
{#if !remoteMode}
  <FusionModeBar
    {workspaceId}
    {trusted}
    harnesses={executorHarnesses}
    disabled={busy || store.safeMode}
    bind:active={fusionMode}
    bind:pair={fusionPair}
    bind:ready={fusionReady}
  />
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions (Drop target for files; the paperclip is the keyboard path.) -->
<div
  class="composer"
  data-nano-composer="surface"
  class:composer--busy={busy}
  class:composer--drop={htmlDragging || composerDropTargets.dragging}
  ondragover={(event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    htmlDragging = !remoteMode;
  }}
  ondragleave={() => (htmlDragging = false)}
  ondrop={dropped}
>
  <!-- Menus, chips, notices and the reference dialog load on first use: the Home composer is on the first paint. -->
  {#if menu}
    {#await import('../chat/composer/MentionMenu.svelte') then view}
      <view.default
        id="new-chat-menu"
        label={menu.kind === 'macro' ? $t('Macros') : menu.kind === 'file' ? $t('Project files') : $t('Skills')}
        items={menu.items}
        active={activeIndex}
        loading={menu.kind === 'file' && fileMentions.loading}
        emptyText={menuEmpty}
        onPick={choose}
      />
    {/await}
  {/if}
  {#if attachments.images.length}
    {#await import('../chat/composer/AttachmentChips.svelte') then view}
      <view.default images={attachments.images} disabled={busy} onRemove={(id: string) => void attachments.remove(id)} />
    {/await}
  {/if}
  {#if attachments.images.length && !imageState.supported}
    <p class="composer__warning" role="alert">{$t(imageState.reason ?? '')} {$t('Remove the images to send this message.')}</p>
  {/if}
  {#if attachments.notices.length}
    {#await import('../chat/composer/AttachmentNotices.svelte') then view}
      <view.default notices={attachments.notices} onDismiss={() => attachments.dismissNotices()} />
    {/await}
  {/if}
  {#if usesPipeline && !fusionMode}
    {#if templateChoice && draftLoading}
      <p class="composer__template"><Spinner size={12} /> {$t('Preparing the template…')}</p>
    {:else}
      {#await loadInputsBar() then { default: PipelineInputsBar }}
        <PipelineInputsBar bind:this={inputsBar} detail={barDetail} loading={barLoading} error={barError} disabled={busy} />
      {/await}
    {/if}
  {/if}
  <div class="composer__field">
    <ComposerTextarea
      bind:ref={textarea}
      value={text}
      oninput={(event) => {
        setText(event.currentTarget.value);
        syncCaret();
        menuDismissed = false;
        menuIndex = 0;
      }}
      beforeKeyDown={keydown}
      onSubmit={() => void send()}
      onkeyup={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncCaret();
      }}
      onclick={syncCaret}
      onpaste={pasted}
      minRows={3}
      maxRows={14}
      placeholder={usesPipeline ? $t('Describe the task for the pipeline…') : remoteMode ? $t('Message') : $t('Describe a task, ask a question or @mention a file…')}
      aria-label={$t('Message')}
      aria-autocomplete="list"
      aria-controls={menu ? 'new-chat-menu' : undefined}
      aria-activedescendant={menu && menu.items.length ? `new-chat-menu-${activeIndex}` : undefined}
      class="composer__input"
      disabled={store.safeMode}
    />
    {#if macroTokens.length}
      {#await import('../chat/composer/MacroLayer.svelte') then view}
        <view.default input={textarea} {text} tokens={macroTokens} syntax={skillSyntax} quiet={Boolean(menu)} onEdit={(macro: Macro) => { macros.requestEdit(macro.id); store.navigate({ name: 'settings', section: 'macros' }); }} />
      {/await}
    {/if}
  </div>
  {#if !remoteMode}
    {#await loadPending() then { default: DictationPending }}
      <DictationPending scope={dictationScope} onText={dictated} disabled={busy || store.safeMode} />
    {/await}
  {/if}
  <div data-nano-composer="bar">
    <div class="chips">
      {#if !remoteMode}
        <AttachButton images={imageState} busy={attachments.busy} disabled={busy || store.safeMode || !workspaceId || (usesPipeline && !fusionMode)} onPick={pick} />
      {/if}
      {#if dictationSource.available && !remoteMode}
        {#await loadDictate() then { default: DictateButton }}
          <DictateButton onText={dictated} scope={dictationScope} disabled={busy || store.safeMode} />
        {/await}
      {/if}
      {#if !fusionMode}
      {#if lazyPipelines.code}
        {@const ExecutorPicker = lazyPipelines.code.ExecutorPicker}
        <ExecutorPicker
          {workspaceId}
          value={executor}
          harnesses={executorHarnesses}
          templates={pipelinesAllowed}
          disabled={available.length === 0 && !usesPipeline}
          onChange={chooseExecutor}
          onManage={pipelinesAllowed ? managePipelines : undefined}
        />
      {:else}
        <ExecutorChip {harness} onRetry={lazyPipelines.failed ? loadPipelineCode : undefined} />
      {/if}

      {#if harness && !usesPipeline}
        <ModelPicker
          models={modelOptions}
          {harness}
          value={model ? modelSelectionKey(model) : modelKey}
          defaultOption={canUseDefaultModel}
          loading={modelsLoading}
          error={modelsError}
          {levels}
          level={thinkingLevel}
          levelDefault={true}
          fastAvailable={Boolean(model?.supportsFast)}
          {fast}
          hint={model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
          onModel={(value) => {
            modelKey = value;
            remember();
          }}
          onLevel={(value) => {
            thinkingLevel = value;
            remember();
          }}
          onFast={(value) => {
            fast = value;
            remember();
          }}
        >
          {#snippet trigger(props)}
            <button type="button" class="chip" {...props} aria-busy={modelsLoading || undefined}>
              {#if modelsLoading}<Spinner size={12} />{:else}<Brain size={14} />{/if}
              <span>{model?.name ?? (modelKey ? $t('Choose a model') : $t('Default model'))}</span>
              {#if thinkingLevel}<span class="chip__sub">{$t(thinkingLevel)}</span>{/if}
              {#if fast}<Zap size={12} />{/if}
              <ChevronDown size={12} />
            </button>
          {/snippet}
        </ModelPicker>
      {/if}
      {/if}

      <span class="chips__gap"></span>
      <ContextChip
        {workspaces}
        {workspaceId}
        {permissionMode}
        permissions={permissionItems}
        worktree={!usesPipeline && !fusionMode && !remoteMode}
        permissionsApply={!fusionMode}
        disabled={store.safeMode}
        onWorkspace={(value) => (workspaceId = value)}
        onPermission={(value) => {
          permissionMode = value;
          remember();
        }}
      />
    </div>
    <button type="button" data-nano-composer="send" onclick={() => void send()} disabled={!canSend} aria-label={$t('Start chat')}>
      {#if busy}<Spinner size={14} />{:else}<ArrowUp size={16} />{/if}
    </button>
  </div>
  {#if htmlDragging || composerDropTargets.dragging}
    <div class="composer__drop" aria-hidden="true">{$t('Drop images or files to attach')}</div>
  {/if}
</div>
{#if templateChoice && !fusionMode && !draftLoading}
  <p class="notice">{$t('Sending saves this template as a pipeline in this project.')}</p>
{/if}
{#if chatHarness === 'claude-code' && workspaceId && !remoteMode}{#await import('../chat/ClaudeSignInStatus.svelte') then status}<status.default {workspaceId} observe />{/await}{/if}
{#if workspace && !workspace.personal && workspace.trust !== 'trusted'}
  <p class="notice">
    {$t('This folder is restricted. Trust it to let agents work on its files.')}
    <button type="button" class="link" onclick={() => onTrust(workspace)}>{$t('Review trust…')}</button>
  </p>
{:else if modelsError && modelsError !== workspaceError({ code: 'SIGN_IN_REQUIRED' }).message}
  <p class="notice notice--error" role="status">
    {$t(modelsError)}
    <button type="button" class="link" onclick={retryCatalog}>{$t('Retry')}</button>
  </p>
{:else if !usesPipeline && !fusionMode && modelsResolved && !modelsLoading && !modelsProvisional && models.length === 0}
  <p class="notice" role="status">
    {$t("This agent listed no models. Sign in or add a provider in the agent's own app, then try again.")}
    <button type="button" class="link" onclick={retryCatalog}>{$t('Retry')}</button>
  </p>
{:else if !usesPipeline && !fusionMode && modelKey && modelsResolved && !model}
  <p class="notice notice--error">{$t('Choose a model')}</p>
{:else if resourceNotes.length && !modelsLoading && !fusionMode}
  <p class="notice" role="status">
    {#each resourceNotes as note, index}{#if index > 0}{' '}{/if}{$t(note.key, note.args ?? [])}{/each}
    <button type="button" class="link" onclick={retryCatalog}>{$t('Retry')}</button>
  </p>
{/if}
{#if attachments.references.length}
  {#await import('../chat/composer/ReferenceDialog.svelte') then view}
    <view.default references={attachments.references} onConfirm={insertReferences} onCancel={() => attachments.cancelReferences()} />
  {/await}
{/if}
</div>

<style>
  .composer__field { position: relative; }
  .new-composer {
    --nano-composer-editor-padding: 14px 16px 6px;
    --nano-composer-bar-padding: 6px 8px 8px 10px;
  }
  .composer--drop {
    border-color: var(--piui-focus);
  }
  .composer__warning {
    margin: 8px 12px 0;
    color: var(--piui-warning-text);
    font-size: var(--piui-text-sm);
  }
  .composer__template {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 6px 12px 0 14px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
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
  .chips {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover:not(:disabled),
  .chip[data-state='open'] {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chips__gap {
    flex: 1;
  }
  .chip__sub {
    color: var(--piui-text-muted);
  }
  .chip--warn {
    color: var(--piui-warning);
  }
  .notice {
    margin: var(--piui-space-2) 4px 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .notice--error {
    color: var(--piui-danger);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
</style>
