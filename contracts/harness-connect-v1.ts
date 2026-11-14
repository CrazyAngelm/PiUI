/**
 * PiUI harness connect protocol v1 (ADR-054): Settings → Harnesses → Connect.
 *
 * One command, `harness_connect_v1`. `describe` lists the harnesses whose own
 * sign-in command the host can open in a terminal; `openTerminal` opens it.
 * The WebView sends only a harness name: the host owns the program path (the
 * same resolution that launches the harness) and the fixed arguments. No shell
 * is used, no credential is read, and `openTerminal` is refused in safe mode.
 * Sign-in itself happens in the harness's own CLI.
 */
import type { BuiltinHarness } from './harness-identity-v3';

export const HARNESS_CONNECT_PROTOCOL = 1 as const;

export interface HarnessConnectInfoV1 {
  harness: BuiltinHarness;
  /** Display text only: `codex login`, `claude`, `pi`. Never a resolved path. */
  command: string;
  /** Typed inside the CLI once it runs: `/login`. */
  then?: string;
  /** The host can open a terminal for it now (installed, supported platform, not safe mode). */
  terminal: boolean;
}

export type HarnessConnectCommandV1 = { type: 'describe' } | { type: 'openTerminal'; harness: BuiltinHarness };

export type HarnessConnectResultV1 =
  | { protocol: 1; type: 'described'; harnesses: HarnessConnectInfoV1[] }
  | { protocol: 1; type: 'opened'; harness: BuiltinHarness };

export type HarnessConnectErrorCodeV1 = 'SAFE_MODE' | 'NOT_SUPPORTED' | 'NOT_INSTALLED' | 'NO_TERMINAL' | 'LAUNCH_FAILED';

export interface HarnessConnectErrorV1 {
  code: HarnessConnectErrorCodeV1;
  message: string;
  recoverable: boolean;
}
