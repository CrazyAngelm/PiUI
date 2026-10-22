import { describe, expect, it } from 'vitest';
import fixture from '../../../../contracts/fixtures/fusion-v1.json';
import type { FusionCommandV1 } from '../../../../contracts/fusion-v1';
import { createFusionClient, decodeFusionChanged, decodeFusionResult, fusionError, isFusionState } from './fusionClient';

describe('fusion v1 contract', () => {
  it('decodes the host shapes of the public fixture', () => {
    const state = decodeFusionResult(fixture.state);
    expect(state?.type).toBe('state');
    expect(state?.type === 'state' && isFusionState(state.state)).toBe(true);
    expect(decodeFusionResult(fixture.pairRefused)).toEqual(fixture.pairRefused);
    expect(decodeFusionResult(fixture.pairAccepted)).toEqual({ type: 'pairCheck', ok: true });
    expect(decodeFusionResult(fixture.notMember)).toEqual({ type: 'membership', role: null });
    expect(decodeFusionResult(fixture.sidekickMember)).toEqual(fixture.sidekickMember);
    expect(decodeFusionChanged(fixture.changed)).toEqual(fixture.changed);
  });

  it('drops malformed results and maps host errors to fixed codes', async () => {
    expect(decodeFusionResult({ type: 'state', state: { protocol: 2 } })).toBeUndefined();
    expect(decodeFusionResult({ type: 'pairCheck', ok: false })).toBeUndefined();
    expect(decodeFusionChanged({ protocol: 1, leadSessionId: '', revision: 1 })).toBeUndefined();
    expect(fusionError({ code: 'SAFE_MODE', message: 'host text' }).code).toBe('SAFE_MODE');
    expect(fusionError('{"code":"CONFLICT"}').code).toBe('CONFLICT');
    expect(fusionError(new Error('x')).code).toBe('unknown');
    const refusing = createFusionClient(
      () => Promise.reject({ code: 'NOT_SUPPORTED', message: 'raw' }),
      () => Promise.resolve(() => {}),
    );
    await expect(refusing.request({ type: 'state', leadSessionId: 'lead-1' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const malformed = createFusionClient(
      <T>() => Promise.resolve({ type: 'bogus' } as T),
      () => Promise.resolve(() => {}),
    );
    await expect(malformed.request({ type: 'state', leadSessionId: 'lead-1' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('sends the command in the shape of the fixture', async () => {
    const calls: unknown[] = [];
    const client = createFusionClient(
      <T>(command: string, args?: Record<string, unknown>) => {
        calls.push([command, args]);
        return Promise.resolve(fixture.pairAccepted as T);
      },
      () => Promise.resolve(() => {}),
    );
    const command = fixture.createChat as FusionCommandV1;
    await client.request(command);
    expect(calls).toEqual([['fusion_command_v1', { command }]]);
  });
});
