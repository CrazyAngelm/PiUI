<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Copy from '@lucide/svelte/icons/copy';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Code from '@lucide/svelte/icons/code';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { ScriptRuntime, StepExecutor } from '../../host-api/orchestrationClient';
  import {
    MAX_SCRIPT_SOURCE_BYTES,
    MAX_SCRIPT_TIMEOUT_SECONDS,
    MIN_SCRIPT_TIMEOUT_SECONDS,
    SCRIPT_RUNTIMES,
    scriptTimeoutValid,
  } from '../../host-api/stepExecutors';
  import { RUNTIME_LABEL, SCRIPT_EXAMPLES, sourceBytes } from './executors';
  import { t } from '../../features/locale/language';
  import { harnessConfiguration, permissionLabels, profileHarnesses } from '../../harness-adapters';
  import { profileForHarness } from '../../harness-adapters/normalize';
  import type { AgentProfile } from '../../host-api/orchestrationClient';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import ResourcePicker from '../../features/orchestration/ResourcePicker.svelte';
  import ResultFields from '../../features/orchestration/ResultFields.svelte';
  import FlowSettings from '../../features/orchestration/FlowSettings.svelte';
  import RouterSettings from '../../features/orchestration/RouterSettings.svelte';
  import { Checkbox, Field, IconButton, Input, Menu, Picker, Segmented, Switch, Tabs, Textarea, toasts, type PickerItem } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { useWorkspace } from '../shell/context';
  import type { PipelineEditorStore } from './editorStore.svelte';
  import NodeTypeMenu from './NodeTypeMenu.svelte';
  import ScriptEditor from './code/ScriptEditor.svelte';
  import ScriptTestPanel from './ScriptTestPanel.svelte';
  import HarnessLimitations from './HarnessLimitations.svelte';
  import PinnedDataSection from './PinnedDataSection.svelte';
  import Blocks from '@lucide/svelte/icons/blocks';
  import PluginNodeSettings from '../plugins/PluginNodeSettings.svelte';

  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
    onClose: () => void;
    onFocusNode: (id: string) => void;
  }
  let { editor, node, onClose, onFocusNode }: Props = $props();
  const workspace = useWorkspace();

  type TabId = 'basics' | 'io' | 'access' | 'flow' | 'routes' | 'script' | 'plugin';
  let tab = $state<TabId>('basics');
  const isRouter = $derived(node.kind === 'router');
  // v6.2 executors: a script runs on the host; a model call is one read-only turn.
  const script = $derived(node.executor?.type === 'script' ? node.executor : undefined);
  const llm = $derived(node.executor?.type === 'llm');
  // v6.5: a plugin node's backend runs it; its form comes from the node type.
  const plugin = $derived(node.executor?.type === 'plugin');
  const scriptBytes = $derived(script ? sourceBytes(script.source) : 0);
  let timeoutText = $state('');
  $effect(() => {
    timeoutText = script ? String(script.timeoutSeconds) : '';
  });
  const agentRouter = $derived(isRouter && node.router?.mode === 'agent');
  const profile = $derived(node.profile);
  const configuration = $derived(harnessConfiguration(profile.harness));
  const catalog = $derived(editor.catalogs[profile.harness]);
  const catalogError = $derived(editor.catalogErrors[profile.harness]);
  const models = $derived(catalog?.models ?? []);
  const model = $derived(models.find((item) => item.id === profile.model && item.provider === profile.modelProvider) ?? models.find((item) => item.id === profile.model));
  const levels = $derived(model?.thinkingLevels ?? []);
  const problems = $derived(editor.nodeProblems(node.id));
  const readOnly = $derived(editor.readOnly);
  const others = $derived(editor.graph.nodes.filter((item) => item.id !== node.id && item.kind !== 'router'));

  // Load the native catalog of the selected harness when the agent is shown.
  $effect(() => {
    if ((!isRouter || agentRouter) && !script && !plugin && !editor.catalogs[profile.harness] && !editor.catalogErrors[profile.harness]) {
      void editor.loadCatalog(profile.harness);
    }
  });

  $effect(() => {
    if (isRouter && tab !== 'routes' && tab !== 'basics') tab = 'routes';
    else if (plugin && tab !== 'plugin' && tab !== 'io' && tab !== 'flow') tab = 'plugin';
    else if (!plugin && tab === 'plugin') tab = 'basics';
    else if (script && tab !== 'script' && tab !== 'io' && tab !== 'flow') tab = 'script';
    else if (!script && tab === 'script') tab = 'basics';
    else if (llm && tab === 'access') tab = 'basics';
  });

  const tabs = $derived(
    isRouter
      ? [
          { value: 'routes' as const, label: $t('Routes') },
          { value: 'basics' as const, label: $t('Agent') },
        ]
      : plugin
        ? [
            { value: 'plugin' as const, label: $t('Plugin node') },
            { value: 'io' as const, label: $t('Output') },
            { value: 'flow' as const, label: $t('Flow') },
          ]
      : script
        ? [
            { value: 'script' as const, label: $t('Script') },
            { value: 'io' as const, label: $t('Output') },
            { value: 'flow' as const, label: $t('Flow') },
          ]
      : llm
        ? [
            { value: 'basics' as const, label: $t('Basics') },
            { value: 'io' as const, label: $t('Input & output') },
            { value: 'flow' as const, label: $t('Flow') },
          ]
      : [
          { value: 'basics' as const, label: $t('Basics') },
          { value: 'io' as const, label: $t('Input & output') },
          { value: 'access' as const, label: $t('Access') },
          { value: 'flow' as const, label: $t('Flow') },
        ],
  );

  const harnessItems = $derived<PickerItem[]>(
    profileHarnesses(workspace.catalog.harnesses).map((kind) => {
      const status = workspace.catalog.harnesses.find((item) => item.kind === kind);
      const oneShotMissing = llm && !harnessConfiguration(kind).oneShot;
      return {
        value: kind,
        label: status?.name ?? harnessConfiguration(kind).name,
        description: status?.status === 'available' ? (status.version ? `v${status.version}` : $t('Ready')) : status?.reason ?? $t('Not found on this computer'),
        ...(oneShotMissing ? { disabled: true, disabledReason: $t('Cannot answer read-only without tools') } : {}),
      };
    }),
  );
  const modelItems = $derived<PickerItem[]>(
    models.map((item) => ({
      value: JSON.stringify([item.provider ?? '', item.id]),
      label: item.name,
      description: item.id,
      group: item.provider ?? $t('Models'),
      badges: [...(item.thinkingLevels?.length ? [$t('reasoning')] : []), ...(item.supportsFast ? [$t('fast')] : [])],
    })),
  );
  const permissionItems = $derived<PickerItem<AgentProfile['permissionMode']>[]>(
    configuration.permissionModes.map((mode) => ({ value: mode, label: $t(permissionLabels[mode]) })),
  );

  function patch(change: Partial<AgentProfile>, live = false): void {
    editor.updateProfile(node.id, change, live);
  }

  function setHarness(harness: AgentProfile['harness']): void {
    if (harness === profile.harness) return;
    const next = profileForHarness(profile, harness);
    // Explicit undefined clears settings the new harness cannot honour.
    patch({
      ...next,
      modelProvider: next.modelProvider,
      reasoning: next.reasoning,
      serviceTier: next.serviceTier,
      resourceRules: next.resourceRules,
      baseInstructions: next.baseInstructions,
      networkAccess: next.networkAccess,
      // A model call stays read-only, offline and without tools.
      ...(llm ? { permissionMode: 'read-only' as const, networkAccess: undefined, resourceRules: undefined, toolPolicy: { rules: [] } } : {}),
    });
  }

  function setScript(change: Partial<Extract<StepExecutor, { type: 'script' }>>, live = false): void {
    if (script) editor.updateNode(node.id, { executor: { ...script, ...change } }, live);
  }

  function setTimeoutText(value: string): void {
    timeoutText = value;
    const seconds = Number(value.trim());
    if (value.trim() !== '' && scriptTimeoutValid(seconds)) setScript({ timeoutSeconds: seconds }, true);
  }

  function setModel(value: string): void {
    const [provider, id] = JSON.parse(value) as [string, string];
    const next = models.find((item) => item.id === id && (item.provider ?? '') === provider);
    patch({
      model: id,
      modelProvider: provider || undefined,
      reasoning: next?.thinkingLevels?.includes(profile.reasoning ?? '') ? profile.reasoning : undefined,
      serviceTier: configuration.speed ? (next?.supportsFast ? profile.serviceTier : 'standard') : undefined,
    });
  }

  function toggleSpawn(target: string): void {
    const error = editor.toggleEdge(node.id, target, 'spawn');
    if (error) toasts.error($t('Cannot change delegation'), $t(error));
  }
