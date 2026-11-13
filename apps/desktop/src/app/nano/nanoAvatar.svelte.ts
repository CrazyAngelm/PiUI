import { nanoAvatarHost, type NanoAvatarAnswerV1, type NanoAvatarClient, type NanoAvatarManifestV1, type NanoAvatarScopeV1 } from '../../host-api/nanoAvatarClient';

export interface ReadyAvatar { readonly manifest: NanoAvatarManifestV1; readonly bitmap: ImageBitmap }
export type AvatarDecoder = (avatar: NonNullable<NanoAvatarAnswerV1['avatar']>) => Promise<ReadyAvatar>;

/** Decodes in memory without an image URL, fetch, filesystem write, or CSP exception. */
export const decodeAvatar: AvatarDecoder = async (avatar) => {
  const bytes = Uint8Array.from(atob(avatar.mediaBase64), (character) => character.charCodeAt(0));
  if (bytes.length !== avatar.manifest.media.byteCount) throw new Error('Invalid avatar media');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== avatar.manifest.media.sha256) throw new Error('Invalid avatar media');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: avatar.manifest.media.mimeType }));
  const { atlas } = avatar.manifest;
  if (bitmap.width !== atlas.cellWidth * atlas.columns || bitmap.height !== atlas.cellHeight * atlas.rows) {
    bitmap.close();
    throw new Error('Invalid avatar dimensions');
  }
  return { manifest: avatar.manifest, bitmap };
};

/** Shared decoration only while a visible, entitled chat owns it. No timers or polling. */
export class NanoAvatar {
  ready = $state.raw<ReadyAvatar | undefined>();
  private scope: NanoAvatarScopeV1 | undefined;
  private stop: (() => void) | undefined;
  private users = 0;
  private epoch = 0;

  constructor(private readonly client: NanoAvatarClient, private readonly decode: AvatarDecoder = decodeAvatar) {}

  acquire(): () => void {
    this.users += 1;
    if (this.users === 1) void this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      if (this.users === 0) {
        this.epoch += 1;
        this.stop?.();
        this.stop = undefined;
        this.scope = undefined;
        this.clear();
      }
    };
  }
  private clear(): void { this.ready?.bitmap.close(); this.ready = undefined; }
  private async start(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const stop = await this.client.subscribe((scope) => { if (epoch === this.epoch) this.accept(scope); });
      if (epoch !== this.epoch) { stop(); return; }
      this.stop = stop;
      const scope = await this.client.scope();
      if (epoch === this.epoch) this.accept(scope);
    } catch { if (epoch === this.epoch) this.clear(); }
  }
  private accept(scope: NanoAvatarScopeV1): void {
    if (this.scope && scope.revision < this.scope.revision) return;
    const same = this.scope?.context === scope.context && this.scope?.workspaceId === scope.workspaceId;
    this.scope = scope;
    if (same) return;
    this.clear();
    if (scope.context) void this.load(scope, this.epoch);
  }
  private current(scope: NanoAvatarScopeV1, epoch: number): boolean {
    return this.users > 0 && epoch === this.epoch && scope.context === this.scope?.context && scope.workspaceId === this.scope?.workspaceId;
  }
  private async load(scope: NanoAvatarScopeV1, epoch: number): Promise<void> {
    if (!scope.context) return;
    try {
      const answer = await this.client.load(scope.context);
      if (!this.current(scope, epoch) || answer.scope.context !== scope.context || answer.scope.workspaceId !== scope.workspaceId || !answer.avatar) return;
      const ready = await this.decode(answer.avatar);
      if (!this.current(scope, epoch)) { ready.bitmap.close(); return; }
      // Decoding is asynchronous. Reconcile custody with the host after it,
      // even if a revocation event has not reached the WebView yet.
      let latest: NanoAvatarScopeV1;
      try { latest = await this.client.scope(); }
      catch { ready.bitmap.close(); throw new Error('Avatar custody unavailable'); }
      if (this.current(scope, epoch)) this.accept(latest);
      if (!this.current(scope, epoch)) { ready.bitmap.close(); return; }
      this.ready = ready;
    } catch { if (this.current(scope, epoch)) this.clear(); }
  }
}
export const nanoAvatar = new NanoAvatar(nanoAvatarHost);
