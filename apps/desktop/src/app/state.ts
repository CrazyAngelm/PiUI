import type { AppSnapshot, ProjectSummary, RuntimeSnapshot, SessionSummary } from '../host-api/types';

export interface AppState {
  loading: boolean;
  safeMode: boolean;
  error?: string;
  projects: ProjectSummary[];
  selectedProjectId?: string;
  selectedSessionId?: string;
  sessions: SessionSummary[];
  runtime?: RuntimeSnapshot;
}

export const initialAppState: AppState = {
  loading: true,
  safeMode: false,
  projects: [],
  sessions: [],
};

export type AppAction =
  | { type: 'booted'; snapshot: AppSnapshot }
  | { type: 'projects-loaded'; projects: ProjectSummary[] }
  | { type: 'sessions-loaded'; projectId: string; sessions: SessionSummary[]; selectFirst?: boolean }
  | { type: 'selected-session'; sessionId?: string }
  | { type: 'runtime-updated'; runtime?: RuntimeSnapshot }
  | { type: 'failed'; message: string };

export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'booted':
      return {
        ...state,
        loading: false,
        error: undefined,
        safeMode: action.snapshot.safeMode,
        projects: action.snapshot.projects,
        selectedProjectId: action.snapshot.selectedProjectId,
        selectedSessionId: action.snapshot.selectedSessionId,
      };
    case 'projects-loaded': {
      const selectedProjectId = action.projects.some((project) => project.id === state.selectedProjectId)
        ? state.selectedProjectId
        : undefined;
      return {
        ...state,
        projects: action.projects,
        selectedProjectId,
        selectedSessionId: selectedProjectId ? state.selectedSessionId : undefined,
        sessions: selectedProjectId ? state.sessions : [],
      };
    }
    case 'sessions-loaded': {
      const selectedSessionId = state.selectedSessionId && action.sessions.some((session) => session.id === state.selectedSessionId)
        ? state.selectedSessionId
        : action.selectFirst === false
          ? undefined
          : action.sessions[0]?.id;
      return {
        ...state,
        selectedProjectId: action.projectId,
        sessions: action.sessions,
        selectedSessionId,
      };
    }
    case 'selected-session':
      return { ...state, selectedSessionId: action.sessionId };
    case 'runtime-updated':
      return { ...state, runtime: action.runtime };
    case 'failed':
      return { ...state, loading: false, error: action.message };
    default:
      return assertNever(action);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled PiUI state action: ${JSON.stringify(value)}`);
}
