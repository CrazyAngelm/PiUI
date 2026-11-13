/** Optional, ephemeral, server-owned decoration. No URLs, credentials or local asset fallback.
 * Commands: nano_avatar_scope_v1 (local only), nano_avatar_load_v1 { request: { context } }.
 * The host checks generation, workspace and current entitlement throughout every request.
 */
export const NANO_AVATAR_EVENT_V1 = 'piui://nano-avatar-v1' as const;
export interface NanoAvatarScopeV1 {
  readonly protocol: 1;
  /** Account status revision, for ordering only; credit changes do not change context. */
  readonly revision: number;
  /** Opaque custody identity; null means unavailable. Never a credential. */
  readonly context: string | null;
  readonly workspaceId: string | null;
}
export const NANO_AVATAR_CLIPS = ['idle', 'think', 'work', 'wait', 'done', 'error', 'wave', 'sleep', 'talk', 'still'] as const;
export type NanoAvatarClipIdV1 = (typeof NANO_AVATAR_CLIPS)[number];
export interface NanoAvatarClipV1 {
  readonly row: number;
  readonly frames: number;
  readonly ms: number | null;
  readonly desync?: boolean;
  readonly repeat?: number;
  readonly still?: number;
  readonly hold?: { readonly frames: readonly number[]; readonly ms: number };
}
export interface NanoAvatarManifestV1 {
  readonly schemaVersion: 1;
  readonly avatarId: string;
  readonly name: string;
  readonly renderer: 'nano-atlas';
  readonly rendererVersion: 1;
  readonly media: { readonly variant: 'atlas'; readonly sha256: string; readonly mimeType: 'image/webp'; readonly byteCount: number };
  readonly atlas: { readonly cellWidth: 192; readonly cellHeight: 208; readonly columns: 8; readonly rows: 9 };
  readonly clips: Readonly<Record<NanoAvatarClipIdV1, NanoAvatarClipV1>>;
}
export interface NanoAvatarAnswerV1 {
  readonly scope: NanoAvatarScopeV1;
  readonly avatar: { readonly manifest: NanoAvatarManifestV1; readonly mediaBase64: string } | null;
}
/** Existing server generator result bound: HermesAvatarBuilderClient.MaxResultBytes. */
export const NANO_AVATAR_MAX_BYTES = 16 * 1024 * 1024;
