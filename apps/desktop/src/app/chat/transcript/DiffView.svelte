<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileCode from '@lucide/svelte/icons/file-code';
  import { t } from '../../../features/locale/language';
  import { parseDiff, type DiffLine } from './diff';

  interface Props {
    text: string;
    /** Files longer than this start collapsed. */
    collapseAfter?: number;
    /** Review panel: actions shown in each hunk header (0-based hunk index). */
    hunkActions?: Snippet<[number]>;
    /** Review panel: a control in front of each changed or context line. */
    lineAction?: Snippet<[DiffLine, number]>;
  }
  let { text, collapseAfter = 80, hunkActions, lineAction }: Props = $props();
  const files = $derived(parseDiff(text));
  let collapsed = $state<Record<number, boolean>>({});

  function isCollapsed(index: number, lines: number): boolean {
    return collapsed[index] ?? lines > collapseAfter;
  }

  /** The 0-based hunk each line belongs to (-1 before the first hunk). */
  function hunkIndexes(lines: readonly DiffLine[]): number[] {
    let current = -1;
    return lines.map((line) => (line.kind === 'hunk' ? ++current : current));
  }
</script>

<div class="diff">
  {#each files as file, index (index)}
    {@const closed = isCollapsed(index, file.lines.length)}
    {@const hunks = hunkIndexes(file.lines)}
    <section class="file">
      <button type="button" class="file__head" aria-expanded={!closed} onclick={() => (collapsed = { ...collapsed, [index]: !closed })}>
        <span class="chevron" class:chevron--open={!closed}><ChevronRight size={12} /></span>
        <FileCode size={14} />
        <span class="file__path" title={file.path}>{file.path}</span>
        {#if file.change}<span class="file__change">{file.change}</span>{/if}
        <span class="file__stats">
          {#if file.added}<span class="add">+{file.added}</span>{/if}
          {#if file.removed}<span class="remove">−{file.removed}</span>{/if}
        </span>
      </button>
      {#if !closed}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable code region must be keyboard reachable.) -->
        <div class="file__body" tabindex="0" role="region" aria-label={$t('Changes in {0}', [file.path])}>
          <table>
            <tbody>
              {#each file.lines as line, lineIndex (lineIndex)}
                <tr class="line line--{line.kind}">
                  {#if lineAction}
                    <td class="act">{#if line.kind === 'add' || line.kind === 'remove' || line.kind === 'context'}{@render lineAction(line, hunks[lineIndex] ?? -1)}{/if}</td>
                  {/if}
                  <td class="num">{line.oldNumber ?? ''}</td>
                  <td class="num">{line.newNumber ?? ''}</td>
                  <td class="sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</td>
                  <td class="code">
                    {#if line.kind === 'hunk' && hunkActions}
                      <span class="hunk-head">
                        <span class="hunk-head__text">{line.text}</span>
                        <span class="hunk-head__actions">{@render hunkActions(hunks[lineIndex] ?? 0)}</span>
                      </span>
                    {:else}
                      {line.text}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  .diff {
    display: grid;
    gap: 6px;
  }
  .file {
    overflow: hidden;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
  }
  .file__head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 30px;
    padding: 0 10px 0 6px;
    border: 0;
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .file__head:hover {
    color: var(--piui-text);
  }
  .chevron {
    display: inline-flex;
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .chevron--open {
    transform: rotate(90deg);
  }
  .file__path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .file__change {
    padding: 0 5px;
    border-radius: var(--piui-radius-xs);
    background: var(--piui-surface-2);
    font-size: var(--piui-text-xs);
  }
  .file__stats {
    display: flex;
    gap: 6px;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .add {
    color: var(--piui-success);
  }
  .remove {
    color: var(--piui-danger);
  }
  .file__body {
    max-height: 420px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--piui-font-mono);
    font-size: var(--piui-chat-code-font-size);
    line-height: 1.5;
  }
  .num {
    width: 1%;
    padding: 0 6px;
    /* Line numbers are read (comments cite them): faint, not disabled. */
    color: var(--piui-text-faint);
    text-align: right;
    user-select: none;
    white-space: nowrap;
  }
  .sign {
    width: 1%;
    padding: 0 4px;
    color: var(--piui-text-disabled);
    user-select: none;
  }
  .code {
    padding-right: 12px;
    color: var(--piui-text);
    white-space: pre;
  }
  .line--add {
    background: var(--piui-diff-add);
  }
  .line--add .code,
  .line--add .sign {
    color: var(--piui-diff-add-text);
  }
  .line--remove {
    background: var(--piui-diff-remove);
  }
  .line--remove .code,
  .line--remove .sign {
    color: var(--piui-diff-remove-text);
  }
  .line--hunk {
    background: var(--piui-info-surface);
  }
  .line--hunk .code {
    color: var(--piui-info);
  }
  .line--meta .code {
    color: var(--piui-text-disabled);
  }
  .act {
    width: 1%;
    padding: 0 2px;
    vertical-align: middle;
  }
  .hunk-head {
    position: sticky;
    left: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    max-width: 100%;
  }
  .hunk-head__text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hunk-head__actions {
    display: inline-flex;
    gap: 2px;
    font-family: var(--piui-font-sans, inherit);
    white-space: nowrap;
  }
</style>
