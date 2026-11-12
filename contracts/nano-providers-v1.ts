/** Metadata for external model providers in Nano Pi. Credentials use native entry. */
export const NANO_EXTERNAL_PROVIDER_PREFIX = 'nano-external-';

export type NanoExternalProviderRequestFormatV1 = 'compatible' | 'openai';

export interface NanoExternalProviderSpecV1 {
  name: string;
  baseUrl: string;
  modelId: string;
  /** Defaults to compatible when omitted by an older client or stored source. */
  requestFormat?: NanoExternalProviderRequestFormatV1;
}

export interface NanoExternalProviderV1 {
  id: string;
  spec: NanoExternalProviderSpecV1;
}

export type NanoProvidersRequestV1 =
  | { type: 'list' }
  | { type: 'connect'; spec: NanoExternalProviderSpecV1; language: 'en' | 'ru' }
  | { type: 'disconnect'; id: string };

export interface NanoProvidersResultV1 {
  protocol: 1;
  supported: boolean;
  providers: NanoExternalProviderV1[];
}

export type NanoProvidersErrorCodeV1 =
  | 'invalid-provider' | 'not-found' | 'credential-store' | 'storage'
  | 'safe-mode' | 'unsupported' | 'prompt-failed';
