import { NANO_MODE_IDS } from '../../../../contracts/nano-server-v1';
import { NANO_MODEL_PROVIDER } from '../../../../contracts/nano-account-v1';
import { COMPOSER_SUPPORT } from './composer';
import type { HarnessConfiguration } from './types';

/**
 * Nano (ADR-048): the user's installed upstream Pi runs against the Nano
 * models through a host-owned agent directory; its history stays Pi JSONL.
 * Presentation metadata only: the host enforces every setting before a native
 * start and refuses `workspace-write` before launch.
 *
 * - The model is one of the Nano modes the account is entitled to (the host
 *   catalog is the only source). There are no thinking levels, speed tiers,
 *   base prompt replacement, per-agent tools, skills or MCP servers.
 * - `native` permissions ask before shell commands and file changes; this is
 *   an approval prompt, not a sandbox.
 */
export { NANO_MODE_IDS, NANO_MODEL_PROVIDER };

export const nanoConfiguration: HarnessConfiguration = {
  name: 'Nano', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native', 'read-only', 'full-access'], defaultPermission: 'native', resourceKinds: [], skillIdentifier: 'name', nativeTools: [], filesystemSandbox: false, networkAccess: false,
  oneShot: {
    tools: 'disabled',
    note: 'Nano starts a model call with no tools (--no-tools).',
  },
  composer: COMPOSER_SUPPORT.nano,
  limitations: [
    'Needs a Nano account: without a sign-in a step fails before it starts.',
    'Native permissions ask before shell commands and file changes. This is an approval prompt, not a sandbox.',
    'Read-only allows only read, grep, find and ls: a tool list, not a sandbox.',
    'No workspace-write mode: choose native, read-only or full access.',
    'Tools, skills, MCP servers, reasoning and speed cannot be set per agent.',
    'Network access cannot be restricted.',
  ],
};
