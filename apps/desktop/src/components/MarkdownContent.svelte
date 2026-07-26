<script lang="ts">
  import { parseMarkdown, type InlineNode } from './markdown';

  export let source: string;
  export let compact = false;

  let copiedCode: string | undefined;
  $: parsed = parseMarkdown(source);

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
    {:else if node.kind === 'link'}
      <span class="safe-link" title={node.href}>{@render inline(node.label)}</span>
    {:else}
      {node.text}
    {/if}
  {/each}
{/snippet}

<div class:compact class="markdown-content">
  {#each parsed as block}
    {#if block.kind === 'heading'}
      {#if block.depth === 1}<h1>{@render inline(block.inline)}</h1>
      {:else if block.depth === 2}<h2>{@render inline(block.inline)}</h2>
      {:else if block.depth === 3}<h3>{@render inline(block.inline)}</h3>
      {:else}<h4>{@render inline(block.inline)}</h4>{/if}
    {:else if block.kind === 'paragraph'}
      <p>{@render inline(block.inline)}</p>
    {:else if block.kind === 'code'}
      <figure class="code-block">
        <figcaption><span>{languageLabel(block.language)}</span><button type="button" onclick={() => void copyCode(block.text)} aria-label={`Copy ${languageLabel(block.language)} code`}>{copiedCode === block.text ? 'Copied' : 'Copy'}</button></figcaption>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre tabindex="0" role="region" aria-label={`${languageLabel(block.language)} code`}><code>{block.text}</code></pre>
      </figure>
    {:else if block.kind === 'quote'}
      <blockquote><p>{@render inline(block.inline)}</p></blockquote>
    {:else if block.kind === 'list'}
      {#if block.ordered}
        <ol start={block.start}>{#each block.items as item}<li>{@render inline(item)}</li>{/each}</ol>
      {:else}
        <ul>{#each block.items as item}<li>{@render inline(item)}</li>{/each}</ul>
      {/if}
    {:else}
      <hr />
    {/if}
  {/each}
</div>

<style>
  .markdown-content { min-width: 0; max-width: var(--piui-chat-reading-width); color: var(--piui-text); font-size: var(--piui-chat-font-size); line-height: 1.66; overflow-wrap: anywhere; text-wrap: pretty; }
  .markdown-content p { margin: 0 0 .82em; white-space: pre-line; }.markdown-content p:last-child { margin-bottom: 0; }
  .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 { margin: 1.35em 0 .55em; color: var(--piui-text); font-weight: 720; line-height: 1.22; letter-spacing: -.025em; text-wrap: balance; }
  .markdown-content h1:first-child, .markdown-content h2:first-child, .markdown-content h3:first-child, .markdown-content h4:first-child { margin-top: 0; }
  .markdown-content h1 { font-size: 1.5em; }.markdown-content h2 { font-size: 1.28em; }.markdown-content h3 { font-size: 1.1em; }.markdown-content h4 { font-size: 1em; }
  .markdown-content ul, .markdown-content ol { margin: .55em 0 .9em; padding-left: 1.45em; }.markdown-content li { margin: .28em 0; padding-left: .18em; }
  .markdown-content strong { font-weight: 720; }.markdown-content em { color: color-mix(in srgb, var(--piui-text) 88%, var(--piui-text-muted)); }
  .markdown-content blockquote { margin: .9em 0; padding: .05em 0 .05em 1em; border-left: 2px solid var(--piui-border); color: var(--piui-text-muted); }.markdown-content blockquote p { margin: 0; }
  .markdown-content hr { height: 1px; margin: 1.4em 0; border: 0; background: var(--piui-border-subtle); }
  .inline-code { padding: .1em .35em; border: 1px solid var(--piui-border-subtle); border-radius: 5px; background: var(--piui-surface-1); color: color-mix(in srgb, var(--piui-text) 92%, var(--piui-accent)); font-family: var(--piui-font-mono); font-size: .88em; white-space: break-spaces; }
  .safe-link { color: var(--piui-accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--piui-accent) 45%, transparent); text-underline-offset: .18em; cursor: help; }
  .code-block { width: min(100%, 78ch); margin: 1em 0; overflow: hidden; border: 1px solid var(--piui-border-subtle); border-radius: var(--piui-radius-md); background: color-mix(in srgb, var(--piui-bg) 72%, var(--piui-surface-1)); }
  .code-block figcaption { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: var(--piui-space-3); padding: 0 10px 0 12px; border-bottom: 1px solid var(--piui-border-subtle); color: var(--piui-text-faint); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .code-block button { padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: var(--piui-text-muted); font-size: 10px; text-transform: none; letter-spacing: normal; }.code-block button:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .code-block pre { max-width: 100%; margin: 0; padding: 13px 14px; overflow: auto; color: var(--piui-text); font-family: var(--piui-font-mono); font-size: var(--piui-chat-code-font-size); line-height: 1.58; tab-size: 2; white-space: pre; }
  .compact { max-width: none; font-size: calc(var(--piui-chat-font-size) - 3px); line-height: 1.55; }.compact p { margin-bottom: .55em; }
</style>
