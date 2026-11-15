<script lang="ts">
  import Pencil from '@lucide/svelte/icons/pencil';
  import { t } from '../../../features/locale/language';
  import { IconButton } from '../../../lib/ui';
  import { macroText, type SkillSyntax } from '../../macros/expand';
  import type { Macro, MacroToken } from '../../macros/macro';

  /**
   * Marks the `//name` macros of a composer and shows what one adds while the
   * pointer rests on it (ADR-060). The editor stays the owner's textarea: this
   * layer mirrors its text in an inert box of the same geometry, so the marks
   * sit on the words, and it never holds or changes the text. It must be the
   * textarea's sibling inside a `position: relative` box that hugs the textarea.
   */
  interface Props {
    input: HTMLTextAreaElement | null;
    text: string;
    tokens: readonly MacroToken[];
    /** How this chat's agent is told to use a skill: the card shows what a macro adds for it. */
    syntax: SkillSyntax;
    /** No card, e.g. while a mention menu is open. */
    quiet?: boolean;
    onEdit?: (macro: Macro) => void;
  }
  let { input, text, tokens, syntax, quiet = false, onEdit }: Props = $props();

  /** Everything that decides where the editor breaks its lines. */
  const MIRRORED = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-stretch',
    'font-kerning',
    'font-variant-ligatures',
    'font-feature-settings',
    'letter-spacing',
    'word-spacing',
    'line-height',
    'text-indent',
    'text-transform',
    'text-align',
    'tab-size',
    'direction',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'overflow-y',
    'scrollbar-width',
    'scrollbar-gutter',
  ] as const;
  const CLOSE_DELAY_MS = 200;
  /** Keys that move the caret without changing the text. */
  const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

  let mirror = $state<HTMLDivElement | null>(null);
  /** The macro under the pointer; `x` and `y` are its token's left and top, measured from the box's left and bottom edges. */
  let hovered = $state.raw<{ macro: Macro; x: number; y: number } | undefined>();
  let closing: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  /** The text cut at the tokens; a mark carries the index of its token. */
  const segments = $derived.by(() => {
    const parts: { text: string; index: number }[] = [];
    let position = 0;
    tokens.forEach((token, index) => {
      if (token.start > position) parts.push({ text: text.slice(position, token.start), index: -1 });
      parts.push({ text: text.slice(token.start, token.end), index });
      position = token.end;
    });
    if (position < text.length) parts.push({ text: text.slice(position), index: -1 });
    return parts;
  });

  /** Same box, same line breaks and same scroll position as the editor. */
  function sync(): void {
    const editor = input;
    const box = mirror;
    if (!editor || !box) return;
    const style = getComputedStyle(editor);
    for (const property of MIRRORED) box.style.setProperty(property, style.getPropertyValue(property));
    box.scrollTop = editor.scrollTop;
  }

  function cancelClose(): void {
    if (closing === undefined) return;
    clearTimeout(closing);
    closing = undefined;
  }

  function close(): void {
    cancelClose();
    // A frame queued before this would open the card again.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    hovered = undefined;
  }

  /** The pointer may be on its way from the token to the card. */
  function closeSoon(): void {
    if (closing !== undefined) return;
    closing = setTimeout(close, CLOSE_DELAY_MS);
  }

  function tokenAt(x: number, y: number): { index: number; rect: DOMRect } | undefined {
    if (!mirror) return undefined;
    for (const mark of Array.from(mirror.querySelectorAll<HTMLElement>('mark'))) {
      for (const rect of Array.from(mark.getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { index: Number(mark.dataset.index), rect };
      }
    }
    return undefined;
  }

  function pointerMoved(event: MouseEvent): void {
    if (frame) return;
    const { clientX, clientY } = event;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const hit = quiet ? undefined : tokenAt(clientX, clientY);
      const token = hit ? tokens[hit.index] : undefined;
      const host = mirror?.offsetParent;
      if (!hit || !token || !host) {
        closeSoon();
        return;
      }
      cancelClose();
      const box = host.getBoundingClientRect();
      const x = Math.round(hit.rect.left - box.left);
      const y = Math.round(box.bottom - hit.rect.top);
      if (hovered?.macro === token.macro && hovered.x === x && hovered.y === y) return;
      hovered = { macro: token.macro, x, y };
    });
  }

  function edit(): void {
    const macro = hovered?.macro;
    close();
    if (macro) onEdit?.(macro);
  }

  /** The keyboard's way to the same card: the caret resting on a macro shows it. */
  function caretMoved(event: KeyboardEvent): void {
    if (!CARET_KEYS.has(event.key) || frame) return;
    // After the composer has seen the new caret: its menu decides whether the card stays quiet.
    frame = requestAnimationFrame(() => {
      frame = 0;
      const editor = input;
      const host = mirror?.offsetParent;
      const caret = editor && editor.selectionStart === editor.selectionEnd ? editor.selectionStart : -1;
      const index = quiet ? -1 : tokens.findIndex((token) => caret >= token.start && caret <= token.end);
      const token = tokens[index];
      const rect = token ? mirror?.querySelector(`mark[data-index="${index}"]`)?.getClientRects()[0] : undefined;
      if (!token || !rect || !host) {
        close();
        return;
      }
      cancelClose();
      const box = host.getBoundingClientRect();
      hovered = { macro: token.macro, x: Math.round(rect.left - box.left), y: Math.round(box.bottom - rect.top) };
    });
  }

  // The layer follows the editor: its size, its own scrolling and the pointer over it.
  $effect(() => {
    const editor = input;
    if (!editor || !mirror) return;
    const observer = new ResizeObserver(sync);
    observer.observe(editor);
    const scrolled = (): void => {
      sync();
      close();
    };
    const escaped = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    editor.addEventListener('scroll', scrolled);
    editor.addEventListener('mousemove', pointerMoved);
    editor.addEventListener('mouseleave', closeSoon);
    editor.addEventListener('input', close);
    editor.addEventListener('keydown', escaped);
    editor.addEventListener('keyup', caretMoved);
    editor.addEventListener('blur', closeSoon);
    sync();
    return () => {
      observer.disconnect();
      editor.removeEventListener('scroll', scrolled);
      editor.removeEventListener('mousemove', pointerMoved);
      editor.removeEventListener('mouseleave', closeSoon);
      editor.removeEventListener('input', close);
      editor.removeEventListener('keydown', escaped);
      editor.removeEventListener('keyup', caretMoved);
      editor.removeEventListener('blur', closeSoon);
      cancelClose();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
  });

  // The mirror shows the new text by now: match the editor again. A card of the old text goes.
  $effect(() => {
    void text;
    sync();
    close();
  });

  $effect(() => {
    if (quiet) close();
  });
</script>

<div class="macro-marks" aria-hidden="true" bind:this={mirror}>{#each segments as segment, position (position)}{#if segment.index < 0}{segment.text}{:else}<mark data-index={segment.index}>{segment.text}</mark>{/if}{/each}{' '}</div>
{#if hovered && !quiet}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Pointer bookkeeping only: the button is the control, and F2 on the macro is the keyboard path.) -->
  <div
    class="macro-card"
    role="group"
    aria-live="polite"
    aria-label={`//${hovered.macro.name}`}
    style:--macro-x={`${hovered.x}px`}
    style:--macro-y={`${hovered.y}px`}
    onmouseenter={cancelClose}
    onmouseleave={closeSoon}
    onfocusin={cancelClose}
    onfocusout={closeSoon}
    onmousedown={(event) => event.preventDefault()}
  >
    <div class="macro-card__head">
      <code class="macro-card__name">//{hovered.macro.name}</code>
      {#if onEdit}<IconButton size="sm" label={$t('Edit macro')} shortcut="F2" onclick={edit}><Pencil /></IconButton>{/if}
    </div>
    {#if hovered.macro.description}<p class="macro-card__description">{hovered.macro.description}</p>{/if}
    <p class="macro-card__text">{macroText(hovered.macro, syntax)}</p>
  </div>
{/if}

<style>
  .macro-marks {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    margin: 0;
    border: 0 solid transparent;
    overflow-x: hidden;
    color: transparent;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    pointer-events: none;
    user-select: none;
    /* Its scrollbar keeps the editor's width and stays invisible. */
    scrollbar-color: transparent transparent;
  }
  .macro-marks mark {
    border-radius: var(--piui-radius-xs);
    background: color-mix(in srgb, var(--piui-accent) 24%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--piui-accent) 38%, transparent);
    color: transparent;
  }
  .macro-card {
    position: absolute;
    bottom: calc(var(--macro-y) + 4px);
    left: min(var(--macro-x), calc(100% - min(380px, 100%)));
    z-index: var(--piui-z-dropdown);
    display: grid;
    gap: 6px;
    width: min(380px, 100%);
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .macro-card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
  .macro-card__name {
    overflow: hidden;
    color: var(--piui-accent);
    font-family: var(--piui-font-mono);
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .macro-card__description {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .macro-card__text {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    -webkit-box-orient: vertical;
  }
</style>
