<script lang="ts">
  import { useTranslation } from '../features/locale/context';
  import { useConversationPresentation } from '../shared/conversation/context';
  import { toasts } from '../lib/ui';
  const t = useTranslation();
  const presentation = useConversationPresentation();
  import { createMarkdownParser, type InlineNode, type ListItemNode, type MarkdownBlock } from './markdown';
  import { mathSource, typesetMath } from './mathTypeset';

  let {
    source,
    compact = false,
    rich = false,
    widgets = rich,
    printMode = false,
    streaming = false,
    onOpenLink = undefined,
  }: {
    source: string;
    compact?: boolean;
    rich?: boolean;
    widgets?: boolean;
    printMode?: boolean;
    /** The text is still arriving: its unfinished end is shown as written and only that end is parsed again. */
    streaming?: boolean;
    /** Opens an http(s) link in the system browser through the host. Resolve false (or reject) when it could not. */
    onOpenLink?: (url: string) => Promise<boolean> | boolean | void;
  } = $props();

  let copiedCode = $state<string | undefined>();
  let root = $state<HTMLElement | undefined>(undefined);
  // One parser per message: the completed blocks of a growing text are parsed once (see parseMarkdown in markdown.ts for the grammar).
  const parser = $derived(createMarkdownParser({ rich, widgets }));
  const parsed = $derived(parser.parse(source, streaming));

  // A formula stays its TeX source until KaTeX (loaded on first use) replaces it; a formula in the unfinished end of a streaming text waits.
  $effect(() => {
    void parsed;
    if (root !== undefined && rich) typesetMath(root, streaming);
  });

  async function copyCode(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copiedCode = value;
      window.setTimeout(() => {
        if (copiedCode === value) copiedCode = undefined;
      }, 1_500);
    } catch {
      copiedCode = undefined;
    }
  }

  function languageLabel(language: string | undefined): string {
    return language || 'Code';
  }

  function isWebUrl(href: string): boolean {
    try {
      const { protocol } = new URL(href);
      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  }

  async function copyText(value: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toasts.success(done);
    } catch {
      toasts.error($t('Could not copy'));
    }
  }

  // Only the host opens an address (AGENTS.md): with no host route the address is copied instead.
  async function openLink(url: string): Promise<void> {
    const opener = onOpenLink ?? presentation.openLink;
    if (opener !== undefined) {
      try {
        if ((await opener(url)) !== false) return;
      } catch {
        // Fall back to copying the address below.
      }
    }
    await copyText(url, $t('Link copied. Open it in your browser.'));
  }

  function onLinkKey(event: KeyboardEvent, run: () => void, space = false): void {
    if (event.key === 'Enter' || (space && event.key === ' ')) {
      event.preventDefault();
      run();
    }
  }
</script>

