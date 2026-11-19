/**
 * Work location v1 (unified-shell plan): where work runs and whose data the shell shows.
 *
 * A location is an owner of execution and data. It is not a window, a harness
 * or a model source. Changing the active location changes what the shell
 * shows. It never sends a draft, transfers a file, repeats a turn or stops
 * work that is running in another location.
 *
 * - `local`: this Desktop installation. Native harnesses and the Rust host own
 *   its sessions, history and files. It needs no account and is the only
 *   location while signed out and in safe mode.
 * - `cloud`: one Nano account's profile in one workspace. The Nano server owns
 *   its conversations, files and runs. The identifiers are the server's own:
 *   `accountId` is `NanoUserV1.id` and `workspaceId` is `NanoWorkspaceV1.id`
 *   (nano-server-v1.ts); `profileId` is the server profile that owns the
 *   account's data in that workspace. A display name, an e-mail address, a
 *   session title or a project name is never part of an identity.
 *
 * A connected execution host ("another device") is not part of v1: its
 * registration, authority and transport are unresolved (unified-shell plan). Adding it
 * needs a new version of this contract.
 *
 * The WebView never derives a cloud identity by itself. The Rust host reports
 * it together with the account generation it was read under.
 *
 * Only the pure types and the location key live here for now: the graph kernel
 * (nano-graph-kernel-v2.ts) freezes a location binding with them. The WebView
 * guards, the fixtures and the host commands that report a location belong to
 * the unified shell and are not part of this file.
 */

export const WORK_LOCATION_PROTOCOL = 1 as const;

export interface LocalWorkLocationV1 {
  readonly kind: 'local';
}

export interface CloudWorkLocationV1 {
  readonly kind: 'cloud';
  /** `NanoUserV1.id` of the signed-in account. */
  readonly accountId: string;
  /** `NanoWorkspaceV1.id`. */
  readonly workspaceId: string;
  /** Server-issued and opaque: the profile that owns this account's data in the workspace. */
  readonly profileId: string;
}

export type WorkLocationV1 = LocalWorkLocationV1 | CloudWorkLocationV1;
export type WorkLocationKindV1 = WorkLocationV1['kind'];

/**
 * The stable key of a location: the JSON text of an array of its kind and
 * owner identifiers in the order below. Two locations have the same key
 * exactly when every identifier is equal. Storage, caches, drafts and request
 * fences use this key, never a name.
 */
export type LocationKeyV1 = string;

export const LOCAL_LOCATION_KEY_V1: LocationKeyV1 = '["local"]';

export function workLocationKeyV1(location: WorkLocationV1): LocationKeyV1 {
  return location.kind === 'local'
    ? LOCAL_LOCATION_KEY_V1
    : JSON.stringify(['cloud', location.accountId, location.workspaceId, location.profileId]);
}

/**
 * The part of a fence the Rust host can verify. The host receives it with
 * every account-scoped command, refuses the command when it is not the host's
 * current location and account generation, and repeats it in the answer and
 * in every event of that command's stream.
 */
export interface HostFenceV1 {
  readonly location: LocationKeyV1;
  /**
   * The host account generation (`AccountGeneration` of `piui-nano`) the
   * request started under. It ends at sign-out, expiry, device revocation and
   * a new sign-in. Selecting another workspace keeps it; the location key
   * changes instead. It counts within the running host process and starts
   * again when the host restarts, so nothing bound to it is persisted.
   * `null` exactly for the local location; otherwise the WebView accepts only
   * a non-negative safe integer.
   */
  readonly accountGeneration: number | null;
}

/**
 * Binds a request, its answer and every event of its stream to the owner that
 * issued it. An answer or event whose fence differs from the current one in
 * any field is dropped: it is not displayed, stored or acted on.
 */
export interface RequestFenceV1 extends HostFenceV1 {
  /**
   * Generation of the presentation owner that issued the request: it advances
   * whenever the shell or a view is bound to another location or owner. Kept
   * in the WebView; the host never sees or vouches for it.
   */
  readonly ownerGeneration: number;
}

/**
 * A server data family the cloud location offers. The set is closed in v1: the
 * host does not report a family this contract does not name.
 */
export type CloudFamilyIdV1 = 'conversations';

export interface CloudFamilyV1 {
  readonly id: CloudFamilyIdV1;
  readonly version: 1;
}

/**
 * What the host reports about the cloud location it can address now. Absent
 * (the command answers `null`) while signed out, in safe mode, without a
 * selected workspace, without the cloud entitlement or before the server
 * resolved the profile.
 */
export interface CloudLocationContextV1 {
  readonly location: CloudWorkLocationV1;
  /** The generation the context was read under: the fence of every request in this location. */
  readonly accountGeneration: number;
  /**
   * Declared by the server and allowed by the account's entitlements, each
   * family once. An unknown family id or version, or a repeated family, makes
   * the whole context invalid: the WebView refuses it and offers no cloud.
   */
  readonly families: readonly CloudFamilyV1[];
}
