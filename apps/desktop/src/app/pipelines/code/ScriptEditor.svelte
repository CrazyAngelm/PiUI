<script lang="ts">
  import { untrack } from 'svelte';
  import type { ScriptRuntime } from '../../../host-api/orchestrationClient';
  import { Textarea } from '../../../lib/ui';
  import type { CodeEditorHandle, CodeEditorSize } from './codeMirror';

  /**
   * Script code with syntax highlighting. CodeMirror is loaded on demand
   * (`./codeMirror`, never in the main bundle); until then, and whenever it
   * cannot load, a plain text field (or text block) keeps the code usable.
   */
  interface Props {
    id: string;
    value: string;
    runtime: ScriptRuntime;
    /** Accessible name of the code field. */
    label: string;
    /** `view` shows recorded code read-only, e.g. in a run. */
    size?: CodeEditorSize;
    readOnly?: boolean;
    /** Keyboard help shown under the editor and read by screen readers. */
    keyboardHint?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
    onBlur?: () => void;
  }
  let {
    id,
    value,
    runtime,
    label,
    size = 'editor',
    readOnly = false,
    keyboardHint = undefined,
    placeholder = undefined,
    onChange = undefined,
    onBlur = undefined,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let fallback = $state<HTMLTextAreaElement | null>(null);
  let handle = $state.raw<CodeEditorHandle | undefined>();
  let failed = $state(false);
  let shownRuntime: ScriptRuntime | undefined;

  $effect(() => {
    const element = host;
    if (element === null) return;
    let cancelled = false;
    let mounted: CodeEditorHandle | undefined;
    const options = untrack(() => ({
      value,
      runtime,
      label,
      size,
      readOnly,
      description: keyboardHint,
      placeholder,
      onChange: (next: string) => onChange?.(next),
      onBlur: () => onBlur?.(),
    }));
    import('./codeMirror')
      .then((module) => module.mountCodeEditor(element, options))
      .then((editor) => {
        if (cancelled) {
          editor.destroy();
          return;
        }
        mounted = editor;
        shownRuntime = options.runtime;
        const focused = fallback !== null && document.activeElement === fallback;
        handle = editor;
        if (focused) editor.focus();
      })
      .catch(() => {
        // The plain field stays; the code remains editable without highlighting.
        if (!cancelled) failed = true;
      });
    return () => {
      cancelled = true;
      mounted?.destroy();
      handle = undefined;
    };
  });

  $effect(() => {
    handle?.setValue(value);
  });
  $effect(() => {
    const next = runtime;
    if (handle === undefined || next === shownRuntime) return;
    shownRuntime = next;
    void handle.setRuntime(next);
  });
  $effect(() => {
    handle?.setReadOnly(readOnly);
  });
  // The accessible name, keyboard help and placeholder follow the UI language.
  $effect(() => {
    handle?.setLabels({ label, description: keyboardHint, placeholder });
  });
</script>

<div class="script-editor">
  {#if handle === undefined}
    {#if size === 'viewer'}
      <pre class="plain">{value}</pre>
    {:else}
      <Textarea
        {id}
        bind:ref={fallback}
        class="plain-code"
        {value}
        minRows={10}
        maxRows={28}
        spellcheck={false}
        wrap="off"
        readonly={readOnly}
        aria-label={label}
        {placeholder}
        oninput={(event) => onChange?.(event.currentTarget.value)}
        onblur={() => onBlur?.()}
      />
    {/if}
  {/if}
  {#if !failed}
    <div class="host" bind:this={host} hidden={handle === undefined}></div>
  {/if}
  {#if handle !== undefined && keyboardHint && !readOnly}
    <p class="hint">{keyboardHint}</p>
  {/if}
</div>

<style>
  .script-editor {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .host {
    display: block;
    min-width: 0;
  }
  .host[hidden] {
    display: none;
  }
  .script-editor :global(textarea.plain-code) {
    font-family: var(--piui-font-mono);
    font-size: 12px;
    tab-size: 2;
    background: var(--piui-code-surface);
  }
  .plain {
    max-height: 440px;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    font-family: var(--piui-font-mono);
    font-size: 12px;
    white-space: pre;
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
</style>
