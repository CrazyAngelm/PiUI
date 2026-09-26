/**
 * App update v1: signed application updates through the Tauri updater.
 *
 * Every build answers these commands, but updates are active only when the
 * build's Tauri configuration carries `plugins.updater` with a minisign public
 * key and HTTPS endpoints (release builds add it with `tauri build --config`).
 * Otherwise `configured` is false, the updater plugin is never registered,
 * nothing contacts the network and the About page shows no update controls.
 *
 * - Automatic checks run only while `autoCheck` is on (off by default, saved by
 *   the host), start well after the window opened, never in safe mode, and
 *   never install anything.
 * - `app_update_install_v1` installs only the version the last check found
 *   (the one the person confirmed). The updater verifies the download's
 *   minisign signature against the built-in public key before anything is
 *   written or run. Native runtimes stop as on quit; PiUI then restarts
 *   (Windows: the installer restarts it).
 * - Release notes are plain text from the release feed; never render them as
 *   HTML or Markdown.
 *
 * Commands: `app_update_status_v1` (never touches the network),
 * `app_update_check_v1`, `app_update_install_v1`, `app_update_set_auto_check_v1`
 * and `app_update_restart_v1` (only after an install that could not start).
 * Requests reject unknown fields; failures reject with `{code}`.
 * Events: `APP_UPDATE_EVENT` carries `AppUpdateEventV1`.
 */

export const APP_UPDATE_PROTOCOL = 1;
export const APP_UPDATE_EVENT = 'piui://app-update';

/**
 * `restarting`: Linux/macOS replaced the bundle and PiUI is restarting.
 * `restart-required`: Windows stopped the agents but the installer did not
 * start; `app_update_restart_v1` restarts into the current version.
 */
export type AppUpdatePhaseV1 = 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'restart-required';

export type AppUpdateCheckOutcomeV1 = 'up-to-date' | 'available' | 'failed';

export type AppUpdateErrorCodeV1 =
  | 'invalid'
  | 'not-configured'
  | 'busy'
  | 'shutting-down'
  | 'not-available'
  | 'network'
  | 'feed-invalid'
  | 'platform-missing'
  | 'check-failed'
  | 'download-failed'
  | 'signature-invalid'
  | 'install-failed'
  | 'settings-failed';

export interface AppUpdateLastCheckV1 {
  /** RFC 3339, UTC. */
  readonly at: string;
  readonly automatic: boolean;
  readonly outcome: AppUpdateCheckOutcomeV1;
  readonly error: AppUpdateErrorCodeV1 | null;
}

export interface AppUpdateAvailableV1 {
  readonly version: string;
  /** RFC 3339, UTC, when the feed names a valid date. */
  readonly date: string | null;
  /** Plain text, at most 16 KiB characters. */
  readonly notes: string | null;
}

export interface AppUpdateStatusV1 {
  readonly protocol: typeof APP_UPDATE_PROTOCOL;
  readonly configured: boolean;
  readonly currentVersion: string;
  /** Host of the update feed; null when not configured. */
  readonly feedHost: string | null;
  readonly autoCheck: boolean;
  readonly phase: AppUpdatePhaseV1;
  readonly lastCheck: AppUpdateLastCheckV1 | null;
  /** The newer version the last successful check found, if any. */
  readonly available: AppUpdateAvailableV1 | null;
}

export interface AppUpdateInstallRequestV1 {
  /** Exactly `available.version`. */
  readonly version: string;
}

export interface AppUpdateAutoCheckRequestV1 {
  readonly enabled: boolean;
}

export interface AppUpdateErrorV1 {
  readonly code: AppUpdateErrorCodeV1;
}

export type AppUpdateEventV1 =
  | { readonly type: 'status'; readonly status: AppUpdateStatusV1 }
  | { readonly type: 'progress'; readonly downloadedBytes: number; readonly totalBytes: number | null };

export interface AppUpdateCommandsV1 {
  app_update_status_v1(): Promise<AppUpdateStatusV1>;
  app_update_check_v1(): Promise<AppUpdateStatusV1>;
  app_update_install_v1(args: { request: AppUpdateInstallRequestV1 }): Promise<AppUpdateStatusV1>;
  app_update_set_auto_check_v1(args: { request: AppUpdateAutoCheckRequestV1 }): Promise<AppUpdateStatusV1>;
  app_update_restart_v1(): Promise<null>;
}
