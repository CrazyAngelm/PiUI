import type { AgentKind, AppSnapshot, Preferences, ProjectSummary, ProjectTrustState } from './labContracts';
import { apiFailure, LabDecodeFailure } from './labErrors';
import type { LabArgs, LabHandlers } from './labHandlers';
import { projectSummary, type LabProject, type LabState } from './labState';
import type { LabSessions } from './sessionRuntime';

/**
 * The four classic `api.rs` commands the workspace shell needs, with the same
 * top-level argument names as `client.ts` sends. Other classic routes stay in
 * `mockClient.ts`.
 */
function stringArgument(args: LabArgs, name: string): string {
  const value = args[name];
  if (value === undefined) throw new LabDecodeFailure('missing', name, true);
  if (typeof value !== 'string') throw new LabDecodeFailure(`invalid type: expected a string`, name);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) throw apiFailure('INVALID_ARGUMENT');
  return value as T;
}

function bootstrap(state: LabState): AppSnapshot {
  return {
    appVersion: state.appVersion,
    safeMode: state.safeMode,
    preferences: { ...state.preferences },
    // The host-owned Chats workspace is a separate UI scope, never a user project.
    projects: state.projects.filter((project) => !project.personal).map(projectSummary),
  };
}

function updatePreferences(state: LabState, args: LabArgs): Preferences {
  const next: Preferences = {
    theme: oneOf(stringArgument(args, 'theme'), ['system', 'dark', 'light']),
    density: oneOf(stringArgument(args, 'density'), ['comfortable', 'compact']),
    reducedMotion: oneOf(stringArgument(args, 'reducedMotion'), ['system', 'reduce']),
    fontSize: oneOf(stringArgument(args, 'fontSize'), ['small', 'medium', 'large']),
    chatWidth: oneOf(stringArgument(args, 'chatWidth'), ['wide', 'centered', 'focused']),
  };
  state.preferences = next;
  return { ...next };
}

/** The lab "folder picker" registers a new, restricted sandbox project every time. */
function pickAndAddProject(runtime: LabSessions, args: LabArgs): ProjectSummary {
  const agentKind = oneOf<AgentKind>(stringArgument(args, 'agentKind'), ['pi', 'prime-agent']);
  const { state } = runtime;
  const serial = state.projects.filter((project) => project.name.startsWith('sandbox-')).length + 1;
  const project: LabProject = {
    id: state.ids.next('project'),
    name: `sandbox-${serial}`,
    displayPath: `~/lab/sandbox-${serial}`,
    agentKind,
    trustState: 'restricted',
    pinned: false,
    missing: false,
    personal: false,
    lastOpenedAt: runtime.clock.iso(),
  };
  state.projects.push(project);
  return projectSummary(project);
}

/** Trust revocation stops live runtimes in that project, as `set_project_trust` does. */
function setProjectTrust(runtime: LabSessions, args: LabArgs): ProjectSummary {
  const projectId = stringArgument(args, 'projectId');
  const trustState = oneOf<ProjectTrustState>(stringArgument(args, 'trustState'), ['trusted', 'restricted', 'unknown']);
  const { state } = runtime;
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (project?.personal) throw apiFailure('INVALID_ARGUMENT');
  if (project === undefined) throw apiFailure('NOT_FOUND');
  if (trustState === 'trusted' && project.missing) throw apiFailure('PROJECT_UNAVAILABLE');
  project.trustState = trustState;
  if (trustState !== 'trusted') {
    for (const record of state.sessions.values()) {
      if (record.workspaceId === projectId && record.live !== undefined) runtime.close(record);
    }
  }
  return projectSummary(project);
}

export function classicHandlers(runtime: LabSessions): LabHandlers {
  return {
    bootstrap_v10: () => bootstrap(runtime.state),
    update_preferences_v8: (args) => updatePreferences(runtime.state, args),
    pick_and_add_project_v10: (args) => pickAndAddProject(runtime, args),
    set_project_trust: (args) => setProjectTrust(runtime, args),
  };
}
