import { describe, expect, it } from 'vitest';
import type { ModelLite } from '../../host-api/types';
import {
  initialRuntimeSelection,
  rememberSessionRuntimePreference,
  runtimeSessionKey,
  type SessionRuntimePreference,
} from './runtimeSelection';

const globalModel: ModelLite = { provider: 'global-provider', id: 'global-model' };
const sessionModel: ModelLite = { provider: 'session-provider', id: 'session-model' };

describe('runtime selection ownership', () => {
  it('uses global explicit choices only for a brand-new chat', () => {
    const selection = initialRuntimeSelection(
      undefined,
      [],
      globalModel,
      true,
      'max',
      true,
    );

    expect(selection.pendingModel).toEqual(globalModel);
    expect(selection.pendingThinkingLevel).toBe('max');
    expect(selection.rememberedModel).toBeUndefined();
  });

  it('restores display metadata for an existing session without overriding Pi on start', () => {
    const key = 'project:project-1:session-1';
    const preferences: SessionRuntimePreference[] = [{
      key,
      model: sessionModel,
      thinkingLevel: 'high',
      updatedAt: 10,
    }];

    const selection = initialRuntimeSelection(
      key,
      preferences,
      globalModel,
      true,
      'max',
      true,
    );

    expect(selection.rememberedModel).toEqual(sessionModel);
    expect(selection.rememberedThinkingLevel).toBe('high');
    expect(selection.pendingModel).toBeUndefined();
    expect(selection.pendingThinkingLevel).toBeUndefined();
  });

  it('keeps project and personal session keys separate and updates one bounded record', () => {
    const projectKey = runtimeSessionKey(false, 'project-1', 'session-1');
    const personalKey = runtimeSessionKey(true, undefined, 'session-1');
    expect(projectKey).toBe('project:project-1:session-1');
    expect(personalKey).toBe('personal:session-1');

    const first = rememberSessionRuntimePreference([], {
      key: projectKey!,
      model: sessionModel,
      thinkingLevel: 'medium',
      updatedAt: 1,
    });
    const updated = rememberSessionRuntimePreference(first, {
      key: projectKey!,
      model: sessionModel,
      thinkingLevel: 'high',
      updatedAt: 2,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ thinkingLevel: 'high', updatedAt: 2 });
  });
});
