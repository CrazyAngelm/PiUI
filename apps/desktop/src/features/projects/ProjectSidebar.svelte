<script lang="ts">
  import type { ProjectSummary, SessionCatalogFreshness, SessionSummary } from '../../host-api/types';
  import {
    PROJECT_SESSION_PAGE_SIZE,
    nextProjectSessionCount,
    visibleProjectSessionCount,
  } from '../sessions/projectSessionPagination';

  export let projects: ProjectSummary[] = [];
  export let sessions: SessionSummary[] = [];
  export let personalSessions: SessionSummary[] = [];
  export let personalSelected = false;
  export let personalDraftActive = false;
  export let selectedPersonalSessionId: string | undefined;
  export let selectedProjectId: string | undefined;
  export let expandedProjectId: string | undefined;
  export let selectedSessionId: string | undefined;
  export let sessionsLoading = false;
  export let sessionsFreshness: SessionCatalogFreshness = 'cached';
  export let settingsSelected = false;
  export let onAddProject: () => void;
  export let onNewChat: () => void = () => {};
  export let onSelectProject: (project: ProjectSummary) => void;
  export let onSelectSession: (session: SessionSummary) => void;
  export let onSelectPersonalSession: (session: SessionSummary) => void = () => {};
  export let onRefreshProject: (project: ProjectSummary) => void;
  export let onManageProject: (project: ProjectSummary) => void;
  export let onSettings: () => void;
  export let onSearch: () => void;

  let projectSessionLimit = PROJECT_SESSION_PAGE_SIZE;
  let projectSessionCatalogIdentity = '';

  $: {
    const nextCatalogIdentity = `${expandedProjectId ?? ''}:${sessions.map((session) => session.id).join('|')}`;
    if (nextCatalogIdentity !== projectSessionCatalogIdentity) {
      projectSessionCatalogIdentity = nextCatalogIdentity;
      projectSessionLimit = PROJECT_SESSION_PAGE_SIZE;
    }
  }
  $: selectedProjectSessionIndex = sessions.findIndex((session) => session.id === selectedSessionId);
  $: if (selectedProjectSessionIndex >= projectSessionLimit) {
    projectSessionLimit = visibleProjectSessionCount(selectedProjectSessionIndex + 1, sessions.length);
  }
  $: visibleProjectSessions = sessions.slice(0, visibleProjectSessionCount(projectSessionLimit, sessions.length));
  $: hasHiddenProjectSessions = visibleProjectSessions.length < sessions.length;

</script>

