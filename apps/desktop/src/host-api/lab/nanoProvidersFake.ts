import type { NanoProvidersRequestV1, NanoProvidersResultV1 } from '../../../../../contracts/nano-providers-v1';
import type { NanoChatGptRequestV1, NanoChatGptResultV1 } from '../../../../../contracts/nano-chatgpt-v1';
import type { LabState } from './labState';

/** The Lab simulates connection metadata. Native key entry exists only in the host. */
export function nanoProvidersHandler(state: LabState, args: Record<string, unknown>): NanoProvidersResultV1 {
  const request = args.request as NanoProvidersRequestV1 | undefined;
  if (state.safeMode && request?.type !== 'list') throw { code: 'safe-mode' };
  const providers = state.externalProviders ??= [];
  switch (request?.type) {
    case 'list': break;
    case 'connect': {
      const spec = request.spec;
      const requestFormat = spec.requestFormat === undefined ? 'compatible' : spec.requestFormat;
      let url: URL;
      try { url = new URL(spec.baseUrl); } catch { throw { code: 'invalid-provider' }; }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !spec.name.trim() || !spec.modelId.trim()
        || (requestFormat !== 'compatible' && requestFormat !== 'openai')) {
        throw { code: 'invalid-provider' };
      }
      const id = state.ids.next('provider').replace(/-/gu, '');
      providers.push({ id, spec: { ...spec, requestFormat } });
      break;
    }
    case 'disconnect': {
      const index = providers.findIndex(provider => provider.id === request.id);
      if (index === -1) throw { code: 'not-found' };
      providers.splice(index, 1);
      break;
    }
    default: throw { code: 'invalid-provider' };
  }
  return { protocol: 1, supported: !state.safeMode, providers: state.safeMode ? [] : structuredClone(providers) };
}

export function nanoChatGptHandler(state: LabState, args: Record<string, unknown>): NanoChatGptResultV1 {
  const request = args.request as NanoChatGptRequestV1 | undefined;
  if (state.safeMode && request?.type !== 'status') throw { code: 'safe-mode' };
  const empty = { connected: false, registered: false, email: null, credentialStore: null, models: [] };
  if (state.safeMode) return { protocol: 1, supported: false, status: empty, remoteRevocationConfirmed: null };
  let status: NanoChatGptResultV1['status'] = state.chatGpt ?? empty;
  switch (request?.type) {
    case 'status': case 'cancel': case 'manage-usage': break;
    case 'connect': status = {
      connected: true, registered: true, email: 'demo@example.test', credentialStore: 'memory',
      models: [{ id: 'synthetic-chatgpt-model', name: 'ChatGPT Demo' }],
    }; break;
    case 'disconnect': status = { ...empty, registered: status.registered }; break;
    default: throw { code: 'chat-gpt-sign-in' };
  }
  state.chatGpt = status;
  return { protocol: 1, supported: true, status: structuredClone(status), remoteRevocationConfirmed: request.type === 'disconnect' ? true : null };
}
