import { mount, unmount } from 'svelte';
import { language, loadRussian } from '../../../../apps/desktop/src/features/locale/language';
import { stylePreference } from '../../../../apps/desktop/src/styles/stylePreference.svelte';
import '../../../../apps/desktop/src/styles/reset.css';
import '../../../../apps/desktop/src/styles/tokens.css';
import '../../../../apps/desktop/src/styles/app.css';
import '../../../../apps/desktop/src/styles/motion.css';
import './remote.css';
import RemoteGate from './RemoteGate.svelte';
import { RemoteConnection, shellMatches, type ClosedReason, type ConnectionState } from './connection';
import { gateModel } from './gateModel.svelte';
import { viewForState, type GateView } from './gateView';
import { browserLabel, openIdentity, type ViewerIdentity } from './identity';
import { createAttemptCounter, parseLaunch, retryDelay, viewerSocketUrl, type GateTheme } from './launch';
import { installRemoteConnection } from './transport';

/**
 * Entry of the Nano Web remote bundle (ADR-062). The host page supplies a device
 * id in the URL fragment and nothing else; the cookie session of the same origin
 * authorizes the relay socket. The desktop shell mounts only after the computer
 * welcomed this browser and agrees on the shell contract numbers.
 */

/** The host page owns appearance: nothing the remote preferences say may change it. */
function holdTheme(theme: GateTheme): void {
  const root = document.documentElement;
  const apply = (): void => {
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

async function main(target: HTMLElement): Promise<void> {
  const launch = parseLaunch(location.hash);
  const attempts = createAttemptCounter(sessionStorageOrUndefined());
  stylePreference.apply();
  holdTheme(launch?.theme ?? 'system');
  const requested = launch?.language ?? 'ru';
  gateModel.language = requested;
  language.set(requested);
  // The gate has its own copy; only the shell waits for the Russian catalog.
  const catalog = requested === 'ru' ? loadRussian().catch(() => undefined) : Promise.resolve();

  let gate: ReturnType<typeof mount> | undefined;
  let shell: ReturnType<typeof mount> | undefined;
  const showGate = (): void => {
    gate ??= mount(RemoteGate, { target, props: { onReconnect: () => location.reload() } });
  };
  const hideGate = async (): Promise<void> => {
    const current = gate;
    gate = undefined;
    if (current !== undefined) await unmount(current);
  };
  const hideShell = async (): Promise<void> => {
    const current = shell;
    shell = undefined;
    installRemoteConnection(undefined);
    if (current !== undefined) await unmount(current);
  };
  const show = (view: GateView): void => {
    gateModel.view = view;
    gateModel.retryIn = undefined;
    showGate();
  };

  showGate();
  if (launch === undefined) {
    show({ kind: 'disconnected', reason: 'protocol' });
    return;
  }

  let identity: ViewerIdentity;
  try {
    identity = await openIdentity();
  } catch {
    show({ kind: 'unsupported' });
    return;
  }
  gateModel.memoryKey = !identity.persistent;

  const connection = new RemoteConnection({
    url: viewerSocketUrl(location, launch.device),
    deviceId: launch.device,
    identity,
    label: browserLabel(),
  });

  const scheduleRetry = (reason: ClosedReason): void => {
    const seconds = retryDelay(reason, attempts.read());
    if (seconds === undefined) return;
    attempts.increment();
    gateModel.retryIn = seconds;
    const timer = setInterval(() => {
      const left = gateModel.retryIn;
      if (left === undefined) return clearInterval(timer);
      if (left <= 1) {
        clearInterval(timer);
        location.reload();
      } else gateModel.retryIn = left - 1;
    }, 1000);
  };

  let sequence = 0;
  const apply = async (state: ConnectionState): Promise<void> => {
    const ticket = ++sequence;
    const view = viewForState(state);
    if (view !== undefined) {
      await hideShell();
      if (ticket !== sequence) return;
      show(view);
      if (state.kind === 'closed') scheduleRetry(state.reason);
      return;
    }
    if (state.kind !== 'welcomed') return; // This side closed on purpose; the screen is already set.
    if (!shellMatches(state.welcome.shell)) {
      show({ kind: 'versions' });
      connection.close();
      return;
    }
    installRemoteConnection(connection);
    try {
      const [{ default: AppShell }] = await Promise.all([import('../../../../apps/desktop/src/app/shell/AppShell.svelte'), catalog]);
      if (ticket !== sequence) return;
      await hideGate();
      if (ticket !== sequence) return;
      attempts.reset();
      shell = mount(AppShell, { target });
    } catch {
      // The shell chunk did not load: treat it like a lost connection.
      connection.close();
      installRemoteConnection(undefined);
      show({ kind: 'disconnected', reason: 'network' });
      scheduleRetry('network');
    }
  };

  connection.onState((state) => {
    void apply(state);
  });
  connection.start();
}

const target = document.getElementById('app');
if (target === null) throw new Error('Nano remote could not find the application root.');
void main(target);
