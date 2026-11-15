<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button } from '../../lib/ui';
  import Mark from './Mark.svelte';
  import { MARK_COLORS, MARK_SHAPES, marks, type Mark as MarkValue, type MarkColor, type MarkShape } from './marks.svelte';
  import { MARK_EMOJI, pickColor, pickShape, startingChoice } from './markPicker';
  import { roving } from './roving';

  interface Props {
    target: { kind: 'project' | 'session'; id: string };
    onClose: () => void;
  }
  let { target, onClose }: Props = $props();

  const current = $derived(target.kind === 'project' ? marks.project(target.id) : marks.session(target.id));
  const start = untrack(() => startingChoice(target.kind === 'project' ? marks.project(target.id) : marks.session(target.id)));
  let color = $state<MarkColor>(start.color);
  const shape = $derived(current?.kind === 'shape' ? current.shape : undefined);

  const colorNames: Record<MarkColor, string> = {
    red: 'Red',
    orange: 'Orange',
    yellow: 'Yellow',
    green: 'Green',
    teal: 'Teal',
    blue: 'Blue',
    purple: 'Purple',
    pink: 'Pink',
    gray: 'Gray',
  };
  const shapeNames: Record<MarkShape, string> = {
    circle: 'Circle',
    square: 'Square',
    diamond: 'Diamond',
    triangle: 'Triangle',
    star: 'Star',
    hexagon: 'Hexagon',
  };

  function apply(mark: MarkValue | undefined): void {
    if (target.kind === 'project') marks.setProject(target.id, mark);
    else marks.setSession(target.id, mark);
    onClose();
  }
  function chooseColor(value: MarkColor): void {
    const picked = pickColor(current, value);
    color = picked.color;
    if (picked.commit) apply(picked.commit);
  }
</script>

<div class="picker">
  <div class="row" role="radiogroup" aria-label={$t('Color')} {@attach roving(MARK_COLORS.length)}>
    {#each MARK_COLORS as value (value)}
      <button
        type="button"
        role="radio"
        aria-checked={color === value}
        aria-label={$t(colorNames[value])}
        class="swatch"
        style="--swatch: var(--piui-mark-{value})"
        onclick={() => chooseColor(value)}
      ></button>
    {/each}
  </div>
  <div class="row" role="radiogroup" aria-label={$t('Shape')} {@attach roving(MARK_SHAPES.length)}>
    {#each MARK_SHAPES as value (value)}
      <button type="button" role="radio" aria-checked={shape === value} aria-label={$t(shapeNames[value])} class="cell" onclick={() => apply(pickShape(color, value))}>
        <Mark mark={{ kind: 'shape', shape: value, color }} size={18} />
      </button>
    {/each}
  </div>
  <div class="grid" role="group" aria-label={$t('Emoji')} {@attach roving(8)}>
    {#each MARK_EMOJI as value (value)}
      <button type="button" class="cell" aria-label={value} aria-pressed={current?.kind === 'emoji' && current.value === value} onclick={() => apply({ kind: 'emoji', value })}>
        <Mark mark={{ kind: 'emoji', value }} size={18} />
      </button>
    {/each}
  </div>
  {#if current}
    <div class="remove"><Button variant="ghost" onclick={() => apply(undefined)}>{$t('Remove mark')}</Button></div>
  {/if}
</div>

<style>
  .picker {
    display: grid;
    gap: var(--piui-space-3);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-1);
  }
  .remove {
    display: flex;
    justify-content: flex-end;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
  }
  .swatch,
  .cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .swatch {
    width: 28px;
    height: 28px;
    border-radius: var(--piui-radius-full);
  }
  .swatch::before {
    content: '';
    width: 16px;
    height: 16px;
    border-radius: var(--piui-radius-full);
    background: var(--swatch);
  }
  .cell {
    height: 32px;
    border-radius: var(--piui-radius-sm);
  }
  .cell:hover,
  .swatch:hover {
    background: var(--piui-hover);
  }
  .swatch[aria-checked='true'],
  .cell[aria-checked='true'],
  .cell[aria-pressed='true'] {
    background: var(--piui-selected);
  }
  .row .cell {
    width: 32px;
  }
  .swatch:focus-visible,
  .cell:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
