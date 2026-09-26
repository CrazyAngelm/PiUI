import type { BackgroundSettingsV1, BackgroundUpdateRequest, TrayLabelsV1 } from './labContracts';
import type { LabHandlers } from './labHandlers';
import { decodeArgument } from './labSchema';
import { backgroundSettingsSchema, backgroundUpdateSchema, trayLabelsSchema } from './labSchemas';
import type { LabBackground, LabState } from './labState';

/** The host's `BackgroundError` payload. */
function backgroundFailure(code: 'invalid' | 'read-only' | 'unavailable' | 'io'): { code: string } {
  return { code };
}

function background(state: LabState): LabBackground {
  state.background ??= { keepInTray: false, launchAtLogin: false };
  return state.background;
}

/** `Controller::settings`: safe mode shows the tray as off and offers no tray. */
function settings(state: LabState): BackgroundSettingsV1 {
  const current = background(state);
  return {
    protocol: 1,
    keepInTray: current.keepInTray && !state.safeMode,
    launchAtLogin: current.launchAtLogin,
    trayAvailable: !state.safeMode,
    launchAtLoginAvailable: true,
    readOnly: state.safeMode,
  };
}

function cleanLabel(value: string): string {
  const label = value.trim();
  if (label === '' || [...label].length > 80 || /\p{Cc}/u.test(label)) throw backgroundFailure('invalid');
  return label;
}

/**
 * Background mode (background-v1) in the UI Lab: the same checks and replies
 * as `background.rs`, with no tray icon and no sign-in registration.
 */
export function backgroundHandlers(state: LabState): LabHandlers {
  return {
    background_settings_v1: (args) => {
      decodeArgument<Record<string, never>>(args, 'request', backgroundSettingsSchema);
      return settings(state);
    },
    background_update_v1: (args) => {
      const change = decodeArgument<BackgroundUpdateRequest>(args, 'request', backgroundUpdateSchema);
      const keepInTray = change.keepInTray ?? undefined;
      const launchAtLogin = change.launchAtLogin ?? undefined;
      if (keepInTray === undefined && launchAtLogin === undefined) throw backgroundFailure('invalid');
      if (state.safeMode) throw backgroundFailure('read-only');
      const current = background(state);
      if (launchAtLogin !== undefined) current.launchAtLogin = launchAtLogin;
      if (keepInTray !== undefined) current.keepInTray = keepInTray;
      return settings(state);
    },
    background_tray_labels_v1: (args) => {
      const labels = decodeArgument<TrayLabelsV1>(args, 'request', trayLabelsSchema);
      background(state).trayLabels = {
        open: cleanLabel(labels.open),
        pause: cleanLabel(labels.pause),
        resume: cleanLabel(labels.resume),
        quit: cleanLabel(labels.quit),
        tooltip: cleanLabel(labels.tooltip),
        pausedTooltip: cleanLabel(labels.pausedTooltip),
      };
      return null;
    },
  };
}
