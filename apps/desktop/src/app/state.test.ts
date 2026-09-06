import { describe, expect, it } from 'vitest';
import { initialAppState, reduceAppState } from './state';

const project = {
  id: 'project-1',
  name: 'Work',
  displayPath: 'D:/work',
  agentKind: 'pi' as const,
  trustState: 'restricted' as const,
  pinned: false,
  missing: false,
};

const sessions = [
  {
    id: 'session-1',
    projectId: 'project-1',
    title: 'First task',
    titleSource: 'first-user-message' as const,
    entryCount: 1,
    parseState: 'healthy' as const,
  },
];

describe('reduceAppState', () => {
  it('selects the first session after loading a project', () => {
    const booted = reduceAppState(initialAppState, {
      type: 'booted',
      snapshot: {
        appVersion: '0.1.0',
        safeMode: false,
        preferences: {
          theme: 'system',
          density: 'comfortable',
          reducedMotion: 'system',
          fontSize: 'medium',
          chatWidth: 'wide',
        },
        projects: [project],
      },
    });

    const state = reduceAppState(booted, {
      type: 'sessions-loaded',
      projectId: project.id,
      sessions,
    });

    expect(booted.safeMode).toBe(false);
    expect(state.selectedProjectId).toBe(project.id);
    expect(state.selectedSessionId).toBe('session-1');
  });

  it('keeps the selected session only while it still belongs to the list', () => {
    const state = reduceAppState(
      { ...initialAppState, selectedSessionId: 'missing' },
      { type: 'sessions-loaded', projectId: project.id, sessions },
    );

    expect(state.selectedSessionId).toBe('session-1');
  });

  it('lets catalog refresh preserve an empty selection until the caller chooses the confirmed new session', () => {
    const state = reduceAppState(
      { ...initialAppState, selectedProjectId: project.id, selectedSessionId: undefined },
      { type: 'sessions-loaded', projectId: project.id, sessions, selectFirst: false },
    );

    expect(state.selectedSessionId).toBeUndefined();
    expect(state.sessions).toEqual(sessions);
  });

  it('opens a new chat in the selected project without selecting an old session', () => {
    const selected = {
      ...initialAppState,
      projects: [project],
      selectedProjectId: project.id,
      selectedSessionId: sessions[0].id,
      sessions,
    };

    const projectChat = reduceAppState(selected, {
      type: 'new-chat',
      projectId: project.id,
      sessions,
    });
    const personalChat = reduceAppState(projectChat, { type: 'new-chat' });

    expect(projectChat.selectedProjectId).toBe(project.id);
    expect(projectChat.selectedSessionId).toBeUndefined();
    expect(projectChat.sessions).toEqual(sessions);
    expect(personalChat.selectedProjectId).toBeUndefined();
    expect(personalChat.selectedSessionId).toBeUndefined();
    expect(personalChat.sessions).toEqual([]);
  });

  it('binds exact Prime session B from an A+B catalog without changing the live chat key', () => {
    const primeProject = { ...project, agentKind: 'prime-agent' as const };
    const sessionA = { ...sessions[0], id: 'opaque-a', projectId: primeProject.id };
    const sessionB = { ...sessionA, id: 'opaque-b', title: 'Bound B' };
    const projectChatEpoch = 17;
    const liveChatKey = `project:${primeProject.id}:${primeProject.agentKind}:${projectChatEpoch}`;
    const awaitingRuntime = {
      ...initialAppState,
      projects: [primeProject],
      selectedProjectId: primeProject.id,
      sessions: [sessionA],
    };

    // Metadata-only startup can begin from this blank selection. The runtime
    // binding uses exact opaque B and in-place catalog selection; it does not
    // take the `new-chat` navigation/remount path.
    const catalog = reduceAppState(awaitingRuntime, {
      type: 'sessions-loaded',
      projectId: primeProject.id,
      sessions: [sessionA, sessionB],
      selectFirst: false,
    });
    const bound = reduceAppState(catalog, { type: 'selected-session', sessionId: sessionB.id });

    expect(bound.selectedSessionId).toBe(sessionB.id);
    expect(bound.sessions.map((session) => session.id)).toEqual([sessionA.id, sessionB.id]);
    expect(`project:${bound.selectedProjectId}:${primeProject.agentKind}:${projectChatEpoch}`).toBe(liveChatKey);
  });

  it('keeps prior Prime sessions when starting another session in the same project', () => {
    const primeProject = { ...project, agentKind: 'prime-agent' as const };
    const first = { ...sessions[0], projectId: primeProject.id };
    const second = { ...first, id: 'session-2', title: 'Second task' };
    const selected = {
      ...initialAppState,
      projects: [primeProject],
      selectedProjectId: primeProject.id,
      selectedSessionId: first.id,
      sessions: [first],
    };

    const firstDraft = reduceAppState(selected, {
      type: 'new-chat',
      projectId: primeProject.id,
      sessions: [first],
    });
    const secondConfirmed = reduceAppState(firstDraft, {
      type: 'sessions-loaded',
      projectId: primeProject.id,
      sessions: [second, first],
    });
    const secondDraft = reduceAppState(secondConfirmed, {
      type: 'new-chat',
      projectId: primeProject.id,
      sessions: [second, first],
    });

    expect(firstDraft.selectedSessionId).toBeUndefined();
    expect(secondConfirmed.selectedSessionId).toBe(second.id);
    expect(secondDraft.selectedSessionId).toBeUndefined();
    expect(secondDraft.sessions.map((session) => session.id)).toEqual([second.id, first.id]);
    expect(secondDraft.projects[0].agentKind).toBe('prime-agent');
  });

  it('accepts a refreshed restricted trust state and clears a removed project view', () => {
    const selected = {
      ...initialAppState,
      projects: [{ ...project, trustState: 'trusted' as const }],
      selectedProjectId: project.id,
      selectedSessionId: sessions[0].id,
      sessions,
    };
    const restricted = reduceAppState(selected, {
      type: 'projects-loaded',
      projects: [project],
    });
    const cleared = reduceAppState(restricted, { type: 'projects-loaded', projects: [] });

    expect(restricted.projects[0].trustState).toBe('restricted');
    expect(cleared.selectedProjectId).toBeUndefined();
    expect(cleared.selectedSessionId).toBeUndefined();
    expect(cleared.sessions).toEqual([]);
  });
});
