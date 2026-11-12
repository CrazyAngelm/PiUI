import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../contracts/fixtures/nano-account-v1.json';
import { createNanoAccountClient, type NanoAccountClient, type NanoAccountStatusV1 } from '../../host-api/nanoAccountClient';
import { LAB_NANO_SIGN_IN_MS, type LabNanoScenario } from '../../host-api/lab/nanoAccountFake';
import { labHost } from '../../host-api/lab/labTestKit';
import { NanoAccount } from './nanoAccount.svelte';
import { NANO_SOURCE_HARNESSES, chipFor, creditsFraction, creditsLevel, creditsText, lockCopy, retryAction } from './nanoView';

const { forget } = vi.hoisted(() => ({ forget: vi.fn() }));
vi.mock('../../host-api/harnessModels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../host-api/harnessModels')>()),
  forgetHarnessCatalogs: forget,
}));

function labClient(nano: LabNanoScenario, calls: string[] = []): NanoAccountClient {
  const host = labHost('demo', { nano });
  return createNanoAccountClient(
    (command, args) => {
      calls.push(command);
      return host.invoke(command, args);
    },
    (channel, handler) => {
      calls.push(`listen ${channel}`);
      return host.listen(channel, handler);
    },
  );
}

async function started(nano: LabNanoScenario, calls: string[] = []): Promise<NanoAccount> {
  const account = new NanoAccount(labClient(nano, calls));
  await account.start();
  return account;
}

