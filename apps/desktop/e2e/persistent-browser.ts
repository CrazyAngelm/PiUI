import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Windows Chromium tests reuse a fixed profile so Chromium's blank-password
 * probe is not repeated for every browser launch (AGENTS.md). Individual tests
 * still use fresh in-memory contexts; no user browsing profile is opened.
 */
export function windowsBrowserProfile(identity: string, endpoint: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA is required for the Windows test browser profile.');
  // Stable across retries; different worktrees or test endpoints cannot claim
  // the same Chromium ProcessSingleton. Keep the full hash, not a run ID.
  const scope = createHash('sha256')
    .update(realpathSync(process.cwd()).toLowerCase()).update('\0').update(endpoint)
    .digest('base64url');
  return join(localAppData, 'pw-profiles', `piui-${scope}-${identity}`);
}