{#snippet inline(nodes: InlineNode[])}
  {#each nodes as node}
    {#if node.kind === 'strong'}
      <strong>{@render inline(node.children)}</strong>
    {:else if node.kind === 'emphasis'}
      <em>{@render inline(node.children)}</em>
    {:else if node.kind === 'delete'}
      <del>{@render inline(node.children)}</del>
    {:else if node.kind === 'code'}
      <code class="inline-code">{node.text}</code>
    {:else if node.kind === 'math'}
      {#key node.text}<span class="math" class:math--display={node.display} data-tex={mathSource(node.text)}>{node.text}</span>{/key}
    {:else if node.kind === 'link'}
      {#if isWebUrl(node.href)}
        <span
          class="safe-link"
          role="link"
          tabindex={printMode ? undefined : 0}
          title={node.title ?? node.href}
          data-link-url={rich ? node.href : undefined}
          onclick={() => void openLink(node.href)}
          onkeydown={(event) => onLinkKey(event, () => void openLink(node.href))}>{@render inline(node.label)}</span>
      {:else}
        <!-- A path or other non-web address is text for the reader to copy; nothing here is opened. -->
        <span
          class="local-link"
          role="button"
          tabindex={printMode ? undefined : 0}
          title={node.href}
          aria-label={$t('Copy {0}', [node.href])}
          onclick={() => void copyText(node.href, $t('Copied'))}
          onkeydown={(event) => onLinkKey(event, () => void copyText(node.href, $t('Copied')), true)}>{@render inline(node.label)}</span>
      {/if}
    {:else if node.kind === 'image'}
      {#key JSON.stringify([node.href, node.alt])}
        <!-- The core never fetches Markdown URLs. Only a trusted owner may fill this empty slot. -->
        <span class="inline-image"><span class="inline-image-host" data-image-url={rich ? node.href : undefined} data-image-alt={node.alt}></span><span class="inline-image-fallback">{node.alt || $t('Image')}</span></span>
      {/key}
    {:else}
      {node.text}
    {/if}
  {/each}
{/snippet}

{#snippet codeBlock(block: Extract<MarkdownBlock, { kind: 'code' }>)}
  <figure class="code-block">
    <figcaption><span>{languageLabel(block.language)}</span>{#if !printMode}<button type="button" onclick={() => void copyCode(block.text)} aria-label={$t("Copy {0} code", [languageLabel(block.language)])}>{copiedCode === block.text ? $t('Copied') : $t('Copy')}</button>{/if}</figcaption>
    {#if widgets && block.language === 'hermes-ui'}
      <!-- Widgets append their own container but do not replace this source node. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre tabindex={printMode ? undefined : 0} role="region" aria-label={`${languageLabel(block.language)} code`}><code class="language-hermes-ui">{block.text}</code></pre>
    {:else}
      {#key rich ? `${block.language ?? ''}:${block.text}` : block.language}
        <!-- A highlighter may replace the code's children. Changed source owns a fresh node. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre tabindex={printMode ? undefined : 0} role="region" aria-label={`${languageLabel(block.language)} code`}><code class={rich && block.language ? `language-${block.language}` : undefined}>{block.text}</code></pre>
      {/key}
    {/if}
  </figure>
{/snippet}

{#snippet listItem(item: ListItemNode)}
  <li class:task={item.checked !== undefined}>
    {#if item.checked !== undefined}<input class="task__box" type="checkbox" checked={item.checked} disabled aria-label={item.checked ? $t('Completed') : $t('Not completed')} />{/if}
    {@render blockList(item.children)}
  </li>
{/snippet}

{#snippet blockList(list: MarkdownBlock[])}
  {#each list as block}
    {@render blockView(block)}
  {/each}
{/snippet}

{#snippet blockView(block: MarkdownBlock)}
  {#if block.kind === 'heading'}
    {#if block.depth === 1}<h1>{@render inline(block.inline)}</h1>
    {:else if block.depth === 2}<h2>{@render inline(block.inline)}</h2>
    {:else if block.depth === 3}<h3>{@render inline(block.inline)}</h3>
    {:else if block.depth === 4}<h4>{@render inline(block.inline)}</h4>
    {:else if block.depth === 5}<h5>{@render inline(block.inline)}</h5>
    {:else}<h6>{@render inline(block.inline)}</h6>{/if}
  {:else if block.kind === 'paragraph'}
    {#if block.tight}<span class="tight">{@render inline(block.inline)}</span>{:else}<p>{@render inline(block.inline)}</p>{/if}
  {:else if block.kind === 'code'}
    {@render codeBlock(block)}
  {:else if block.kind === 'quote'}
    <blockquote>{@render blockList(block.children)}</blockquote>
  {:else if block.kind === 'list'}
    {#if block.ordered}
      <ol start={block.start}>{#each block.items as item}{@render listItem(item)}{/each}</ol>
    {:else}
      <ul>{#each block.items as item}{@render listItem(item)}{/each}</ul>
    {/if}
  {:else if block.kind === 'table'}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="table-wrap" tabindex={printMode ? undefined : 0} role="region" aria-label={$t('Table')}>
      <table>
        <thead>
          <tr>{#each block.head as cell, column}<th style:text-align={block.align[column]}>{@render inline(cell)}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each block.rows as row}
            <tr>{#each row as cell, column}<td style:text-align={block.align[column]}>{@render inline(cell)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <hr />
  {/if}
{/snippet}

<div class:compact class:print={printMode} class="markdown-content" bind:this={root}>
  {#each parsed as { block, key } (key)}
    {@render blockView(block)}
  {/each}
</div>

<style>
  .markdown-content { min-width: 0; max-width: var(--piui-chat-reading-width); color: var(--piui-text); font-size: var(--piui-chat-font-size); line-height: 1.55; overflow-wrap: anywhere; text-wrap: pretty; }
  .markdown-content p { margin: 0 0 .65em; white-space: pre-line; }.markdown-content p:last-child { margin-bottom: 0; }
  .markdown-content .tight { white-space: pre-line; }
  .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4, .markdown-content h5, .markdown-content h6 { margin: 1.35em 0 .55em; color: var(--piui-text); font-weight: 720; line-height: 1.22; letter-spacing: -.025em; text-wrap: balance; }
  .markdown-content h1:first-child, .markdown-content h2:first-child, .markdown-content h3:first-child, .markdown-content h4:first-child, .markdown-content h5:first-child, .markdown-content h6:first-child { margin-top: 0; }
  .markdown-content h1 { font-size: 1.5em; }.markdown-content h2 { font-size: 1.28em; }.markdown-content h3 { font-size: 1.1em; }.markdown-content h4, .markdown-content h5, .markdown-content h6 { font-size: 1em; }
  .markdown-content h6 { color: var(--piui-text-muted); }
  .markdown-content ul, .markdown-content ol { margin: .55em 0 .9em; padding-left: 1.45em; }.markdown-content li { margin: .28em 0; padding-left: .18em; }
  .markdown-content li > ul, .markdown-content li > ol { margin: .3em 0 .4em; }
  .markdown-content li > p { margin-bottom: .4em; }
  .markdown-content li.task { list-style: none; }
  .task__box { margin: 0 .5em 0 -1.45em; vertical-align: -1px; accent-color: var(--piui-accent); }
  .markdown-content strong { font-weight: 720; }.markdown-content em { color: color-mix(in srgb, var(--piui-text) 88%, var(--piui-text-muted)); }
  .markdown-content blockquote { margin: .9em 0; padding: .05em 0 .05em 1em; border-left: 2px solid var(--piui-border); color: var(--piui-text-muted); }
  .markdown-content hr { height: 1px; margin: 1.4em 0; border: 0; background: var(--piui-border-subtle); }
  .table-wrap { max-width: 100%; margin: .9em 0; overflow-x: auto; border: 1px solid var(--piui-border-subtle); border-radius: var(--piui-radius-md); outline: none; }
  .table-wrap:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .table-wrap table { width: 100%; border-collapse: collapse; font-size: .94em; line-height: 1.45; font-variant-numeric: tabular-nums; }
  .table-wrap th, .table-wrap td { padding: 7px 12px; border-bottom: 1px solid var(--piui-border-subtle); text-align: left; vertical-align: top; overflow-wrap: normal; }
  .table-wrap td { white-space: pre-line; }
  .table-wrap th { background: var(--piui-surface-1); color: var(--piui-text-muted); font-weight: 650; white-space: nowrap; }
  .table-wrap tbody tr:last-child td { border-bottom: 0; }
  .table-wrap tbody tr:hover td { background: var(--piui-hover); }
  .math--display { display: block; max-width: 100%; margin: .6em 0; overflow-x: auto; overflow-y: hidden; }
  .inline-code { padding: .08em .3em; border: 0; border-radius: 5px; background: color-mix(in srgb, var(--piui-surface-1) 70%, transparent); color: var(--piui-text); font-family: var(--piui-font-mono); font-size: .86em; white-space: break-spaces; }
  .safe-link { color: var(--piui-accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--piui-accent) 45%, transparent); text-underline-offset: .18em; cursor: pointer; border-radius: 3px; }
  .safe-link:hover { text-decoration-color: currentColor; }
  .local-link { padding: .08em .3em; border-radius: 5px; background: color-mix(in srgb, var(--piui-surface-1) 70%, transparent); color: var(--piui-text); font-family: var(--piui-font-mono); font-size: .86em; white-space: break-spaces; cursor: copy; }
  .local-link:hover { background: var(--piui-surface-2); }
  .safe-link:focus-visible, .local-link:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 1px; }
  .print .safe-link, .print .local-link { cursor: auto; }
  .inline-image-host:global([data-active='true']) + .inline-image-fallback { display: none; }
  .inline-image-host :global(img) { display: block; max-width: 100%; height: auto; }
  .code-block { width: min(100%, 78ch); margin: 1em 0; overflow: hidden; border: 1px solid var(--piui-border-subtle); border-radius: var(--piui-radius-md); background: color-mix(in srgb, var(--piui-bg) 72%, var(--piui-surface-1)); }
  .code-block figcaption { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding: 0 10px 0 12px; border-bottom: 1px solid var(--piui-border-subtle); color: var(--piui-text-faint); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .code-block button { padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: var(--piui-text-muted); font-size: 10px; text-transform: none; letter-spacing: normal; }.code-block button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .code-block pre { max-width: 100%; margin: 0; padding: 13px 14px; overflow: auto; color: var(--piui-text); font-family: var(--piui-font-mono); font-size: var(--piui-chat-code-font-size); line-height: 1.58; tab-size: 2; white-space: pre; }
  .print .code-block pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
  .print .table-wrap { overflow: visible; }
  .print .table-wrap th, .print .table-wrap td { white-space: normal; overflow-wrap: anywhere; }
  .compact { max-width: none; font-size: calc(var(--piui-chat-font-size) - 3px); line-height: 1.55; }.compact p { margin-bottom: .55em; }
</style>