beforeEach(() => {
  vi.useFakeTimers();
  forget.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Nano account store', () => {
  it('loads nothing until it is started, then subscribes once and reads the status once', async () => {
    const calls: string[] = [];
    const account = new NanoAccount(labClient('signed-out', calls));
    expect(account.loaded).toBe(false);
    expect(account.signedIn).toBe(false);
    expect(account.canDictate).toBe(false);
    expect(calls).toEqual([]);
    await account.start();
    await account.start();
    // Subscribed first, so an event published while the status is read is not lost.
    expect(calls).toEqual(['listen piui://nano-account-v1', 'nano_account_status_v1']);
    expect(account.state).toBe('signed-out');
    expect(account.needsSignIn).toBe(true);
    expect(account.loading).toBe(false);
  });

  it('starts after first paint, and the cancellation keeps it from starting', async () => {
    const calls: string[] = [];
    const account = new NanoAccount(labClient('signed-out', calls));
    const stop = account.startLater(300);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(account.loaded).toBe(true);
    const never = new NanoAccount(labClient('signed-out', calls));
    never.startLater(300)();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(never.loaded).toBe(false);
    stop();
  });

  it('derives credits, modes, cloud and dictation from a paid account', async () => {
    const account = await started('signed-in');
    expect(account.signedIn).toBe(true);
    expect(account.needsSignIn).toBe(false);
    expect(account.credits?.balance).toBe(18250);
    expect(account.modes.map((mode) => mode.id)).toEqual(['auto', 'free', 'fast', 'smart']);
    expect(account.lockedModes).toEqual([]);
    expect(account.canUseCloud).toBe(true);
    expect(account.canDictate).toBe(true);
    expect(account.dictationMaxBytes).toBe(20971520);
  });

  it('locks modes and features by plan and by credits', async () => {
    const free = await started('free');
    expect(free.lockedModes.map((mode) => [mode.id, mode.lockedReason])).toEqual([['fast', 'plan'], ['smart', 'plan']]);
    expect(free.availableModes.map((mode) => mode.id)).toEqual(['auto', 'free']);
    expect(free.canUseCloud).toBe(false);
    expect(free.canDictate).toBe(false);
    const exhausted = await started('exhausted');
    expect(exhausted.lockedModes.map((mode) => [mode.id, mode.lockedReason])).toEqual([['auto', 'credits'], ['fast', 'credits'], ['smart', 'credits']]);
    expect(exhausted.availableModes.map((mode) => mode.id)).toEqual(['free']);
  });

  it('offers nothing of the account unless it is signed in', async () => {
    for (const name of ['signed-out', 'expired', 'unsupported', 'offline'] as const) {
      const account = await started(name);
      expect(account.signedIn, name).toBe(false);
      expect(account.modes, name).toEqual([]);
      expect(account.canUseCloud, name).toBe(false);
      expect(account.canDictate, name).toBe(false);
    }
    expect((await started('expired')).needsSignIn).toBe(true);
    expect((await started('offline')).needsSignIn).toBe(false);
  });

  it('follows sign-in through the host events', async () => {
    const account = await started('signed-out');
    expect(await account.signIn()).toBe(true);
    expect(account.state).toBe('signing-in');
    expect(account.status?.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect(account.state).toBe('signed-in');
    expect(account.status?.user?.displayName).toBe('Synthetic Person');
    expect(account.problem).toBeUndefined();
    expect(await account.signOut()).toBe(true);
    expect(account.state).toBe('signed-out');
    expect(account.credits).toBeUndefined();
  });

  it('cancels a waiting sign-in', async () => {
    const account = await started('signed-out');
    await account.signIn();
    expect(await account.cancelSignIn()).toBe(true);
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS * 2);
    expect(account.state).toBe('signed-out');
  });

  it('switches workspace and keeps the answer of the host', async () => {
    const account = await started('signed-in');
    expect(await account.selectWorkspace('ws_synthetic02')).toBe(true);
    expect(account.status?.selectedWorkspaceId).toBe('ws_synthetic02');
    expect(account.entitlements?.plan.name).toBe('Team');
    expect(account.lockedModes.map((mode) => mode.id)).toEqual(['smart']);
  });

  it('reports a failed action as fixed copy and keeps the last status', async () => {
    const account = await started('offline');
    expect(await account.refresh()).toBe(false);
    expect(account.error).toBe('Could not reach Nano. Check your connection and try again.');
    expect(account.problem).toBe(account.error);
    expect(account.state).toBe('offline');
    expect(account.action).toBeUndefined();
    account.clearError();
    expect(account.problem).toBe('Could not reach Nano. Check your connection and try again.');
  });

  it('shows the host error of an expired account until a sign-in clears it', async () => {
    const account = await started('expired');
    expect(account.problem).toBe('This device was signed out of your Nano account. Sign in again.');
    await account.signIn();
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect(account.problem).toBeUndefined();
  });

  it('opens the cloud only when the plan and the server allow it', async () => {
    const calls: string[] = [];
    const paid = await started('signed-in', calls);
    expect(await paid.openCloud()).toBe(true);
    expect(calls).toContain('nano_cloud_open_v1');
    const freeCalls: string[] = [];
    const free = await started('free', freeCalls);
    expect(await free.openCloud()).toBe(false);
    expect(freeCalls).not.toContain('nano_cloud_open_v1');
  });

  it('runs one action at a time', async () => {
    const account = await started('signed-in');
    const first = account.refresh();
    expect(account.action).toBe('refresh');
    expect(await account.openLink('billing')).toBe(false);
    expect(await first).toBe(true);
    expect(account.action).toBeUndefined();
  });

  it('ignores a status older than the one it has', async () => {
    const account = new NanoAccount(labClient('signed-in'));
    account.apply({ type: 'status', status: fixture.signedIn as unknown as NanoAccountStatusV1 });
    expect(account.status?.revision).toBe(5);
    account.apply({ type: 'status', status: fixture.signedOut as unknown as NanoAccountStatusV1 });
    expect(account.state).toBe('signed-in');
    account.apply({ type: 'status', status: { ...fixture.expired, revision: 9 } as unknown as NanoAccountStatusV1 });
    expect(account.state).toBe('expired');
  });

  it('stops following events once disposed', async () => {
    const account = await started('signed-out');
    account.dispose();
    await account.signIn().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect(account.state).toBe('signed-out');
  });

  it('can start again after a failed first read', async () => {
    let fail = true;
    const client = createNanoAccountClient(
      async <T>() => {
        if (fail) throw { code: 'safe-mode' };
        return fixture.signedOut as T;
      },
      async () => () => undefined,
    );
    const account = new NanoAccount(client);
    await account.start();
    expect(account.loaded).toBe(false);
    expect(account.error).toBe('Nano account actions are off in safe mode.');
    fail = false;
    await account.start();
    expect(account.loaded).toBe(true);
  });

  it('keeps an event that arrives while the first status is still being read', async () => {
    let publish: (payload: unknown) => void = () => undefined;
    let answer: (status: unknown) => void = () => undefined;
    const client = createNanoAccountClient(
      async <T>() => (await new Promise<unknown>((resolve) => (answer = resolve))) as T,
      async <T>(_channel: string, handler: (payload: T) => void) => {
        publish = handler as (payload: unknown) => void;
        return () => undefined;
      },
    );
    const account = new NanoAccount(client);
    const starting = account.start();
    // The subscription is made before the status call, so both are in place after a few turns.
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    publish({ type: 'status', status: { ...fixture.signedIn, revision: 9 } });
    expect(account.state).toBe('signed-in');
    answer({ ...fixture.signedOut, revision: 2 });
    await starting;
    expect(account.state, 'the older answer does not replace the newer event').toBe('signed-in');
    expect(account.status?.revision).toBe(9);
  });

  it('unsubscribes and can start again when the first status read fails', async () => {
    const unsubscribed = vi.fn();
    let subscriptions = 0;
    const client = createNanoAccountClient(
      async () => {
        throw { code: 'safe-mode' };
      },
      async () => {
        subscriptions += 1;
        return unsubscribed;
      },
    );
    const account = new NanoAccount(client);
    await account.start();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(account.error).toBe('Nano account actions are off in safe mode.');
    await account.start();
    expect(subscriptions).toBe(2);
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    // No listener is left behind by the failed starts: disposing does not unsubscribe a third time.
    account.dispose();
    expect(unsubscribed).toHaveBeenCalledTimes(2);
  });
});

