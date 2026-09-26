<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button, Textarea } from '../../lib/ui';
  import type { LineRef } from './review';

  interface Props {
    path: string;
    /** Lines of the hunk the comment is about. */
    lines: readonly LineRef[];
    /** The line the person clicked, if any. */
    initial: LineRef | undefined;
    onAdd: (line: LineRef, note: string) => void;
    onCancel: () => void;
  }
  let { path, lines, initial, onAdd, onCancel }: Props = $props();

  const key = (line: LineRef) => `${line.removed ? 'old' : 'new'}:${line.number}`;
  function firstChanged(): LineRef | undefined {
    return lines.find((line) => line.changed) ?? lines[0];
  }
  let selected = $state(untrack(() => key(initial ?? firstChanged() ?? { number: 0, removed: false, changed: false, text: '' })));
  let note = $state('');
  let input = $state<HTMLTextAreaElement | null>(null);
  const line = $derived(lines.find((candidate) => key(candidate) === selected));
  const id = `comment-${Math.random().toString(36).slice(2, 8)}`;

  $effect(() => {
    queueMicrotask(() => input?.focus());
  });

  function submit(): void {
    if (line) onAdd(line, note);
  }
</script>

<form
  class="comment"
  aria-label={$t('Comment for the agent on {0}', [path])}
  onsubmit={(event) => {
    event.preventDefault();
    submit();
  }}
>
  <label class="comment__label" for="{id}-line">{$t('Line')}</label>
  <select id="{id}-line" class="comment__select" bind:value={selected}>
    {#each lines as candidate (key(candidate))}
      <option value={key(candidate)}>
        {candidate.removed ? $t('removed {0}', [candidate.number]) : candidate.number}: {candidate.text.trim().slice(0, 80) || $t('(empty line)')}
      </option>
    {/each}
  </select>
  <label class="comment__label" for="{id}-note">{$t('Note for the agent')}</label>
  <Textarea
    id="{id}-note"
    bind:ref={input}
    bind:value={note}
    minRows={2}
    maxRows={8}
    placeholder={$t('What should the agent do about this line?')}
    onkeydown={(event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    }}
  />
  <p class="comment__hint">{$t('The line and your note go into the message box. Nothing is sent until you send it.')}</p>
  <div class="comment__actions">
    <Button size="sm" variant="ghost" onclick={onCancel}>{$t('Cancel')}</Button>
    <Button size="sm" variant="primary" type="submit" disabled={!line}>{$t('Add to message')}</Button>
  </div>
</form>

<style>
  .comment {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    min-width: 0;
    margin-top: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
  }
  .comment__label {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  .comment__select {
    width: 100%;
    min-width: 0;
    height: var(--piui-control-sm, 28px);
    padding: 0 6px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .comment__select option {
    background: var(--piui-bg-raised);
    color: var(--piui-text);
  }
  .comment__hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .comment__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--piui-space-2);
  }
</style>
