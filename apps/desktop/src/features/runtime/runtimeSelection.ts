import type { ModelLite } from '../../host-api/types';

export interface SessionRuntimePreference {
  key: string;
  model?: ModelLite;
  thinkingLevel?: string;
  updatedAt: number;
}

export interface InitialRuntimeSelection {
  pendingModel?: ModelLite;
  pendingThinkingLevel?: string;
  rememberedModel?: ModelLite;
  rememberedThinkingLevel?: string;
}

const MAX_SESSION_RUNTIME_PREFERENCES = 256;

export function runtimeSessionKey(
  personal: boolean,
  projectId: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  if (personal) return `personal:${sessionId}`;
  return projectId === undefined || projectId.length === 0
    ? undefined
    : `project:${projectId}:${sessionId}`;
}

export function initialRuntimeSelection(
  sessionKey: string | undefined,
  sessionPreferences: readonly SessionRuntimePreference[],
  globalModel: ModelLite | undefined,
  globalModelExplicit: boolean,
  globalThinkingLevel: string | undefined,
  globalThinkingExplicit: boolean,
): InitialRuntimeSelection {
  if (sessionKey === undefined) {
    return {
      pendingModel: globalModelExplicit ? globalModel : undefined,
      pendingThinkingLevel: globalThinkingExplicit ? globalThinkingLevel : undefined,
    };
  }

  const remembered = sessionPreferences.find((preference) => preference.key === sessionKey);
  return {
    rememberedModel: remembered?.model,
    rememberedThinkingLevel: remembered?.thinkingLevel,
  };
}

export function rememberSessionRuntimePreference(
  preferences: readonly SessionRuntimePreference[],
  preference: SessionRuntimePreference,
): SessionRuntimePreference[] {
  const retained = preferences.filter((candidate) => candidate.key !== preference.key);
  retained.push(preference);
  return retained.slice(-MAX_SESSION_RUNTIME_PREFERENCES);
}