describe('Nano model catalog revision', () => {
  it('forgets the Nano catalogs and bumps the revision only when the catalog can change', async () => {
    const account = await started('signed-in');
    // The Nano lane and every agent with a Nano model source (a separate group of
    // the same modes) forget their catalogs together, once per change.
    const perChange = 1 + NANO_SOURCE_HARNESSES.length;
    expect(NANO_SOURCE_HARNESSES).toEqual(['acp:opencode', 'prime-agent', 'codex', 'acp:goose']);
    expect(forget).toHaveBeenCalledWith('nano');
    expect(forget).toHaveBeenCalledWith('acp:opencode');
    expect(forget).toHaveBeenCalledWith('prime-agent');
    expect(forget).toHaveBeenCalledWith('codex');
    expect(forget).toHaveBeenCalledWith('acp:goose');
    expect(forget).toHaveBeenCalledTimes(perChange);
    expect(account.catalogRevision, 'the first status is a change').toBe(1);

    // Credits and plan dates are not part of the catalog.
    await account.refresh();
    expect(account.catalogRevision).toBe(1);

    // Another workspace has other entitled modes.
    await account.selectWorkspace('ws_synthetic02');
    expect(account.catalogRevision).toBe(2);
    expect(forget).toHaveBeenCalledTimes(2 * perChange);

    // Events of the same state do not bump it again.
    await vi.advanceTimersByTimeAsync(50);
    expect(account.catalogRevision).toBe(2);

    // Sign-out ends the group in every affected catalog before the pickers ask again.
    await account.signOut();
    expect(account.catalogRevision).toBe(3);
    expect(forget).toHaveBeenCalledTimes(3 * perChange);
    expect(forget.mock.calls.slice(-perChange).map(([harness]) => harness)).toEqual(['nano', ...NANO_SOURCE_HARNESSES]);
  });

  it('follows a sign-in only once it completes, and a mode locked by exhausted credits', async () => {
    const account = await started('signed-out');
    expect(account.catalogRevision).toBe(1);
    await account.signIn();
    expect(account.catalogRevision, 'waiting for the browser changes no catalog').toBe(1);
    await vi.advanceTimersByTimeAsync(LAB_NANO_SIGN_IN_MS + 10);
    expect(account.state).toBe('signed-in');
    expect(account.catalogRevision).toBe(2);
    const locked = { ...(account.status as NanoAccountStatusV1) };
    const entitlements = locked.entitlements as NonNullable<NanoAccountStatusV1['entitlements']>;
    const modes = entitlements.modes.map((mode) => (mode.id === 'smart' ? { ...mode, available: false, lockedReason: 'credits' as const } : mode));
    account.apply({ type: 'status', status: { ...locked, entitlements: { ...entitlements, modes }, revision: locked.revision + 1 } });
    expect(account.catalogRevision, 'a locked mode leaves the catalog').toBe(3);
  });

  it('ignores a stale status when it decides what changed', async () => {
    const account = new NanoAccount(labClient('signed-in'));
    account.apply({ type: 'status', status: fixture.signedIn as unknown as NanoAccountStatusV1 });
    expect(account.catalogRevision).toBe(1);
    account.apply({ type: 'status', status: fixture.signedOut as unknown as NanoAccountStatusV1 });
    expect(account.catalogRevision).toBe(1);
  });
});