<aside class="sidebar" aria-label="Project navigation">
  <div class="side-actions">
    <button class:selected={settingsSelected} class="nav-button nav-button--quiet" type="button" onclick={onSettings} aria-label="Open PiUI settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z"/><path d="m19.2 13.1 1.26.98-1.7 2.94-1.5-.6a7.7 7.7 0 0 1-1.7.98L15.34 19h-3.4l-.23-1.6a7.7 7.7 0 0 1-1.7-.98l-1.5.6-1.7-2.94 1.26-.98a7.1 7.1 0 0 1 0-2.2l-1.26-.98 1.7-2.94 1.5.6a7.7 7.7 0 0 1 1.7-.98L11.94 5h3.4l.23 1.6a7.7 7.7 0 0 1 1.7.98l1.5-.6 1.7 2.94-1.26.98a7.1 7.1 0 0 1 0 2.2Z"/></svg>
      <span>Settings</span>
    </button>
    <button class="nav-button nav-button--primary" type="button" onclick={onNewChat} aria-label="Start a new chat">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>New chat</span>
    </button>
    <button class="nav-button nav-button--quiet" type="button" onclick={onAddProject} aria-label="Add a project folder">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>Add project</span>
    </button>
    <button class="nav-button nav-button--quiet" type="button" onclick={onSearch} aria-label="Search local session titles and previews">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/></svg>
      <span>Search</span>
    </button>
  </div>

  <nav class="projects" aria-label="Chats and projects">
    <section class="chat-group" class:selected={personalSelected}>
      <p class="section-label">Chats</p>
      <div class="session-list session-list--personal" aria-label="Personal chats">
        {#if personalSessions.length === 0 && !personalDraftActive}
          <p class="no-sessions">No personal chats yet</p>
        {:else}
          {#if personalDraftActive}
            <div class="session-row session-row--draft selected" aria-current="page" role="status">
              <span class="status-dot status-dot--pending" aria-hidden="true"></span>
              <span class="session-copy"><span class="session-title">New chat</span></span>
            </div>
          {/if}
          {#each personalSessions as session (session.id)}
            <button class:selected={personalSelected && session.id === selectedPersonalSessionId} class="session-row" type="button" aria-current={personalSelected && session.id === selectedPersonalSessionId ? 'page' : undefined} onclick={() => onSelectPersonalSession(session)}>
              {#if session.parseState === 'corrupt'}
                <span class="status-dot status-dot--dormant status-dot--failed" role="img" aria-label="Session data may be incomplete"></span>
              {:else}
                <span class="status-dot status-dot--dormant" aria-hidden="true"></span>
              {/if}
              <span class="session-copy">
                <span class="session-title">{session.title}</span>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </section>

    <p class="section-label">Projects</p>
    {#if projects.length === 0}
      <p class="no-projects">Your folders stay local. Add one when you are ready.</p>
    {:else}
      {#each projects as project (project.id)}
        <section class:selected={project.id === selectedProjectId} class:expanded={project.id === expandedProjectId} class="project-group">
          <button class="project-row" type="button" aria-current={project.id === selectedProjectId ? 'page' : undefined} aria-expanded={project.id === expandedProjectId} onclick={() => onSelectProject(project)}>
            <svg class:expanded={project.id === expandedProjectId} class="project-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            <span class="project-name">{project.name}</span>
            {#if project.pinned}
              <span class="pin-mark" aria-label="Project is pinned">Pinned</span>
            {/if}
            {#if project.missing}
              <span class="missing-mark" aria-label="Project folder is unavailable">Unavailable</span>
            {:else if project.trustState !== 'trusted'}
              <span class="trust-mark" aria-label="Project is restricted">Restricted</span>
            {/if}
          </button>
          {#if project.id === expandedProjectId}
            <div class="session-list" aria-label={`Sessions in ${project.name}`} aria-busy={sessionsLoading}>
              <div class="session-list-header">
                <span>{project.missing ? 'Folder unavailable' : 'Local sessions'}{#if sessionsLoading && sessions.length > 0}<span class="catalog-refreshing" role="status">Refreshing…</span>{/if}</span>
                <span class="session-actions"><button class="refresh-button" type="button" onclick={() => onRefreshProject(project)} disabled={sessionsLoading} aria-label={`Refresh local sessions for ${project.name}`}>Refresh</button><button class="refresh-button" type="button" onclick={() => onManageProject(project)} aria-label={`Manage ${project.name}`}>Manage</button></span>
              </div>
              {#if project.missing}
                <p class="no-sessions">Reconnect the folder, then refresh. PiUI does not modify its session files.</p>
              {:else if sessionsLoading && sessions.length === 0}
                <p class="no-sessions" role="status">Scanning local Pi sessions…</p>
              {:else if sessions.length === 0}
                <p class="no-sessions">{sessionsFreshness === 'current' ? 'No indexed Pi sessions' : 'No indexed Pi sessions yet'}</p>
              {:else}
                {#each visibleProjectSessions as session (session.id)}
                  <button class:selected={session.id === selectedSessionId} class="session-row" type="button" aria-current={session.id === selectedSessionId ? 'page' : undefined} onclick={() => onSelectSession(session)}>
                    {#if session.parseState === 'corrupt'}
                      <span class="status-dot status-dot--dormant status-dot--failed" role="img" aria-label="Session data may be incomplete"></span>
                    {:else}
                      <span class="status-dot status-dot--dormant" aria-hidden="true"></span>
                    {/if}
                    <span class="session-copy">
                      <span class="session-title">{session.title}</span>
                    </span>
                  </button>
                {/each}
                {#if hasHiddenProjectSessions}
                  <div class="session-pagination" aria-label="More project sessions">
                    <button class="session-page-button" type="button" onclick={() => projectSessionLimit = nextProjectSessionCount(projectSessionLimit, sessions.length)}>
                      Show {Math.min(PROJECT_SESSION_PAGE_SIZE, sessions.length - visibleProjectSessions.length)} more
                    </button>
                    <button class="session-page-button" type="button" onclick={() => projectSessionLimit = sessions.length}>
                      Show all ({sessions.length})
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  </nav>

</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
    border-right: 1px solid var(--piui-border);
    background: var(--piui-bg-raised);
  }

  .side-actions { display: grid; gap: var(--piui-space-2); padding: var(--piui-space-4); }
  .nav-button { display: flex; align-items: center; justify-content: center; gap: var(--piui-space-2); min-height: 38px; border-radius: var(--piui-radius-sm); font-size: 13px; font-weight: 680; }
  .nav-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .nav-button--quiet { justify-content: flex-start; padding: 0 var(--piui-space-3); background: transparent; color: var(--piui-text-muted); }
  .nav-button--quiet:hover, .nav-button--quiet.selected { background: var(--piui-surface-1); color: var(--piui-text); }
  .nav-button--primary { background: var(--piui-accent); color: var(--piui-accent-ink); }
  .nav-button--primary:hover { background: #b2cf97; }
  .projects { flex: 1 1 0; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: var(--piui-space-3) var(--piui-space-2); }
  .section-label { margin: 0 0 var(--piui-space-2); padding: 0 var(--piui-space-2); color: var(--piui-text-faint); font-size: 10px; font-weight: 720; letter-spacing: .1em; text-transform: uppercase; }
  .chat-group { margin-bottom: var(--piui-space-3); }
  .no-projects, .no-sessions { margin: var(--piui-space-3) var(--piui-space-2); color: var(--piui-text-muted); font-size: 12px; line-height: 1.5; }
  .project-group { margin-bottom: 2px; }
  .project-row, .session-row { width: 100%; text-align: left; }
  .project-row { display: flex; align-items: center; gap: var(--piui-space-2); padding: 8px var(--piui-space-2); border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text); font-size: 13px; font-weight: 660; }
  .project-row:hover, .project-group.selected > .project-row { background: var(--piui-surface-1); }
  .project-chevron { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: var(--piui-text-muted); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; transition: transform 140ms ease; }
  .project-chevron.expanded { transform: rotate(90deg); }
  .project-name, .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trust-mark, .missing-mark, .pin-mark { font-size: 10px; font-weight: 650; }
  .pin-mark { margin-left: auto; color: var(--piui-accent); }
  .trust-mark { margin-left: auto; color: var(--piui-warning); }
  .missing-mark { color: var(--piui-danger); }
  .session-list { display: grid; gap: 2px; margin: 2px 0 7px var(--piui-space-3); padding-left: var(--piui-space-2); border-left: 1px solid var(--piui-border-subtle); }
  .session-pagination { display: flex; flex-wrap: wrap; gap: 2px; padding: var(--piui-space-1) var(--piui-space-2) 0; }
  .session-page-button { min-height: 28px; padding: 3px 5px; border-radius: 3px; background: transparent; color: var(--piui-text-muted); font-size: 10px; font-weight: 700; }
  .session-page-button:hover, .session-page-button:focus-visible { background: var(--piui-surface-2); color: var(--piui-text); }
  .session-list--personal { margin-top: 0; }
  .session-list-header { display: flex; align-items: center; justify-content: space-between; min-height: 25px; padding: 0 var(--piui-space-2); color: var(--piui-text-faint); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .catalog-refreshing { margin-left: 6px; color: var(--piui-text-muted); font-size: 9px; font-weight: 600; letter-spacing: 0; text-transform: none; }
  .session-actions { display: flex; align-items: center; gap: 2px; }
  .refresh-button { padding: 2px 4px; border-radius: 3px; background: transparent; color: var(--piui-text-muted); font-size: 10px; font-weight: 700; letter-spacing: 0; text-transform: none; }
  .refresh-button:hover:not(:disabled) { background: var(--piui-surface-2); color: var(--piui-text); }
  .refresh-button:disabled { cursor: wait; opacity: .55; }
  .session-row { display: flex; align-items: flex-start; gap: var(--piui-space-2); padding: 7px var(--piui-space-2); border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text-muted); }
  .session-row:hover, .session-row.selected { background: var(--piui-surface-2); color: var(--piui-text); }
  .session-row .status-dot { width: 7px; height: 7px; margin-top: 5px; }
  .session-row--draft { cursor: default; }
  .status-dot--pending { border-color: var(--piui-accent); background: var(--piui-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-accent) 13%, transparent); }
  .session-copy { min-width: 0; }
  .session-title { display: block; font-size: 13px; line-height: 1.25; }
</style>
