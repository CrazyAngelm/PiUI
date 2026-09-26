<script lang="ts">
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import Plus from '@lucide/svelte/icons/plus';
  import Settings from '@lucide/svelte/icons/settings';
  import Search from '@lucide/svelte/icons/search';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Pin from '@lucide/svelte/icons/pin';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Inbox from '@lucide/svelte/icons/inbox';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import {
    Badge,
    Button,
    Checkbox,
    Dialog,
    EmptyState,
    Field,
    IconButton,
    Input,
    Kbd,
    Menu,
    Picker,
    Segmented,
    Skeleton,
    Spinner,
    StatusDot,
    Switch,
    Tabs,
    Textarea,
    Toaster,
    toasts,
    type PickerItem,
  } from '../lib/ui';

  let theme = $state<'dark' | 'light' | 'system'>('dark');
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  let text = $state('');
  let notes = $state('Multi-line text grows with content.');
  let enabled = $state(true);
  let agree = $state(false);
  let effort = $state<'low' | 'medium' | 'high' | 'xhigh'>('high');
  let tab = $state<'input' | 'output' | 'log'>('output');
  let dialogOpen = $state(false);
  let model = $state('gpt-6-astra');
  const models: PickerItem[] = [
    { value: 'gpt-6-astra', label: 'GPT-6 Astra', group: 'OpenAI', badges: ['fast'], description: 'Reasoning up to Ultra' },
    { value: 'gpt-6-sol', label: 'GPT-6 Sol', group: 'OpenAI', description: 'Balanced' },
    { value: 'gpt-5.5', label: 'GPT-5.5', group: 'OpenAI' },
    { value: 'claude-opus', label: 'Claude Opus', group: 'Anthropic', badges: ['vision'] },
    { value: 'claude-sonnet', label: 'Claude Sonnet', group: 'Anthropic' },
    { value: 'local-qwen', label: 'Qwen 3 Coder', group: 'Local', disabled: true, disabledReason: 'Provider not signed in' },
  ];
</script>

