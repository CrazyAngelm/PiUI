<script lang="ts">
  import { untrack } from 'svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Brain from '@lucide/svelte/icons/brain';
  import Zap from '@lucide/svelte/icons/zap';
  import Route from '@lucide/svelte/icons/route';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import { Button, Checkbox, Dialog, Input, Picker, Segmented, Spinner, Switch, Textarea, type PickerItem } from '../../lib/ui';
  import type { HarnessKind, PermissionMode } from '../../../../../contracts/workspace-v15';
  import type { HarnessCatalogModel } from '../../../../../contracts/harness-models-v18';
  import { cachedHarnessModels } from '../../host-api/harnessModels';
  import { orchestrationHost } from '../../host-api/orchestrationClient';
  import {
    MAX_TEAMMATE_ROLE_CHARS,
    type TeammateDraftV1,
    type TeammateStartRuleV1,
    type TeammateV1,
  } from '../../host-api/teammatesClient';
  import type { BoardPermissionsV1 } from '../../host-api/boardClient';
  import { chatPipelines } from '../chatPipelines/chatPipelines.svelte';
  import { harnessMeta } from '../harnessMeta';
  import ModelPicker, { type ModelOption } from '../shell/ModelPicker.svelte';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { PERMISSION_COPY } from '../board/boardModel';
  import { AVATAR_EMOJIS, handleFromName, handleProblem, initials, uniqueHandle } from './handle';
  import TeammateAvatar from './TeammateAvatar.svelte';
  import { teammates } from './teammatesStore.svelte';

  interface Props {
    workspaceId: string;
    /** Present to edit an existing teammate. */
    teammate?: TeammateV1;
    onClose: (saved: TeammateV1 | undefined) => void;
  }
  let { workspaceId, teammate, onClose }: Props = $props();

  const store = useWorkspace();
  const COLORS = ['chaos', 'chaos-gold', 'chaos-spark', 'accent', 'info', 'success', 'warning'] as const;
  const STEP_TITLES = ['Who is it?', 'What runs it?', 'When does it work?'] as const;
  const DEFAULT_PERMISSIONS: BoardPermissionsV1 = { read: true, comment: true, create: false, move: true, claim: true, assign: false };

  let open = $state(true);
  let step = $state(0);
  let busy = $state(false);
  let error = $state('');

  /** The dialog is keyed per teammate: fields start from the teammate it opened with. */
  const initial = untrack(() => teammate);
  // Step 1: identity.
  let name = $state(initial?.name ?? '');
  let handle = $state(initial?.handle ?? '');
  let handleEdited = $state(initial !== undefined);
  let color = $state(initial?.color ?? 'chaos');
  let avatar = $state(initial?.avatar ?? '');
  let avatarEdited = $state(initial !== undefined);
  let role = $state(initial?.role ?? '');

  // Step 2: what runs it.
  let kind = $state<'simple' | 'pipeline'>(initial?.kind.type ?? 'simple');
  let harness = $state<HarnessKind | ''>('');
  let modelKey = $state('');
  let reasoning = $state('');
  let fast = $state(false);
  let permissionMode = $state<PermissionMode>('workspace-write');
  let instructions = $state('');
  let launchCommandId = $state(initial?.kind.type === 'pipeline' ? initial.launchCommandId : '');
  let models = $state.raw<HarnessCatalogModel[]>([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let profileLoading = $state(false);

  // Step 3: rules.
  let onAssign = $state<TeammateStartRuleV1>(initial?.wake.onAssign ?? 'ask');
  let onMention = $state(initial?.wake.onMention ?? true);
  let board = $state<BoardPermissionsV1>({ ...(initial?.board ?? DEFAULT_PERMISSIONS) });
  let maxConcurrentRuns = $state(initial?.maxConcurrentRuns ?? 1);
  let cardInput = $state(initial?.cardInput.type === 'named' ? initial.cardInput.inputName : '');
  let enabled = $state(initial?.enabled ?? true);

  const others = $derived(teammates.list(workspaceId).filter((item) => item.id !== teammate?.id));
  const takenHandles = $derived(others.map((item) => item.handle));
  const problem = $derived(handleProblem(handle, takenHandles));
  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available'));
  const model = $derived(models.find((item) => JSON.stringify([item.provider, item.id]) === modelKey));
  const levels = $derived(model?.thinkingLevels ?? []);
  const modelOptions = $derived<ModelOption[]>(
    models.map((item) => ({
      key: JSON.stringify([item.provider, item.id]),
      name: item.name,
      id: item.id,
      ...(item.provider ? { provider: item.provider } : {}),
      reasoning: Boolean(item.thinkingLevels?.length),
      fast: Boolean(item.supportsFast),
    })),
  );
  /** Launch commands a pipeline teammate may wrap: not another simple teammate's managed one. */
  const managedIds = $derived(new Set(others.filter((item) => item.kind.type === 'simple').map((item) => item.launchCommandId)));
  const commands = $derived((chatPipelines.commands[workspaceId] ?? []).filter((command) => !managedIds.has(command.id) && !(teammate?.kind.type === 'simple' && command.id === teammate.launchCommandId)));
  const commandDetail = $derived(launchCommandId ? chatPipelines.detailFor(workspaceId, launchCommandId) : undefined);
  const textInputs = $derived((commandDetail?.inputs ?? []).filter((input) => input.kind === 'text' || input.kind === 'long-text'));

  $effect(() => {
    const id = workspaceId;
    if (chatPipelines.commands[id] === undefined) untrack(() => void chatPipelines.loadProject(id));
  });

  // Name → handle and initials until the person edits them.
  $effect(() => {
    const value = name;
    untrack(() => {
      if (!handleEdited) handle = uniqueHandle(handleFromName(value), takenHandles);
      if (!avatarEdited) avatar = initials(value || '?');
    });
  });

  // Editing a simple teammate starts from its generated profile.
  $effect(() => {
    const current = teammate;
    if (current?.kind.type !== 'simple') {
      if (!harness) harness = untrack(() => available.find((item) => item.kind === 'claude-code')?.kind ?? available[0]?.kind ?? '');
      return;
    }
    const profileId = current.kind.profileId;
    profileLoading = true;
    void orchestrationHost
      .orchestration_get_profile_v6({ workspaceId, id: profileId })
      .then((stored) => {
        const profile = stored?.value;
        if (!profile) return;
        harness = profile.harness;
        modelKey = JSON.stringify([profile.modelProvider, profile.model]);
        reasoning = profile.reasoning ?? '';
        fast = profile.serviceTier === 'fast';
        permissionMode = profile.permissionMode;
        instructions = profile.instructions;
      })
      .catch((cause: unknown) => (error = errorMessage(cause)))
      .finally(() => (profileLoading = false));
  });

  // Native model catalog of the chosen harness (reused from the new-chat composer).
  $effect(() => {
    const kindNow = harness;
    models = [];
    modelsError = '';
    if (!kindNow || kind !== 'simple') return;
    let cancelled = false;
    modelsLoading = true;
    cachedHarnessModels({ workspaceId, harness: kindNow }, { onFresh: (result) => { if (!cancelled) models = result.models; } })
      .then((result) => {
        if (!cancelled) models = result.models;
      })
      .catch((cause: unknown) => {
        if (!cancelled) modelsError = errorMessage(cause);
      })
      .finally(() => {
        if (!cancelled) modelsLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const harnessItems = $derived<PickerItem[]>(
    store.catalog.harnesses.map((item) => ({
      value: item.kind,
      label: item.name,
      description: item.version ? `v${item.version}` : undefined,
      disabled: item.status !== 'available',
      disabledReason: item.reason ?? $t('Not available'),
    })),
  );
  const permissionItems = $derived<PickerItem<PermissionMode>[]>([
    { value: 'native', label: $t('Harness settings'), description: $t('Use the permissions configured in the harness') },
    { value: 'read-only', label: $t('Read only'), description: $t('The agent can read but not change files') },
    { value: 'workspace-write', label: $t('Edit project'), description: $t('Changes limited to the project folder') },
    { value: 'full-access', label: $t('Full access'), description: $t('No native restrictions — use with care') },
  ]);
  const commandItems = $derived<PickerItem[]>(
    commands.map((command) => {
      const detail = chatPipelines.detailFor(workspaceId, command.id);
      return {
        value: command.id,
        label: command.name || $t('Untitled pipeline'),
        description: detail ? $t('{0} inputs', [detail.inputs.length]) : undefined,
        keywords: [command.name],
      };
    }),
  );

  const stepValid = $derived.by(() => {
    if (step === 0) return name.trim().length > 0 && problem === undefined && [...avatar.trim()].length >= 1 && [...avatar.trim()].length <= 8 && [...role].length <= MAX_TEAMMATE_ROLE_CHARS;
    if (step === 1) return kind === 'simple' ? Boolean(harness) && Boolean(model ?? modelKey) && !profileLoading : Boolean(launchCommandId);
    return maxConcurrentRuns >= 1 && maxConcurrentRuns <= 8 && (cardInput === '' || textInputs.some((input) => input.name === cardInput) || kind === 'simple');
  });

  /** Initials of the name, then an avatar kept from an older teammate, then the ready-made emoji. */
  const nameInitials = $derived(initials(name || '?'));
  const keptAvatar = initial !== undefined && !AVATAR_EMOJIS.includes(initial.avatar) ? initial.avatar : undefined;
  const avatarChoices = $derived([
    ...new Set([nameInitials, ...(keptAvatar !== undefined && keptAvatar !== nameInitials ? [keptAvatar] : []), ...AVATAR_EMOJIS]),
  ]);

  function pickAvatar(choice: string): void {
    avatarEdited = choice !== nameInitials;
    avatar = choice;
  }

  /** Radio-group keys: arrows move and select within the wrapping grid. */
  function moveAvatarFocus(event: KeyboardEvent): void {
    const grid = event.currentTarget as HTMLElement;
    const buttons = [...grid.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -index, End: buttons.length - 1 - index }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = Math.min(buttons.length - 1, Math.max(0, index + delta));
    const choice = avatarChoices[next];
    if (choice !== undefined) pickAvatar(choice);
    buttons[next]?.focus();
  }

  function problemText(value: typeof problem): string | undefined {
    switch (value) {
      case undefined:
        return undefined;
      case 'empty':
        return $t('Enter a handle.');
      case 'pattern':
        return $t('2-32 lowercase letters, digits or hyphens, starting with a letter or digit.');
      case 'taken':
        return $t('Another teammate of this project uses @{0}.', [handle]);
      default: {
        const exhaustive: never = value;
        return exhaustive;
      }
    }
  }

  function draft(): TeammateDraftV1 {
    const parsed = modelKey ? (JSON.parse(modelKey) as [string | undefined | null, string]) : undefined;
    return {
      ...(teammate ? { id: teammate.id, expectedRevision: teammate.revision } : {}),
      handle,
      name: name.trim(),
      color,
      avatar: avatar.trim(),
      role: role.trim(),
      body:
        kind === 'simple'
          ? {
              type: 'simple',
              agent: {
                harness: harness as HarnessKind,
                ...(parsed?.[0] ? { modelProvider: parsed[0] } : {}),
                model: parsed?.[1] ?? '',
                permissionMode,
                ...(reasoning ? { reasoning } : {}),
                ...(fast ? { serviceTier: 'fast' as const } : {}),
                instructions: instructions.trim(),
              },
            }
          : { type: 'pipeline', launchCommandId },
      cardInput: kind === 'pipeline' && cardInput ? { type: 'named', inputName: cardInput } : { type: 'auto' },
      board: $state.snapshot(board),
      maxConcurrentRuns,
      wake: { onAssign, onMention },
      enabled,
    };
  }

  async function save(): Promise<void> {
    busy = true;
    error = '';
    try {
      const saved = await teammates.save(workspaceId, draft());
      // Simple teammates add managed definitions: refresh the pipeline lists.
      void chatPipelines.loadProject(workspaceId);
      open = false;
      onClose(saved);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function close(): void {
    if (busy) return;
    open = false;
    onClose(undefined);
  }

  function createPipeline(): void {
    close();
    store.selectWorkspace(workspaceId);
    store.navigate({ name: 'pipelines', section: 'systems' });
  }
</script>

<Dialog
  bind:open
  title={teammate ? $t('Edit @{0}', [teammate.handle]) : $t('New teammate')}
  description={$t('Step {0} of 3: {1}', [step + 1, $t(STEP_TITLES[step] ?? '')])}
  size="lg"
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <ol class="steps" aria-label={$t('Steps')}>
    {#each STEP_TITLES as title, index (title)}
      <li class="steps__item" class:steps__item--current={index === step} class:steps__item--done={index < step} aria-current={index === step ? 'step' : undefined}>
        <span class="steps__blade" aria-hidden="true"></span>{$t(title)}
      </li>
    {/each}
  </ol>

  {#if step === 0}
    <div class="grid">
      <label class="field">
        <span class="field__label">{$t('Name')}</span>
        <Input bind:value={name} maxlength={80} placeholder={$t('Code reviewer')} />
      </label>
      <label class="field">
        <span class="field__label">{$t('Handle')}</span>
        <Input
          value={handle}
          maxlength={32}
          invalid={problem !== undefined && handle !== ''}
          aria-describedby="teammate-handle-note"
          oninput={(event) => {
            handleEdited = true;
            handle = event.currentTarget.value.toLowerCase();
          }}
        >
          {#snippet leading()}<span class="at">@</span>{/snippet}
        </Input>
        <span id="teammate-handle-note" class="note" class:note--error={problem !== undefined && handle !== ''}>
          {problemText(problem) ?? $t('People and agents write @{0} to hand it work.', [handle])}
        </span>
      </label>
      <div class="field field--wide look">
        <div class="look__preview">
          <TeammateAvatar avatar={avatar || '?'} {color} size={56} />
          <span class="look__handle">@{handle || '…'}</span>
        </div>
        <div class="look__options">
          <span class="field__label" id="teammate-color-label">{$t('Color')}</span>
          <div class="swatches" role="radiogroup" aria-labelledby="teammate-color-label">
            {#each COLORS as token, index (token)}
              <button
                type="button"
                role="radio"
                aria-checked={color === token}
                aria-label={$t('Color {0}', [index + 1])}
                class="swatch"
                class:swatch--current={color === token}
                style:--swatch={`var(--piui-${token})`}
                onclick={() => (color = token)}
              ></button>
            {/each}
          </div>
          <span class="field__label" id="teammate-avatar-label">{$t('Avatar')}</span>
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="emojis" role="radiogroup" aria-labelledby="teammate-avatar-label" onkeydown={moveAvatarFocus}>
            {#each avatarChoices as choice (choice)}
              <button
                type="button"
                role="radio"
                aria-checked={avatar === choice}
                aria-label={choice === nameInitials ? $t('Initials {0}', [choice]) : choice}
                tabindex={avatar === choice || (!avatarChoices.includes(avatar) && choice === nameInitials) ? 0 : -1}
                class="emoji"
                class:emoji--initials={choice === nameInitials}
                class:emoji--current={avatar === choice}
                onclick={() => pickAvatar(choice)}
              >{choice}</button>
            {/each}
          </div>
        </div>
      </div>
      <label class="field field--wide">
        <span class="field__label">{$t('Role')}</span>
        <Textarea bind:value={role} minRows={2} maxRows={5} maxlength={MAX_TEAMMATE_ROLE_CHARS} placeholder={$t('What it is good at and when to hand it work. Agents read this in the roster.')} />
      </label>
    </div>
  {:else if step === 1}
    <Segmented
      value={kind}
      label={$t('What runs it?')}
      options={[
        { value: 'simple', label: $t('One agent') },
        { value: 'pipeline', label: $t('A saved pipeline') },
      ]}
      onValueChange={(value: 'simple' | 'pipeline') => (kind = value)}
    />
    {#if kind === 'simple'}
      <p class="note">{$t('PiUI saves a one-step pipeline for it, marked as managed by @{0}.', [handle])}</p>
      <div class="chips">
        <Picker items={harnessItems} value={harness} label={$t('Harness')} searchPlaceholder={$t('Search harnesses')} onSelect={(value) => { harness = value as HarnessKind; modelKey = ''; reasoning = ''; }}>
          {#snippet trigger(props)}
            <button type="button" class="chip" {...props} aria-label={$t('Harness')}>
              {#if harness}<HarnessMark kind={harness} size={16} />{/if}
              <span>{harness ? harnessMeta(harness).label : $t('Pick a harness')}</span>
              <ChevronDown size={12} />
            </button>
          {/snippet}
        </Picker>
        {#if harness}
          <ModelPicker
            models={modelOptions}
            value={modelKey}
            loading={modelsLoading}
            error={modelsError}
            {levels}
            level={reasoning}
            levelDefault={true}
            fastAvailable={Boolean(model?.supportsFast)}
            {fast}
            hint={model ? $t('This model has no reasoning options.') : $t('Pick a model to tune reasoning.')}
            onModel={(value) => (modelKey = value)}
            onLevel={(value) => (reasoning = value)}
            onFast={(value) => (fast = value)}
          >
            {#snippet trigger(props)}
              <button type="button" class="chip" {...props} aria-label={$t('Model')}>
                {#if modelsLoading || profileLoading}<Spinner size={12} />{:else}<Brain size={14} />{/if}
                <span>{model?.name ?? (modelKey ? (JSON.parse(modelKey) as [unknown, string])[1] : $t('Select model'))}</span>
                {#if reasoning}<span class="chip__sub">{reasoning}</span>{/if}
                {#if fast}<Zap size={12} />{/if}
              </button>
            {/snippet}
          </ModelPicker>
        {/if}
        <Picker items={permissionItems} value={permissionMode} label={$t('Permissions')} onSelect={(value) => (permissionMode = value)}>
          {#snippet trigger(props)}
            <button type="button" class="chip" {...props} aria-label={$t('Permissions')}>
              <ShieldCheck size={14} />
              <span>{permissionItems.find((item) => item.value === permissionMode)?.label}</span>
              <ChevronDown size={12} />
            </button>
          {/snippet}
        </Picker>
      </div>
      <label class="field">
        <span class="field__label">{$t('Instructions')}</span>
        <Textarea bind:value={instructions} minRows={4} maxRows={12} placeholder={$t('How it should work on a card. The card text arrives as its input.')} />
      </label>
    {:else}
      <div class="field">
        <span class="field__label" id="teammate-pipeline-label">{$t('Pipeline')}</span>
        <Picker
          items={commandItems}
          value={launchCommandId}
          label={$t('Pipeline')}
          searchPlaceholder={$t('Search pipelines')}
          emptyText={chatPipelines.loadingProjects.has(workspaceId) ? $t('Loading pipelines…') : $t('No saved pipelines yet')}
          onSelect={(value) => {
            launchCommandId = value;
            cardInput = '';
          }}
        >
          {#snippet trigger(props)}
            <button type="button" class="chip chip--wide" {...props} aria-labelledby="teammate-pipeline-label">
              <Route size={14} />
              <span>{commands.find((command) => command.id === launchCommandId)?.name ?? $t('Pick a saved pipeline')}</span>
              <ChevronDown size={12} />
            </button>
          {/snippet}
        </Picker>
        <button type="button" class="link" onclick={createPipeline}><Workflow size={13} />{$t('Create pipeline in editor')}</button>
      </div>
    {/if}
  {:else}
    <div class="grid">
      <div class="field field--wide">
        <span class="field__label">{$t('When a card is assigned')}</span>
        <Segmented
          value={onAssign}
          label={$t('When a card is assigned')}
          size="sm"
          options={[
            { value: 'ask', label: $t('Ask me') },
            { value: 'always', label: $t('Start at once') },
            { value: 'never', label: $t('Only assign') },
          ]}
          onValueChange={(value: TeammateStartRuleV1) => (onAssign = value)}
        />
        <span class="note">
          {onAssign === 'ask'
            ? $t('A start request waits in the Inbox.')
            : onAssign === 'always'
              ? $t('A run starts when the card is in To do, In progress or Blocked.')
              : $t('Nothing starts until you press Start run.')}
        </span>
      </div>
      <div class="field field--wide">
        <Checkbox label={$t('A @mention in a card comment wakes it')} description={$t('Follows the rule above.')} checked={onMention} onCheckedChange={(value) => (onMention = value)} />
      </div>
      <fieldset class="field field--wide permissions">
        <legend class="field__label">{$t('On the board, its runs may')}</legend>
        {#each PERMISSION_COPY as permission (permission.key)}
          <Checkbox label={$t(permission.label)} description={$t(permission.description)} checked={board[permission.key]} onCheckedChange={(value) => (board[permission.key] = value)} />
        {/each}
      </fieldset>
      <label class="field">
        <span class="field__label">{$t('Runs at the same time')}</span>
        <input class="number" type="number" min="1" max="8" value={maxConcurrentRuns} oninput={(event) => {
          const value = Number.parseInt(event.currentTarget.value, 10);
          if (Number.isFinite(value)) maxConcurrentRuns = Math.min(8, Math.max(1, value));
        }} />
      </label>
      {#if kind === 'pipeline'}
        <label class="field">
          <span class="field__label">{$t('Card text goes to')}</span>
          <select class="select" bind:value={cardInput}>
            <option value="">{$t('Automatic (card, message or the only text input)')}</option>
            {#each textInputs as input (input.name)}
              <option value={input.name}>{input.label} ({input.name})</option>
            {/each}
          </select>
        </label>
      {:else}
        <p class="note">{$t('The card text goes to its "card" input.')}</p>
      {/if}
      <div class="field field--wide">
        <Switch label={$t('Enabled')} checked={enabled} onCheckedChange={(value) => (enabled = value)} />
      </div>
    </div>
  {/if}

  {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={close} disabled={busy}>{$t('Cancel')}</Button>
    {#if step > 0}<Button onclick={() => (step -= 1)} disabled={busy}>{$t('Back')}</Button>{/if}
    {#if step < 2}
      <Button variant="primary" onclick={() => (step += 1)} disabled={!stepValid}>{$t('Next')}</Button>
    {:else}
      <Button variant="primary" onclick={() => void save()} loading={busy} disabled={!stepValid}>{teammate ? $t('Save teammate') : $t('Create teammate')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .steps {
    display: flex;
    gap: var(--piui-space-3);
    margin: 0 0 var(--piui-space-4);
    padding: 0;
    list-style: none;
  }
  .steps__item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-sm);
  }
  .steps__item--current {
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .steps__item--done {
    color: var(--piui-text-muted);
  }
  .steps__blade {
    width: 6px;
    height: 12px;
    background: var(--piui-border-strong);
    clip-path: polygon(40% 0, 100% 0, 60% 100%, 0 100%);
  }
  .steps__item--current .steps__blade {
    background: linear-gradient(180deg, var(--piui-chaos-gold), var(--piui-chaos));
    box-shadow: 0 0 8px var(--piui-chaos-glow);
  }
  .steps__item--done .steps__blade {
    background: var(--piui-chaos);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--piui-space-4);
  }
  .field {
    display: grid;
    align-content: start;
    gap: 4px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .field--wide {
    grid-column: 1 / -1;
  }
  .field__label {
    padding: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  .note {
    margin: 0;
    color: var(--piui-text-faint);
    font-size: var(--piui-text-xs);
  }
  .note--error,
  .error {
    color: var(--piui-danger);
  }
  .error {
    margin: var(--piui-space-3) 0 0;
  }
  .at {
    color: var(--piui-text-muted);
  }
  .swatches {
    display: flex;
    gap: 6px;
  }
  .swatch {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--piui-border);
    border-radius: 6px;
    background: var(--swatch);
    clip-path: polygon(14% 0, 100% 0, 86% 100%, 0 100%);
  }
  .swatch--current {
    outline: 2px solid var(--piui-text);
    outline-offset: 1px;
    clip-path: none;
  }
  .look {
    display: flex;
    gap: var(--piui-space-4);
    align-items: flex-start;
  }
  .look__preview {
    display: grid;
    justify-items: center;
    gap: 6px;
    flex: none;
    width: 84px;
    padding: var(--piui-space-3) 0;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .look__handle {
    max-width: 76px;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .look__options {
    display: grid;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }
  .emojis {
    display: grid;
    grid-template-columns: repeat(auto-fill, 32px);
    gap: 4px;
    /* 11 columns: the initials tile and 32 emoji fill three even rows. */
    max-width: calc(11 * 32px + 10 * 4px);
  }
  .look__options .field__label + .emojis,
  .look__options .field__label + .swatches {
    margin-bottom: 4px;
  }
  #teammate-avatar-label {
    margin-top: 6px;
  }
  .emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    font-size: 18px;
    line-height: 1;
    transition: background var(--piui-duration-fast), border-color var(--piui-duration-fast);
  }
  .emoji:hover {
    background: var(--piui-surface-2);
  }
  .emoji:focus-visible {
    outline: 2px solid var(--piui-focus, var(--piui-accent));
    outline-offset: 1px;
  }
  .emoji--initials {
    border-color: var(--piui-border);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  .emoji--current {
    border-color: var(--piui-chaos);
    background: color-mix(in srgb, var(--piui-chaos) 18%, transparent);
    box-shadow: 0 0 8px var(--piui-chaos-glow);
    color: var(--piui-text);
  }
  @media (max-width: 520px) {
    .look {
      flex-direction: column;
    }
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: var(--piui-space-3) 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 280px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip--wide {
    max-width: 100%;
    justify-self: start;
  }
  .chip__sub {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    justify-self: start;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
  }
  .permissions {
    gap: 6px;
  }
  .number,
  .select {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .number {
    width: 90px;
  }
  .select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
</style>
