/** Metadata and browser actions for the host-owned ChatGPT subscription. */
export const NANO_CHATGPT_PROVIDER_ID = 'nano-external-434841544750542d4f415554482d3031';

export type NanoChatGptRequestV1 =
  | { type: 'status' }
  | { type: 'connect' }
  | { type: 'cancel' }
  | { type: 'disconnect' }
  | { type: 'manage-usage' };

export interface NanoChatGptResultV1 {
  protocol: 1;
  supported: boolean;
  status: {
    connected: boolean;
    registered: boolean;
    email: string | null;
    credentialStore: 'os' | 'memory' | null;
    models: { id: string; name: string }[];
  };
  remoteRevocationConfirmed: boolean | null;
}

export type NanoChatGptErrorCodeV1 =
  | 'chat-gpt-sign-in' | 'chat-gpt-cancelled' | 'chat-gpt-timeout'
  | 'chat-gpt-browser' | 'chat-gpt-offline' | 'chat-gpt-no-plan-permission' | 'chat-gpt-reauthenticate'
  | 'storage' | 'credential-store' | 'safe-mode' | 'unsupported';