<TooltipPrimitive.Provider delayDuration={400}>
  <main class="gallery">
    <header>
      <h1>PiUI primitives</h1>
      <Segmented
        label="Theme"
        bind:value={theme}
        iconOnly
        options={[
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'light', label: 'Light', icon: Sun },
          { value: 'system', label: 'System', icon: Monitor },
        ]}
      />
    </header>

    <section>
      <h2>Buttons</h2>
      <div class="row">
        <Button variant="primary">Run pipeline</Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="subtle">Subtle</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="primary" loading>Saving</Button>
        <Button size="sm">
          {#snippet leading()}<Plus />{/snippet}
          New chat
        </Button>
        <Button size="lg" variant="primary">
          {#snippet leading()}<Plus />{/snippet}
          Large
        </Button>
      </div>
      <div class="row">
        <IconButton label="New chat" shortcut="Mod+N"><Plus /></IconButton>
        <IconButton label="Search" shortcut="Mod+K"><Search /></IconButton>
        <IconButton label="Settings" active><Settings /></IconButton>
        <IconButton label="Send" variant="primary"><Plus /></IconButton>
        <Kbd keys="Mod+Shift+M" />
      </div>
    </section>

    <section>
      <h2>Status</h2>
      <div class="row">
        <Badge>Codex</Badge>
        <Badge tone="accent">Running</Badge>
        <Badge tone="success">Succeeded</Badge>
        <Badge tone="warning">Needs approval</Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="info">Scheduled</Badge>
        <StatusDot status="running" label="Running" />
        <StatusDot status="done" label="Done" />
        <StatusDot status="waiting" label="Waiting" />
        <StatusDot status="failed" label="Failed" />
        <StatusDot status="idle" label="Idle" />
        <StatusDot status="offline" label="Offline" />
        <Spinner label="Loading" />
      </div>
    </section>

    <section>
      <h2>Inputs</h2>
      <div class="grid">
        <Field label="Pipeline name" for="name" description="Shown in the sidebar and run history.">
          <Input id="name" bind:value={text} placeholder="Code review" />
        </Field>
        <Field label="Search" for="search">
          <Input id="search" placeholder="Find node">
            {#snippet leading()}<Search />{/snippet}
          </Input>
        </Field>
        <Field label="Instructions" for="notes" error={notes.length === 0 ? 'Instructions are required.' : undefined}>
          <Textarea id="notes" bind:value={notes} minRows={3} />
        </Field>
        <div class="stack">
          <Switch bind:checked={enabled} label="Allow network access" />
          <Checkbox bind:checked={agree} label="Continue conversation between iterations" description="Keeps the native session and its context." />
          <Segmented
            label="Reasoning"
            bind:value={effort}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'XHigh' },
            ]}
          />
        </div>
      </div>
    </section>

    <section>
      <h2>Overlays</h2>
      <div class="row">
        <Picker items={models} value={model} label="Model" searchPlaceholder="Search models" onSelect={(value) => (model = value)}>
          {#snippet trigger(props)}
            <button {...props} class="chip">
              {models.find((item) => item.value === model)?.label}
              <ChevronDown size={14} />
            </button>
          {/snippet}
        </Picker>
        <Menu
          items={[
            { label: 'Rename', icon: Pencil, shortcut: 'F2', onSelect: () => toasts.success('Renamed') },
            { label: 'Pin', icon: Pin, onSelect: () => {} },
            { type: 'separator' },
            { label: 'Delete chat', icon: Trash, danger: true, onSelect: () => toasts.error('Could not delete', 'The session is still running.', { label: 'Retry', run: () => {} }) },
          ]}
        >
          {#snippet trigger(props)}
            <Button {...props}>Actions</Button>
          {/snippet}
        </Menu>
        <Button onclick={() => (dialogOpen = true)}>Open dialog</Button>
        <Button onclick={() => toasts.success('Pipeline saved', 'Revision 12')}>Toast</Button>
      </div>
      <Dialog bind:open={dialogOpen} title="Discard changes?" description="The draft pipeline has unsaved edits.">
        <p class="muted">You can keep editing or discard the draft. Saved versions are not affected.</p>
        {#snippet footer()}
          <Button variant="ghost" onclick={() => (dialogOpen = false)}>Keep editing</Button>
          <Button variant="danger" onclick={() => (dialogOpen = false)}>Discard</Button>
        {/snippet}
      </Dialog>
    </section>

    <section>
      <h2>Tabs</h2>
      <div class="panel">
        <Tabs
          label="Node details"
          bind:value={tab}
          tabs={[
            { value: 'input', label: 'Input' },
            { value: 'output', label: 'Output', count: 3 },
            { value: 'log', label: 'Log' },
          ]}
        >
          {#snippet panel(value)}
            <div class="tab-body">
              {#if value === 'output'}
                <Skeleton lines={3} />
              {:else}
                <p class="muted">{value} panel</p>
              {/if}
            </div>
          {/snippet}
        </Tabs>
      </div>
    </section>

    <section>
      <h2>Empty state</h2>
      <div class="panel">
        <EmptyState title="Nothing needs you" description="Approvals, questions from agents and failed runs appear here." icon={Inbox}>
          {#snippet actions()}
            <Button size="sm">Open runs</Button>
          {/snippet}
        </EmptyState>
      </div>
    </section>
  </main>
  <Toaster />
</TooltipPrimitive.Provider>

<style>
  .gallery {
    height: 100dvh;
    padding: var(--piui-space-8);
    overflow: auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--piui-space-6);
  }
  h1 {
    margin: 0;
    font-size: var(--piui-text-2xl);
    font-weight: var(--piui-weight-semibold);
  }
  h2 {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  section {
    margin-bottom: var(--piui-space-8);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-3);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--piui-space-6);
  }
  .stack {
    display: grid;
    align-content: start;
    gap: var(--piui-space-4);
  }
  .panel {
    max-width: 640px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .tab-body {
    padding: var(--piui-space-4);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-hover);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .chip:hover {
    background: var(--piui-pressed);
  }
</style>
