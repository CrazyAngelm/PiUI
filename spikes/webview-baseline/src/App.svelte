<script lang="ts">
  const rowHeight = 52;
  const viewportHeight = 520;
  const overscan = 8;
  const useLongFixture = new URLSearchParams(window.location.search).get('fixture') === '10k';
  const virtualBlocks = useLongFixture
    ? Array.from({ length: 10_000 }, (_, index) => `Synthetic timeline block ${index + 1}`)
    : [];

  let scrollTop = 0;
  $: firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  $: visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  $: lastVisible = Math.min(virtualBlocks.length, firstVisible + visibleCount);
  $: visibleBlocks = virtualBlocks.slice(firstVisible, lastVisible);

  function updateScroll(event: Event): void {
    scrollTop = (event.currentTarget as HTMLElement).scrollTop;
  }
</script>

<svelte:head>
  <meta name="description" content="Minimal PiUI WebView performance baseline." />
</svelte:head>

<div class="shell">
  <aside class="sidebar" aria-label="Project navigation">
    <div class="sidebar-actions">
      <button class="quiet-button" type="button" aria-label="Open settings">
        <span class="icon" aria-hidden="true">◌</span>
        <span>Settings</span>
      </button>
      <button class="new-chat" type="button">
        <span aria-hidden="true">+</span>
        <span>New chat</span>
      </button>
    </div>

    <nav aria-label="Projects">
      <p class="eyebrow">Projects</p>
      <button class="project" type="button" aria-expanded="true">
        <span class="chevron" aria-hidden="true">⌄</span>
        <span class="project-name">piui</span>
        <span class="project-status" aria-label="One session running">1</span>
      </button>
      <div class="sessions" aria-label="Sessions in piui">
        <button class="session selected" type="button" aria-current="page">
          <span class="session-state running" aria-hidden="true"></span>
          <span class="session-title">WebView baseline</span>
        </button>
        <button class="session" type="button">
          <span class="session-state" aria-hidden="true"></span>
          <span class="session-title">Initial shell notes</span>
        </button>
      </div>
    </nav>

    <p class="sidebar-footer"><span class="status-dot" aria-hidden="true"></span>Baseline only</p>
  </aside>

  <main class="workspace">
    <header class="chat-header">
      <div>
        <p class="breadcrumb">piui <span aria-hidden="true">/</span> spikes</p>
        <h1>WebView baseline</h1>
      </div>
      <p class="runtime-status"><span class="status-dot" aria-hidden="true"></span>Idle</p>
    </header>

    {#if useLongFixture}
      <section class="fixture-notice" aria-label="Long timeline fixture">
        <strong>10,000-block fixture</strong>
        <span>Only visible rows are mounted; use this mode for physical scroll measurements.</span>
      </section>
      <section class="virtual-timeline" aria-label="Synthetic timeline blocks" onscroll={updateScroll}>
        <div class="virtual-space" style:height={`${virtualBlocks.length * rowHeight}px`}>
          <div class="virtual-rows" style:transform={`translateY(${firstVisible * rowHeight}px)`}>
            {#each visibleBlocks as block, index (firstVisible + index)}
              <article class="virtual-block">
                <span class="block-index">{firstVisible + index + 1}</span>
                <span>{block}</span>
              </article>
            {/each}
          </div>
        </div>
      </section>
    {:else}
      <section class="timeline" aria-label="Chat timeline">
        <article class="message user-message">
          <p class="message-label">You</p>
          <p>Build a narrow desktop shell that proves the WebView baseline before product work starts.</p>
        </article>
        <article class="message assistant-message">
          <p class="message-label">Pi</p>
          <p>This static surface has no runtime, filesystem, shell, or network access. It exists only to measure the host WebView.</p>
          <div class="tool-summary" aria-label="Collapsed baseline note">
            <span class="tool-mark" aria-hidden="true">—</span>
            <span>Baseline scope</span>
            <span class="tool-muted">No Pi process started</span>
          </div>
        </article>
      </section>
    {/if}

    <form class="composer" aria-label="Static message composer">
      <label class="visually-hidden" for="message">Message Pi</label>
      <textarea id="message" rows="2" placeholder="Ask Pi…" readonly aria-readonly="true"></textarea>
      <div class="composer-footer">
        <span class="composer-hint">Static baseline · no message is sent</span>
        <button class="send-button" type="button" disabled aria-label="Send message (unavailable in baseline)">Send <span aria-hidden="true">→</span></button>
      </div>
    </form>
  </main>
</div>
