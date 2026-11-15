import type { InteractiveAnswersSettingsV1, InteractiveAnswersUpdateRequest } from '../../../../../contracts/interactive-answers-v1';
import { boolean, decodeArgument, object } from './labSchema';
import type { LabHandlers } from './labHandlers';

const KEY = 'piui.lab.interactive-answers.v1';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Mirrors the host's persisted instruction preference, including safe-mode refusal. */
export function interactiveAnswersHandlers(state: { safeMode: boolean }, storage: PreferenceStorage | undefined = browserStorage()): LabHandlers {
  let enabled = true;
  try { enabled = storage?.getItem(KEY) !== 'v1|off'; } catch { /* Default on, as in the index. */ }
  const settings = (): InteractiveAnswersSettingsV1 => ({ protocol: 1, enabled: enabled && !state.safeMode, readOnly: state.safeMode });
  return {
    interactive_answers_settings_v1: args => {
      decodeArgument<Record<string, never>>(args, 'request', object({}));
      return settings();
    },
    interactive_answers_update_v1: args => {
      const change = decodeArgument<InteractiveAnswersUpdateRequest>(args, 'request', object({ enabled: boolean }));
      if (state.safeMode) throw { code: 'read-only' };
      try { storage?.setItem(KEY, change.enabled ? 'v1|on' : 'v1|off'); }
      catch { throw { code: 'io' }; }
      enabled = change.enabled;
      return settings();
    },
  };
}