</script>

<aside class="inspector" aria-label={$t('Node settings')}>
  <header>
    {#if isRouter}
      <span class="router-mark" aria-hidden="true">⑂</span>
    {:else if script}
      <span class="router-mark" aria-hidden="true"><Code size={14} /></span>
    {:else if plugin}
      <span class="router-mark" aria-hidden="true"><Blocks size={14} /></span>
    {:else}
      <HarnessMark kind={profile.harness} size={22} />
    {/if}
    <input
      class="name"
      value={profile.name}
      aria-label={$t('Name')}
      placeholder={isRouter ? $t('Router') : script ? $t('Script name') : llm ? $t('Model call name') : $t('Agent name')}
      disabled={readOnly}
      oninput={(event) => patch({ name: event.currentTarget.value }, true)}
      onblur={() => editor.settle()}
    />
    {#if !isRouter}
      <NodeTypeMenu {editor} {node} />
    {/if}
    <Menu
      align="end"
      items={[
        { label: $t('Duplicate'), icon: Copy, disabled: readOnly, onSelect: () => editor.duplicate(node.id, $t('Copy of {0}', [profile.name])) },
        { type: 'separator' },
        { label: $t('Delete'), icon: Trash, danger: true, disabled: readOnly, onSelect: () => editor.removeSelection([node.id], []) },
      ]}
    >
      {#snippet trigger(props)}
        <IconButton label={$t('Node actions')} tooltip={false} size="sm" {...props}><Ellipsis /></IconButton>
      {/snippet}
    </Menu>
    <IconButton label={$t('Close')} size="sm" onclick={onClose}><X /></IconButton>
  </header>

  {#if problems.length}
    <ul class="problems" role="list">
      {#each problems as problem (problem)}
        <li><CircleAlert size={13} /> {editor.describeIssue(problem, (value) => $t(value))}</li>
      {/each}
    </ul>
  {/if}
  <PinnedDataSection {editor} {node} />

  <Tabs label={$t('Node settings')} bind:value={tab} {tabs}>
    {#snippet panel(current)}
      <div class="body">
        {#if current === 'routes' && node.router}
          <RouterSettings
            {node}
            nodes={editor.graph.nodes}
            disabled={readOnly}
            onchange={(change) => editor.updateNode(node.id, change)}
            onselectinput={onFocusNode}
          />
        {:else if current === 'plugin' && plugin}
          <PluginNodeSettings {editor} {node} />
        {:else if current === 'script' && script}
          <p class="warning" role="note">
            <TriangleAlert size={14} />
            <span>{$t('Runs on this computer in the project folder with your permissions. It is not a sandbox: review the code before running it.')}</span>
          </p>
          <Field label={$t('Runtime')}>
            <Segmented
              size="sm"
              label={$t('Runtime')}
              value={script.runtime}
              options={SCRIPT_RUNTIMES.map((runtime) => ({ value: runtime, label: RUNTIME_LABEL[runtime] }))}
              onValueChange={(value) => setScript({ runtime: value as ScriptRuntime })}
            />
          </Field>
          <Field
            label={$t('Code')}
            for="node-script"
            error={scriptBytes > MAX_SCRIPT_SOURCE_BYTES ? $t('A script needs source code of at most 64 KiB.') : undefined}
            description={$t('{0} of {1} KiB', [(scriptBytes / 1024).toFixed(1), MAX_SCRIPT_SOURCE_BYTES / 1024])}
          >
            {#snippet action()}
              {#if !script.source.trim() && !readOnly}
                <button type="button" class="link" onclick={() => setScript({ source: SCRIPT_EXAMPLES[script.runtime] })}>{$t('Insert example')}</button>
              {/if}
            {/snippet}
            <ScriptEditor
              id="node-script"
              value={script.source}
              runtime={script.runtime}
              label={$t('Code')}
              readOnly={readOnly}
              keyboardHint={$t('Tab indents. Press Esc, then Tab, to move focus out of the code.')}
              placeholder={$t('Read JSON from stdin, print the result to stdout.')}
              onChange={(source) => setScript({ source }, true)}
              onBlur={() => editor.settle()}
            />
          </Field>
          <Field
            label={$t('Time limit, seconds')}
            for="node-timeout"
            error={timeoutText.trim() !== '' && !scriptTimeoutValid(Number(timeoutText.trim())) ? $t('A script timeout must be a whole number of seconds from 1 to 3600.') : undefined}
            description={$t('From {0} to {1}. The whole process tree is stopped when it runs out.', [MIN_SCRIPT_TIMEOUT_SECONDS, MAX_SCRIPT_TIMEOUT_SECONDS])}
          >
            <Input id="node-timeout" inputmode="numeric" value={timeoutText} disabled={readOnly} oninput={(event) => setTimeoutText(event.currentTarget.value)} onblur={() => editor.settle()} />
          </Field>
          <details class="help">
            <summary>{$t('How a script gets and returns data')}</summary>
            <p>{$t('It reads one JSON document on stdin: the run inputs, the result of every step it depends on and its own step.')}</p>
            <pre>{'{ "inputs": {…}, "dependencies": { "<step id>": { "text": "…", "data": {…} } }, "step": { "id": "…", "name": "…" } }'}</pre>
            <p>{$t('Print one JSON object to return named fields, or any text. A non-zero exit code fails the step; the end of stderr is shown in the run.')}</p>
          </details>
          <ScriptTestPanel {editor} {node} />
        {:else if current === 'basics'}
          {#if !isRouter || agentRouter}
            <Field
              label={$t('Harness')}
              description={llm ? $t('Answers once inside this installed tool, read-only and without tools.') : $t('The agent runs inside this installed tool with its own sign-in.')}
            >
              <Picker items={harnessItems} value={profile.harness} label={$t('Harness')} searchPlaceholder={$t('Search harnesses')} width={300} onSelect={(value) => setHarness(value as AgentProfile['harness'])}>
                {#snippet trigger(props)}
                  <button type="button" class="select" {...props} disabled={readOnly}>
                    <HarnessMark kind={profile.harness} size={16} />
                    <span>{harnessItems.find((item) => item.value === profile.harness)?.label ?? configuration.name}</span>
                    <ChevronDown size={13} />
                  </button>
                {/snippet}
              </Picker>
            </Field>
            <HarnessLimitations harness={profile.harness} />
            <Field label={$t('Model')} error={catalogError}>
              {#snippet action()}
                <IconButton size="sm" label={$t('Refresh models')} onclick={() => void editor.loadCatalog(profile.harness, true)}><RefreshCw /></IconButton>
              {/snippet}
              <Picker
                items={modelItems}
                value={JSON.stringify([profile.modelProvider ?? model?.provider ?? '', profile.model])}
                label={$t('Model')}
                searchPlaceholder={$t('Search models')}
                emptyText={catalog ? $t('No models found') : $t('Loading models…')}
                width={340}
                onSelect={setModel}
              >
                {#snippet trigger(props)}
                  <button type="button" class="select" {...props} disabled={readOnly}>
                    <span class:placeholder={!profile.model}>{model?.name ?? (profile.model || $t('Choose a model'))}</span>
                    <ChevronDown size={13} />
                  </button>
                {/snippet}
              </Picker>
            </Field>
            {#if levels.length}
              <Field label={$t('Reasoning')}>
                <Segmented
                  size="sm"
                  label={$t('Reasoning')}
                  value={profile.reasoning ?? '__default'}
                  options={[{ value: '__default', label: $t('Default') }, ...levels.map((level) => ({ value: level, label: level }))]}
                  onValueChange={(value) => patch({ reasoning: value === '__default' ? undefined : value })}
                />
              </Field>
            {/if}
            {#if model?.supportsFast && configuration.speed}
              <Switch label={$t('Fast mode')} checked={profile.serviceTier === 'fast'} disabled={readOnly} onCheckedChange={(checked) => patch({ serviceTier: checked ? 'fast' : 'standard' })} />
            {/if}
            {#if llm}
              <p class="hint" class:hint--warning={!configuration.oneShot}>
                {configuration.oneShot ? $t(configuration.oneShot.note) : $t('This harness cannot run a model call read-only. Choose Pi, Codex or Claude Code.')}
              </p>
            {/if}
          {/if}
          {#if !isRouter}
            <Field
              label={llm ? $t('Prompt') : $t('Task')}
              for="node-task"
              description={llm ? $t('What to ask the model. Results of earlier steps are attached automatically.') : $t('What this agent does in this pipeline. Upstream results are attached automatically.')}
            >
              <Textarea
                id="node-task"
                value={node.task}
                minRows={4}
                maxRows={16}
                disabled={readOnly}
                placeholder={$t('Describe the goal, expected result and constraints…')}
                oninput={(event) => editor.updateNode(node.id, { task: event.currentTarget.value }, true)}
                onblur={() => editor.settle()}
              />
            </Field>
            <Field label={$t('Role instructions')} for="node-role" description={$t('Reusable behaviour: how the agent works, what to check, how to report.')}>
              <Textarea
                id="node-role"
                value={profile.instructions}
                minRows={3}
                maxRows={14}
                disabled={readOnly}
                oninput={(event) => patch({ instructions: event.currentTarget.value }, true)}
                onblur={() => editor.settle()}
              />
            </Field>
          {/if}
        {:else if current === 'io' && (script || plugin)}
          <div class="section">
            <h3>{$t('Structured result fields')}</h3>
            <p class="hint">{plugin ? $t('Named fields the node returns as one JSON object. Without fields, its output is passed on as text.') : $t('Named fields the script prints as one JSON object. Without fields, its output is passed on as text.')}</p>
            <ResultFields fields={node.resultFields ?? []} disabled={readOnly} onchange={(fields) => editor.updateNode(node.id, { resultFields: fields.length ? fields : undefined })} />
          </div>
        {:else if current === 'io'}
          <Field label={$t('Expected input')} for="node-input" description={$t('What this agent needs from upstream agents. Senders are told about it.')}>
            <Textarea
              id="node-input"
              value={node.input ?? ''}
              minRows={2}
              maxRows={10}
              disabled={readOnly}
              oninput={(event) => editor.updateNode(node.id, { input: event.currentTarget.value || undefined }, true)}
              onblur={() => editor.settle()}
            />
          </Field>
          <Field label={$t('Expected result')} for="node-result" description={$t('What a good result looks like. Added to the agent’s task.')}>
            <Textarea
              id="node-result"
              value={profile.expectedResult ?? ''}
              minRows={2}
              maxRows={10}
              disabled={readOnly}
              oninput={(event) => patch({ expectedResult: event.currentTarget.value || undefined }, true)}
              onblur={() => editor.settle()}
            />
          </Field>
          <div class="section">
            <h3>{$t('Structured result fields')}</h3>
            <p class="hint">{$t('Named fields let routers, conditions and reviews read the result precisely.')}</p>
            <ResultFields fields={node.resultFields ?? []} disabled={readOnly} onchange={(fields) => editor.updateNode(node.id, { resultFields: fields.length ? fields : undefined })} />
          </div>
        {:else if current === 'access'}
          <Field label={$t('Permissions')} description={configuration.filesystemSandbox ? $t('Enforced by the harness sandbox.') : $t('This harness has no file sandbox; the mode is advisory.')}>
            <Picker items={permissionItems} value={profile.permissionMode} label={$t('Permissions')} width={300} onSelect={(value) => patch({ permissionMode: value })}>
              {#snippet trigger(props)}
                <button type="button" class="select" {...props} disabled={readOnly}>
                  <span>{$t(permissionLabels[profile.permissionMode])}</span>
                  <ChevronDown size={13} />
                </button>
              {/snippet}
            </Picker>
          </Field>
          {#if configuration.networkAccess && (profile.permissionMode === 'read-only' || profile.permissionMode === 'workspace-write')}
            <Switch label={$t('Allow network access')} checked={profile.networkAccess === true} disabled={readOnly} onCheckedChange={(checked) => patch({ networkAccess: checked || undefined })} />
          {/if}
          <div class="section">
            <h3>{$t('Skills, MCP and tools')}</h3>
            <ResourcePicker {profile} items={catalog?.resources.items ?? []} loading={!catalog && !catalogError} disabled={readOnly} onchange={(change) => patch(change)} />
          </div>
          <div class="section">
            <h3>{$t('May start instances of')}</h3>
            <p class="hint">{$t('Lets this agent create helpers of these roles at run time, with the same or fewer permissions.')}</p>
            {#if others.length === 0}
              <p class="hint">{$t('Add another agent to delegate work to it.')}</p>
            {:else}
              <div class="checks">
                {#each others as other (other.id)}
                  <Checkbox
                    label={other.profile.name || $t('Untitled agent')}
                    checked={editor.hasEdge(node.id, other.id, 'spawn')}
                    disabled={readOnly}
                    onCheckedChange={() => toggleSpawn(other.id)}
                  />
                {/each}
              </div>
            {/if}
          </div>
        {:else if current === 'flow'}
          {#if !script && !llm}
          <Field label={$t('When it runs')}>
            <Segmented
              size="sm"
              label={$t('When it runs')}
              value={node.executionMode ?? 'scheduled'}
              options={[
                { value: 'scheduled', label: $t('In order'), title: $t('Runs when its inputs are ready') },
                { value: 'callable', label: $t('On call'), title: $t('Runs only when another agent starts it') },
              ]}
              onValueChange={(value) => editor.updateNode(node.id, { executionMode: value === 'callable' ? 'callable' : undefined })}
            />
          </Field>
          {/if}
          {#if node.executionMode === 'callable' && !script && !llm}
            <Field label={$t('When to call')} for="node-when" description={$t('Shown to agents that may start this one.')}>
              <Textarea
                id="node-when"
                value={profile.whenToCall ?? ''}
                minRows={2}
                maxRows={8}
                disabled={readOnly}
                oninput={(event) => patch({ whenToCall: event.currentTarget.value || undefined }, true)}
                onblur={() => editor.settle()}
              />
            </Field>
          {/if}
          <Switch
            label={$t('A person approves the result')}
            checked={node.requireApproval === true}
            disabled={readOnly}
            onCheckedChange={(checked) => editor.updateNode(node.id, { requireApproval: checked || undefined })}
          />
          <div class="section">
            <FlowSettings {node} nodes={editor.graph.nodes} edges={editor.graph.edges} disabled={readOnly} onchange={(change) => editor.updateNode(node.id, change)} />
          </div>
        {/if}
      </div>
    {/snippet}
  </Tabs>
</aside>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    width: 380px;
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-2) 0 var(--piui-space-3);
    flex: none;
  }
  .warning {
    display: flex;
    gap: 8px;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--piui-warning-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-warning-surface);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    line-height: 1.45;
  }
  .warning :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--piui-warning);
  }
  .hint--warning {
    color: var(--piui-warning);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .help {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .help summary {
    cursor: pointer;
  }
  .help p {
    margin: 6px 0;
  }
  .help pre {
    margin: 0;
    padding: 8px;
    overflow-x: auto;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    font-family: var(--piui-font-mono);
    font-size: 11px;
    white-space: pre-wrap;
  }
  .router-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--piui-accent) 16%, transparent);
    color: var(--piui-accent);
  }
  .name {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .name:hover {
    border-color: var(--piui-border-subtle);
  }
  .name:focus-visible {
    border-color: var(--piui-focus);
    outline: none;
  }
  .problems {
    display: grid;
    gap: 4px;
    margin: 0 var(--piui-space-3) var(--piui-space-2);
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    font-size: var(--piui-text-sm);
    list-style: none;
  }
  .problems li {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .inspector :global(.piui-tabs) {
    flex: 1;
    min-height: 0;
  }
  .inspector :global(.piui-tabs__bar) {
    padding: 0 var(--piui-space-3);
  }
  .inspector :global(.piui-tabs__panel) {
    flex: 1;
    overflow-y: auto;
  }
  .body {
    display: grid;
    gap: var(--piui-space-4);
    padding: var(--piui-space-4) var(--piui-space-4) var(--piui-space-8);
  }
  .select {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--piui-control-md);
    padding: 0 10px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    text-align: left;
  }
  .select span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .select:hover:not(:disabled) {
    border-color: var(--piui-border-strong);
  }
  .placeholder {
    color: var(--piui-text-disabled);
  }
  .section {
    display: grid;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .section h3 {
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .checks {
    display: grid;
    gap: var(--piui-space-2);
  }
</style>
