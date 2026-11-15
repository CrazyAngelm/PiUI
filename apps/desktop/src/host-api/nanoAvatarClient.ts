import { hostInvoke, hostListen, type HostInvoke, type HostListen } from './transport';
import { NANO_AVATAR_EVENT_V1, type NanoAvatarAnswerV1, type NanoAvatarManifestV1, type NanoAvatarScopeV1 } from '../../../../contracts/nano-avatars-v1';
import { parseAvatarAnswer, parseAvatarManifest, parseAvatarScope } from './nanoAvatarManifest';

export type { NanoAvatarAnswerV1, NanoAvatarManifestV1, NanoAvatarScopeV1 };
export { parseAvatarManifest, parseAvatarScope };
export interface NanoAvatarClient {
  scope(): Promise<NanoAvatarScopeV1>;
  load(context: string): Promise<NanoAvatarAnswerV1>;
  subscribe(listener: (scope: NanoAvatarScopeV1) => void): Promise<() => void>;
}
export function createNanoAvatarClient(invoke: HostInvoke, listen: HostListen): NanoAvatarClient {
  return {
    scope: async () => parseAvatarScope(await invoke('nano_avatar_scope_v1')),
    load: async (context) => parseAvatarAnswer(await invoke('nano_avatar_load_v1', { request: { context } })),
    subscribe: (listener) => listen<unknown>(NANO_AVATAR_EVENT_V1, (value) => {
      try { listener(parseAvatarScope(value)); } catch { /* An invalid event never grants access. */ }
    }),
  };
}
export const nanoAvatarHost = createNanoAvatarClient(hostInvoke, hostListen);
