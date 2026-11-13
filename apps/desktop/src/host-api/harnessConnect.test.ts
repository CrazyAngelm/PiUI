import { describe, expect, it, vi } from 'vitest';
import { createHarnessConnectClient, harnessConnectError, HarnessConnectError, HARNESS_CONNECT_ERRORS } from './harnessConnect';

const described = {
  protocol: 1,
  type: 'described',
  harnesses: [
    { harness: 'pi', command: 'pi', then: '/login', terminal: true },
    { harness: 'codex', command: 'codex login', terminal: true },
  ],
};

describe('harness connect v1 client', () => {
  it('sends only the versioned command and a harness name', async () => {
    const run = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const command = args?.command as { type: string };
      return command.type === 'describe' ? described : { protocol: 1, type: 'opened', harness: 'codex' };
    });
    const client = createHarnessConnectClient(run as never);
    expect(await client.describe()).toEqual(described.harnesses);
    await client.openTerminal('codex');
    expect(run).toHaveBeenNthCalledWith(1, 'harness_connect_v1', { command: { type: 'describe' } });
    expect(run).toHaveBeenNthCalledWith(2, 'harness_connect_v1', { command: { type: 'openTerminal', harness: 'codex' } });
  });

  it('maps every host code to a fixed message and ignores host text', () => {
    for (const code of Object.keys(HARNESS_CONNECT_ERRORS) as (keyof typeof HARNESS_CONNECT_ERRORS)[]) {
      const mapped = harnessConnectError({ code, message: 'C:\\secret\\path leaked', recoverable: true });
      expect(mapped).toBeInstanceOf(HarnessConnectError);
      expect(mapped.code).toBe(code);
      expect(mapped.message).toBe(HARNESS_CONNECT_ERRORS[code]);
    }
    expect(harnessConnectError({ code: 'SAFE_MODE' }).message).toBe('Safe mode is on: Nano Desktop starts no agent program.');
    expect(harnessConnectError({ code: 'NO_TERMINAL' }).message).toBe('A terminal app was not found. Run the command yourself.');
    for (const cause of [{ code: 'EXPLODED' }, 'Command harness_connect_v1 not found', undefined, null]) {
      const mapped = harnessConnectError(cause);
      expect(mapped.code).toBe('UNAVAILABLE');
      expect(mapped.message).toBe('Could not open a terminal. Run the command yourself.');
    }
  });

  it('turns a host rejection or a malformed answer into a typed failure', async () => {
    const rejected = createHarnessConnectClient((async () => { throw { code: 'SAFE_MODE', message: 'x', recoverable: true }; }) as never);
    await expect(rejected.openTerminal('pi')).rejects.toMatchObject({ code: 'SAFE_MODE' });
    const missing = createHarnessConnectClient((async () => { throw 'Command harness_connect_v1 not found'; }) as never);
    await expect(missing.describe()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    for (const answer of [
      { protocol: 2, type: 'described', harnesses: [] },
      { protocol: 1, type: 'opened', harness: 'pi' },
      { protocol: 1, type: 'described', harnesses: [{ harness: 'acp:gemini-cli', command: 'x', terminal: true }] },
      { protocol: 1, type: 'described', harnesses: [{ harness: 'pi', command: 'pi\nrm', terminal: true }] },
      { protocol: 1, type: 'described', harnesses: [{ harness: 'pi', command: 'pi' }] },
      null,
    ]) {
      await expect(createHarnessConnectClient((async () => answer) as never).describe()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    }
    // The terminal that opened must be the one asked for.
    const other = createHarnessConnectClient((async () => ({ protocol: 1, type: 'opened', harness: 'codex' })) as never);
    await expect(other.openTerminal('pi')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
