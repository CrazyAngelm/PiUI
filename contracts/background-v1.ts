/** Background mode contract v1: tray icon, keeping PiUI running in the tray
 * when its window is closed, and starting PiUI at sign-in.
 *
 * Both behaviors are off until a person turns them on. The WebView has no
 * tray, autostart-plugin or OS permission: it calls these host commands and
 * the host applies the change. "Start at sign-in" reports the OS registration
 * itself; only "keep in tray" is a PiUI preference. Safe mode is read-only
 * and never shows a tray. The tray menu offers Open PiUI, Pause all
 * automations / Resume automations (orchestration host v7.2) and Quit, which
 * stops every harness process before PiUI exits.
 */

export interface BackgroundSettingsV1 {
  readonly protocol: 1;
  /** Closing the window keeps PiUI running in the tray. */
  readonly keepInTray: boolean;
  /** PiUI is registered to start when the person signs in to the OS. */
  readonly launchAtLogin: boolean;
  /** A tray can be offered in this session (false in safe mode). */
  readonly trayAvailable: boolean;
  /** Sign-in registration is available on this platform and build. */
  readonly launchAtLoginAvailable: boolean;
  /** Safe mode: shown, not changeable. */
  readonly readOnly: boolean;
}

export type BackgroundSettingsRequest = Readonly<Record<string, never>>;

/** Exactly the fields a person changed; at least one. */
export interface BackgroundUpdateRequest {
  readonly keepInTray?: boolean;
  readonly launchAtLogin?: boolean;
}

/**
 * Tray menu copy from the UI's locale catalog. Each label is trimmed, 1-80
 * characters and free of control characters; `&` is shown literally.
 */
export interface TrayLabelsV1 {
  readonly open: string;
  readonly pause: string;
  readonly resume: string;
  readonly quit: string;
  readonly tooltip: string;
  readonly pausedTooltip: string;
}

export type BackgroundErrorCode = 'invalid' | 'read-only' | 'unavailable' | 'io';

export interface BackgroundHostCommandsV1 {
  background_settings_v1(request: BackgroundSettingsRequest): Promise<BackgroundSettingsV1>;
  background_update_v1(request: BackgroundUpdateRequest): Promise<BackgroundSettingsV1>;
  background_tray_labels_v1(request: TrayLabelsV1): Promise<void>;
}
