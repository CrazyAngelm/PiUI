import type { AppSnapshot, Preferences, ProjectSummary } from './types';
import { hostInvoke } from './transport';

/**
 * Preferences, folder registration and trust for the workbench shell. Same
 * host commands as the classic client, routed through the transport so the
 * browser UI Lab answers them too.
 */
function safeError(operation: string, cause: unknown): Error {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  return new Error(code ? `${operation} failed (${code}).` : `${operation} failed.`);
}

async function call<T>(operation: string, command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await hostInvoke<T>(command, args);
  } catch (cause) {
    throw safeError(operation, cause);
  }
}

export const projectsHost = {
  bootstrap(): Promise<AppSnapshot> {
    return call<AppSnapshot>('Startup', 'bootstrap_v10');
  },
  updatePreferences(preferences: Preferences): Promise<Preferences> {
    return call<Preferences>('Preference update', 'update_preferences_v8', {
      theme: preferences.theme,
      density: preferences.density,
      reducedMotion: preferences.reducedMotion,
      fontSize: preferences.fontSize,
      chatWidth: preferences.chatWidth,
    });
  },
  async pickAndAddProject(): Promise<ProjectSummary | undefined> {
    const project = await call<ProjectSummary | null>('Folder selection', 'pick_and_add_project_v10', { agentKind: 'pi' });
    return project ?? undefined;
  },
  setProjectTrust(projectId: string, trustState: 'trusted' | 'restricted'): Promise<ProjectSummary> {
    return call<ProjectSummary>('Trust update', 'set_project_trust', { projectId, trustState });
  },
  /** Changes only PiUI's label for the folder; the folder itself is untouched. */
  renameProject(projectId: string, name: string): Promise<ProjectSummary> {
    return call<ProjectSummary>('Project rename', 'rename_project', { projectId, name });
  },
  setProjectPinned(projectId: string, pinned: boolean): Promise<ProjectSummary> {
    return call<ProjectSummary>('Project pin update', 'set_project_pinned', { projectId, pinned });
  },
  /** Forgets the registry entry only; no folder or native history is deleted. */
  async removeProject(projectId: string): Promise<void> {
    await call<void>('Project removal', 'remove_project', { projectId });
  },
};

/**
 * Timestamps from the host are ISO strings, but some host paths write epoch
 * milliseconds as a string. Accept both; unknown values sort last.
 */
export function parseTimestamp(value: string | undefined): number {
  if (!value) return Number.NaN;
  if (/^\d{10,}$/.test(value)) return Number(value);
  return Date.parse(value);
}
