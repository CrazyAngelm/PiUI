// The host loads this one trusted plugin explicitly for a Nano-source session.
// Keep the parent's config: ACP may re-read it when creating/loading a session.
// Only native shell descendants receive an empty value. This is not a sandbox.
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export default async function nanoShellEnvironment() {
  const ready = process.env.PIUI_NANO_OPENCODE_READY;
  if (!ready || !isAbsolute(ready)) throw new Error('The Nano shell guard readiness path is missing.');
  const hooks = {
    'shell.env': async (_input, output) => {
      output.env.OPENCODE_CONFIG_CONTENT = '';
      output.env.PIUI_NANO_OPENCODE_READY = '';
    },
  };
  // No key or configuration is written. The bridge accepts only this child's PID
  // in a fresh, per-launch directory before it permits a model prompt.
  writeFileSync(ready, String(process.pid), { mode: 0o600 });
  return hooks;
}
