import type { AcpAgentEntryV1, HarnessState } from '../../../../../contracts/harness-registry-v1';
import { isAcpHarness, type BuiltinHarness, type HarnessId } from '../../../../../contracts/harness-identity-v3';
import type { HarnessConnectInfoV1 } from '../../../../../contracts/harness-connect-v1';
import { harnessConnectError, harnessConnectHost, type HarnessConnectClient } from '../../host-api/harnessConnect';
import type { Status } from '../../lib/ui';
import { stateBadge } from './acpAgents';

/**
 * Settings → Harnesses → Connect (ADR-054). Every harness signs in with its
 * own tools; Nano Desktop only shows how and, where the host can, opens a
 * terminal for it. It never reads or stores another harness's credentials.
 */

/**
 * What the dialog shows when the host has not described a harness yet (or the
 * command is missing): display text only, never run, and never offering the
 * terminal. The host's `describe` is the source of truth.
 */
const FALLBACK: Readonly<Partial<Record<BuiltinHarness, Omit<HarnessConnectInfoV1, 'terminal'>>>> = {
  pi: { harness: 'pi', command: 'pi', then: '/login' },
  codex: { harness: 'codex', command: 'codex login' },
  'claude-code': { harness: 'claude-code', command: 'claude', then: '/login' },
};

export type ConnectGuide =
  | { kind: 'nano' }
  /** Added ACP agent: its descriptor hint, the offered methods and the secret variables. */
  | { kind: 'acp' }
  /** A command to run in a terminal; `info.terminal` says whether the host can open one. */
  | { kind: 'terminal'; info: HarnessConnectInfoV1 }
  /** Nothing to run: one line of guidance. */
  | { kind: 'guidance' };

/** `infos` is `undefined` until `describe` answers, and stays so when it fails (copy-only). */
export function connectGuide(harness: HarnessId, infos: readonly HarnessConnectInfoV1[] | undefined): ConnectGuide {
  if (harness === 'nano') return { kind: 'nano' };
  if (isAcpHarness(harness)) return { kind: 'acp' };
  if (infos === undefined) {
    const fallback = FALLBACK[harness];
    return fallback === undefined ? { kind: 'guidance' } : { kind: 'terminal', info: { ...fallback, terminal: false } };
  }
  const info = infos.find((entry) => entry.harness === harness);
  return info === undefined ? { kind: 'guidance' } : { kind: 'terminal', info };
}

// ---- Row presentation -----------------------------------------------------------

/** The status dot of a row. Its text shows only when the harness is not ready. */
export function rowStatus(state: HarnessState, safeMode: boolean): { dot: Status; label: string; ready: boolean } {
  const { label } = stateBadge(state, safeMode);
  const ready = state === 'ready';
  switch (state) {
    case 'ready': return { dot: 'done', label, ready };
    case 'checking': return { dot: safeMode ? 'offline' : 'running', label, ready };
    case 'not-installed': return { dot: 'offline', label, ready };
    case 'unavailable': return { dot: 'failed', label, ready };
    case 'unsupported-version':
    case 'unverified-version':
    case 'sign-in-required':
    case 'untrusted': return { dot: 'waiting', label, ready };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** A built-in harness that is not installed has nothing to sign in to. */
export const canConnectBuiltin = (state: HarnessState): boolean => state !== 'not-installed';
/** An agent must be trusted before it can run, so signing in comes after the trust review. */
export const canConnectAgent = (agent: AcpAgentEntryV1): boolean => agent.state !== 'not-installed' && agent.state !== 'untrusted';
/** Connect is the main action only when the harness says it needs a sign-in. */
export const connectIsPrimary = (state: HarnessState): boolean => state === 'sign-in-required';

// ---- Store ------------------------------------------------------------------------

export class HarnessConnectStore {
  /** The harnesses the host can open a terminal for; `undefined` until described or when that failed. */
  infos = $state.raw<readonly HarnessConnectInfoV1[]>();
  busy = $state(false);
  /** A fixed English locale key of the last failed `openTerminal`. */
  error = $state<string>();
  /** The harness a terminal was just opened for. */
  opened = $state<BuiltinHarness>();

  private describing: Promise<void> | undefined;
  private disposed = false;
  /** Bumped by every attempt and every reset, so a stale completion is ignored. */
  private epoch = 0;

  constructor(private readonly client: HarnessConnectClient = harnessConnectHost) {}

  /** Asks the host once per mount. Failure leaves the dialogs copy-only. */
  describe(): Promise<void> {
    this.describing ??= this.client.describe().then(
      (infos) => {
        if (!this.disposed) this.infos = infos;
      },
      () => undefined,
    );
    return this.describing;
  }

  dispose(): void {
    this.disposed = true;
  }

  guide(harness: HarnessId): ConnectGuide {
    return connectGuide(harness, this.infos);
  }

  /**
   * A dialog opened or closed: forget the previous attempt. A terminal request
   * still pending belongs to that attempt, so its outcome is dropped.
   */
  reset(): void {
    this.epoch += 1;
    this.busy = false;
    this.error = undefined;
    this.opened = undefined;
  }

  async open(harness: BuiltinHarness): Promise<void> {
    if (this.busy) return;
    const epoch = ++this.epoch;
    this.busy = true;
    this.error = undefined;
    this.opened = undefined;
    try {
      await this.client.openTerminal(harness);
      if (!this.disposed && epoch === this.epoch) this.opened = harness;
    } catch (cause) {
      if (!this.disposed && epoch === this.epoch) this.error = harnessConnectError(cause).message;
    } finally {
      if (!this.disposed && epoch === this.epoch) this.busy = false;
    }
  }
}