describe('Nano account view helpers', () => {
  const fixtureStatus = (key: 'signedOut' | 'signedIn' | 'expired' | 'unsupported'): NanoAccountStatusV1 => fixture[key] as unknown as NanoAccountStatusV1;

  it('explains every lock and nothing for an open mode', () => {
    expect(lockCopy({ available: false, lockedReason: 'plan' })).toBe('Not in your plan');
    expect(lockCopy({ available: false, lockedReason: 'credits' })).toBe('No credits left');
    expect(lockCopy({ available: false, lockedReason: 'disabled' })).toBe('Disabled');
    expect(lockCopy({ available: false, lockedReason: null })).toBe('Disabled');
    expect(lockCopy({ available: true, lockedReason: null })).toBeUndefined();
  });

  it('measures the credit gauge', () => {
    expect(creditsFraction({ balance: 18250, included: 25000 })).toBeCloseTo(0.73);
    expect(creditsFraction({ balance: 30000, included: 25000 })).toBe(1);
    expect(creditsFraction({ balance: 5, included: null })).toBeUndefined();
    expect(creditsFraction({ balance: 5, included: 0 })).toBeUndefined();
    // A negative balance (the host sends signed credits) is an empty gauge, never below zero.
    expect(creditsFraction({ balance: -40, included: 100 })).toBe(0);
    expect(creditsLevel({ balance: -40, included: 100 })).toBe('empty');
    expect(creditsLevel({ balance: -1, included: null })).toBe('empty');
    expect(creditsLevel({ balance: 0, included: 100 })).toBe('empty');
    expect(creditsLevel({ balance: 10, included: 100 })).toBe('low');
    expect(creditsLevel({ balance: 11, included: 100 })).toBe('ok');
    expect(creditsLevel({ balance: 3, included: null })).toBe('ok');
    expect(creditsText(18250, 'en-US')).toBe('18,250');
    expect(creditsText(18250, 'en-US', true)).toBe('18.3K');
  });

  it('retries with a sign-in until a person is known, then with a refresh', () => {
    expect(retryAction({ user: null })).toBe('sign-in');
    expect(retryAction({ user: { displayName: 'Synthetic Person', email: null } })).toBe('refresh');
    // The unsupported fixture is the first-sign-in failure: nobody is known yet.
    expect(retryAction(fixtureStatus('unsupported'))).toBe('sign-in');
  });

  it('describes the sidebar chip for every state', () => {
    expect(chipFor(undefined)).toEqual({ label: 'Nano account', translate: true, credits: undefined, tone: 'neutral' });
    expect(chipFor(fixtureStatus('signedOut'))).toMatchObject({ label: 'Sign in to Nano', translate: true, tone: 'neutral' });
    // The person's name is user data: it is shown as it is, never translated.
    expect(chipFor(fixtureStatus('signedIn'))).toEqual({ label: 'Synthetic Person', translate: false, credits: 18250, tone: 'ok' });
    expect(chipFor(fixtureStatus('expired'))).toMatchObject({ label: 'Sign in again', tone: 'warning' });
    expect(chipFor(fixtureStatus('unsupported'))).toMatchObject({ label: 'Nano unavailable', tone: 'warning' });
    const empty = { ...fixtureStatus('signedIn'), entitlements: { ...fixture.signedIn.entitlements, credits: { balance: 0, included: 25000, periodEndsAt: null } } } as unknown as NanoAccountStatusV1;
    expect(chipFor(empty)).toMatchObject({ credits: 0, tone: 'danger' });
    const owing = { ...fixtureStatus('signedIn'), entitlements: { ...fixture.signedIn.entitlements, credits: { balance: -30, included: 25000, periodEndsAt: null } } } as unknown as NanoAccountStatusV1;
    expect(chipFor(owing)).toMatchObject({ credits: 0, tone: 'danger' });
    const named = { ...fixtureStatus('signedIn'), user: { displayName: 'Free', email: null } } as unknown as NanoAccountStatusV1;
    expect(chipFor(named)).toMatchObject({ label: 'Free', translate: false });
    const unnamed = { ...fixtureStatus('signedIn'), user: null } as unknown as NanoAccountStatusV1;
    expect(chipFor(unnamed)).toMatchObject({ label: 'Nano account', translate: true });
    expect(chipFor({ ...fixtureStatus('signedOut'), state: 'offline' })).toMatchObject({ label: 'Nano offline' });
    expect(chipFor({ ...fixtureStatus('signedOut'), state: 'signing-in' })).toMatchObject({ label: 'Signing in…' });
  });
});
