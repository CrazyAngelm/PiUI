import { describe, expect, it } from 'vitest';
import { initialAppState, reduceAppState } from './state';

const project = {
  id: 'project-1',
  name: 'Work',
  displayPath: 'D:/work',
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
