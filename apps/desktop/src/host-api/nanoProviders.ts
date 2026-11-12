import type { NanoProvidersErrorCodeV1, NanoProvidersRequestV1, NanoProvidersResultV1 } from '../../../../contracts/nano-providers-v1';
import type { NanoChatGptErrorCodeV1, NanoChatGptRequestV1, NanoChatGptResultV1 } from '../../../../contracts/nano-chatgpt-v1';
import { hostInvoke } from './transport';

export const NANO_PROVIDER_ERRORS: Readonly<Record<NanoProvidersErrorCodeV1, string>> = {
  'invalid-provider': 'Enter a name, an HTTPS API base URL and a model ID.',
  'not-found': 'This provider connection is no longer available.',
  'credential-store': 'The operating system could not store or remove this API key.',
  storage: 'Could not read or save provider settings.',
  'safe-mode': 'External providers are unavailable in safe mode.',
  unsupported: 'External provider setup is unavailable on this platform.',
  'prompt-failed': 'Could not open the native API key dialog.',
};

export function nanoProviders(request: NanoProvidersRequestV1): Promise<NanoProvidersResultV1> {
  return hostInvoke('nano_providers_v1', { request });
}

export const NANO_CHATGPT_ERRORS: Readonly<Record<NanoChatGptErrorCodeV1, string>> = {
  'chat-gpt-sign-in': 'Could not connect your ChatGPT account.',
  'chat-gpt-cancelled': 'ChatGPT sign-in was cancelled.',
  'chat-gpt-timeout': 'ChatGPT sign-in timed out. Try again.',
  'chat-gpt-browser': 'Could not open ChatGPT in your browser.',
  'chat-gpt-offline': 'ChatGPT is unavailable. Try again later.',
  'chat-gpt-no-plan-permission': 'ChatGPT did not grant permission to use your plan.',
  'chat-gpt-reauthenticate': 'Your ChatGPT connection expired. Sign in again.',
  storage: 'Could not read or save provider settings.',
  'credential-store': 'The operating system could not access the ChatGPT credential.',
  'safe-mode': 'External providers are unavailable in safe mode.',
  unsupported: 'External provider setup is unavailable on this platform.',
};

export function nanoChatGpt(request: NanoChatGptRequestV1): Promise<NanoChatGptResultV1> {
  return hostInvoke('nano_chatgpt_v1', { request });
}
