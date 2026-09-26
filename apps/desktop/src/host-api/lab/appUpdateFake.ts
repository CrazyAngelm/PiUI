import {
  APP_UPDATE_EVENT,
  type AppUpdateAvailableV1,
  type AppUpdateAutoCheckRequestV1,
  type AppUpdateErrorCodeV1,
  type AppUpdateEventV1,
  type AppUpdateInstallRequestV1,
  type AppUpdateLastCheckV1,
  type AppUpdatePhaseV1,
  type AppUpdateStatusV1,
} from '../../../../../contracts/app-update-v1';
import type { LabEventBus } from './labBus';
import type { LabClock } from './labClock';
import type { LabHandlers } from './labHandlers';
import { boolean, decodeArgument, object, string } from './labSchema';

/**
 * App update v1 in the UI Lab. Nothing is downloaded, verified or installed:
 * the fake answers with the host's shapes and events after short simulated
 * delays. Pick a state with `?updates=`:
 *
 * - `off` (default): a build without updater keys, as local builds are;
 * - `current`: configured; a check finds nothing newer;
 * - `available`: configured with automatic checks on; the last automatic check
 *   found 0.2.1, and "Download and restart" simulates the download;
 * - `failing`: configured; every check fails as if offline;
 * - `bad-signature`: configured; 0.2.1 is offered but its download fails the
 *   signature check, so nothing installs;
 * - `install-fails`: configured; 0.2.1 downloads, but the installer does not
 *   start after the agents stopped (Windows), so PiUI offers a restart.
 */
export const LAB_UPDATE_SCENARIOS = ['off', 'current', 'available', 'failing', 'bad-signature', 'install-fails'] as const;
export type LabUpdateScenario = (typeof LAB_UPDATE_SCENARIOS)[number];

export const LAB_APP_VERSION = '0.2.0';
const CHECK_MS = 700;
const DOWNLOAD_STEP_MS = 160;
const DOWNLOAD_STEPS = 10;
const DOWNLOAD_BYTES = 12 * 1024 * 1024;

const LAB_OFFER: AppUpdateAvailableV1 = {
  version: '0.2.1',
  date: '2026-09-26T18:00:00Z',
  notes:
    'Fixes and polish for the 0.2 line.\n\n' +
    '- Runs: the step panel keeps its width after a restart.\n' +
    '- Chat: the model picker lists new Codex models.\n' +
    '- Automations: day-of-week schedules show the next run in your time zone.',
};

export function updateScenarioFromSearch(search: string): LabUpdateScenario {
  const requested = new URLSearchParams(search).get('updates');
  return LAB_UPDATE_SCENARIOS.find((name) => name === requested) ?? 'off';
}

function refusal(code: AppUpdateErrorCodeV1): { readonly code: AppUpdateErrorCodeV1 } {
  return { code };
}

export function appUpdateHandlers(scenario: LabUpdateScenario, bus: LabEventBus, clock: LabClock): LabHandlers {
  const configured = scenario !== 'off';
  let autoCheck = scenario === 'available';
  let phase: AppUpdatePhaseV1 = 'idle';
  let available: AppUpdateAvailableV1 | null = scenario === 'available' ? LAB_OFFER : null;
  let lastCheck: AppUpdateLastCheckV1 | null =
    scenario === 'available' ? { at: clock.iso(), automatic: true, outcome: 'available', error: null } : null;

  const status = (): AppUpdateStatusV1 => ({
    protocol: 1,
    configured,
    currentVersion: LAB_APP_VERSION,
    feedHost: configured ? 'github.com' : null,
    autoCheck: configured && autoCheck,
    phase,
    lastCheck,
    available,
  });
  const emit = (event: AppUpdateEventV1): void => bus.emit(APP_UPDATE_EVENT, event);
  const publish = (): AppUpdateStatusV1 => {
    const current = status();
    emit({ type: 'status', status: current });
    return current;
  };
  const admit = (): void => {
    if (!configured) throw refusal('not-configured');
    if (phase !== 'idle') throw refusal('busy');
  };

  return {
    app_update_status_v1: () => status(),
    app_update_check_v1: async () => {
      admit();
      phase = 'checking';
      publish();
      await clock.delay(CHECK_MS);
      phase = 'idle';
      const failed = scenario === 'failing';
      if (!failed) available = scenario === 'current' ? null : LAB_OFFER;
      lastCheck = {
        at: clock.iso(),
        automatic: false,
        outcome: failed ? 'failed' : available ? 'available' : 'up-to-date',
        error: failed ? 'network' : null,
      };
      const current = publish();
      if (failed) throw refusal('network');
      return current;
    },
    app_update_install_v1: async (args) => {
      const request = decodeArgument<AppUpdateInstallRequestV1>(args, 'request', object({ version: string }));
      if (!/^[0-9A-Za-z.+-]{1,64}$/.test(request.version)) throw refusal('invalid');
      admit();
      if (available?.version !== request.version) throw refusal('not-available');
      phase = 'downloading';
      publish();
      for (let step = 1; step <= DOWNLOAD_STEPS; step += 1) {
        await clock.delay(DOWNLOAD_STEP_MS);
        emit({ type: 'progress', downloadedBytes: Math.round((DOWNLOAD_BYTES * step) / DOWNLOAD_STEPS), totalBytes: DOWNLOAD_BYTES });
      }
      if (scenario === 'bad-signature') {
        phase = 'idle';
        publish();
        throw refusal('signature-invalid');
      }
      phase = 'installing';
      publish();
      await clock.delay(DOWNLOAD_STEP_MS);
      if (scenario === 'install-fails') {
        phase = 'restart-required';
        publish();
        throw refusal('install-failed');
      }
      // The desktop would restart now; the lab stays in the restarting phase.
      phase = 'restarting';
      return publish();
    },
    app_update_set_auto_check_v1: (args) => {
      const request = decodeArgument<AppUpdateAutoCheckRequestV1>(args, 'request', object({ enabled: boolean }));
      if (!configured) throw refusal('not-configured');
      autoCheck = request.enabled;
      return publish();
    },
    app_update_restart_v1: () => {
      if (phase !== 'restart-required') throw refusal('invalid');
      // The desktop restarts into the current version; the lab returns to idle.
      phase = 'idle';
      publish();
      return null;
    },
  };
}
