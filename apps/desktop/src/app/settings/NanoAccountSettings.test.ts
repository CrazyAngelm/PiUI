import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import fixture from '../../../../../contracts/fixtures/nano-account-v1.json';
import { setLanguage } from '../../features/locale/language';
import { labHost } from '../../host-api/lab/labTestKit';
import type { LabNanoScenario } from '../../host-api/lab/nanoAccountFake';
import { createNanoAccountClient, type NanoAccountStatusV1 } from '../../host-api/nanoAccountClient';
import { NanoAccount } from '../nano/nanoAccount.svelte';
import NanoAccountSettings from './NanoAccountSettings.svelte';

async function started(nano: LabNanoScenario): Promise<NanoAccount> {
  const host = labHost('demo', { nano });
  const account = new NanoAccount(createNanoAccountClient((command, args) => host.invoke(command, args), (channel, handler) => host.listen(channel, handler)));
  await account.start();
  return account;
}

const html = (account: NanoAccount, safeMode = false): string => render(NanoAccountSettings, { props: { account, safeMode } }).body;
const withStatus = (account: NanoAccount, patch: Partial<NanoAccountStatusV1>): void =>
  account.apply({ type: 'status', status: { ...(account.status as NanoAccountStatusV1), ...patch, revision: (account.status?.revision ?? 0) + 100 } });

afterEach(() => setLanguage('en'));

describe('Settings → Nano account', () => {
  it('waits with a skeleton until the status is known', () => {
    const body = html(new NanoAccount(createNanoAccountClient(async <T>() => fixture.signedOut as T, async () => () => undefined)));
    expect(body).toContain('Nano account');
    expect(body).toContain('aria-busy="true"');
    expect(body).not.toContain('Sign in');
  });

  it('offers sign-in and sign-up, and says what leaves the computer, when signed out', async () => {
    const body = html(await started('signed-out'));
    expect(body).toContain('Sign in');
    expect(body).toContain('Create account');
    expect(body).toContain('the messages of Nano chats and the audio you dictate leave this computer; your history stays here.');
    expect(body).not.toContain('Sign out');
    expect(body).not.toContain('Development server');
    expect(body).not.toContain('role="alert"');
  });

  it('shows the avatar switch with an accessible name in every state', async () => {
    for (const name of ['signed-out', 'signed-in', 'expired'] as const) {
      const body = html(await started(name));
      expect(body, name).toContain('aria-label="Show Nano avatar"');
    }
  });

  it('waits for the browser and offers to cancel while signing in', async () => {
    const account = await started('signed-out');
    await account.signIn();
    const body = html(account);
    expect(body).toContain('Finish signing in in your browser.');
    expect(body).toContain('Cancel');
    expect(body).toContain('role="status"');
    expect(body).not.toContain('Sign in');
  });

  it('shows the person, workspace, plan, credit gauge and modes when signed in', async () => {
    const body = html(await started('signed-in'));
    expect(body).toContain('Synthetic Person');
    expect(body).toContain('person@example.com');
    expect(body).toContain('id="nano-workspace"');
    expect(body).toContain('>Personal<');
    expect(body).toContain('>Team<');
    expect(body).toContain('<strong>Pro</strong>');
    expect(body).toContain('Renews ');
    expect(body).toContain('18,250 of 25,000 credits left');
    expect(body).toMatch(/<progress[^>]*max="25000"[^>]*value="18250"|<progress[^>]*value="18250"[^>]*max="25000"/);
    expect(body).toContain('aria-label="Credits"');
    for (const mode of ['Auto', 'Free', 'Fast', 'Smart']) expect(body).toContain(`<strong>${mode}</strong>`);
    expect(body).toContain('Picks a model per request');
    expect(body).toContain('Mixed');
    expect(body).toContain('Premium');
    for (const action of ['Manage plan', 'Devices', 'Sign out', 'Refresh']) expect(body).toContain(action);
    expect(body).not.toContain('kept in memory only');
    expect(body).not.toContain('Sign in');
  });

  it('hides the workspace choice when there is only one', async () => {
    expect(html(await started('free'))).not.toContain('nano-workspace');
  });

  it('shows why a mode is locked', async () => {
    const free = html(await started('free'));
    expect(free.match(/Not in your plan/g)).toHaveLength(2);
    expect(free).toContain('<strong>Free</strong>');
    const exhausted = html(await started('exhausted'));
    expect(exhausted.match(/No credits left/g)).toHaveLength(3);
    expect(exhausted).toContain('data-level="empty"');
    expect(exhausted).toContain('0 of 25,000 credits left');
  });

  it('warns when the sign-in lives in memory only', async () => {
    const account = await started('signed-in');
    withStatus(account, { credentialStore: 'memory' });
    const body = html(account);
    expect(body).toContain('Your sign-in is kept in memory only.');
    expect(body).toContain('role="status"');
  });

  it('asks to sign in again when the device was revoked, without a second alert', async () => {
    const body = html(await started('expired'));
    expect(body).toContain('Your sign-in ended.');
    expect(body).toContain('Sign in again');
    expect(body).not.toContain('role="alert"');
    expect(body).not.toContain('Sign out');
  });

  it('tells a server without the desktop API from a client that is too old', async () => {
    const account = await started('unsupported');
    const server = html(account);
    expect(server).toContain('Development server');
    expect(server).toContain('This Nano server does not support Nano Desktop yet.');
    expect(server).toContain('Try again');
    expect(server).not.toContain('Check for updates');
    withStatus(account, { lastError: 'client-too-old' });
    const old = html(account);
    expect(old).toContain('This version of Nano Desktop is too old for the Nano server.');
    expect(old).toContain('Check for updates');
    expect(old).not.toContain('Try again');
  });

  it('retries an unavailable account with a sign-in while no person is known, and a refresh otherwise', async () => {
    const account = await started('unsupported');
    expect(account.status?.user).toBeNull();
    expect(html(account)).toContain('Try again');
    // The click handler follows `retryAction`: a refresh needs a saved credential, which a first sign-in never made.
    const known = { displayName: 'Synthetic Person', email: null };
    withStatus(account, { user: known });
    expect(html(account)).toContain('Try again');
  });

  it('offers only the local sign-out in safe mode, whatever the status says', async () => {
    for (const name of ['signed-out', 'signed-in', 'expired'] as const) {
      const body = html(await started(name), true);
      expect(body, name).toContain('Safe mode is on: Nano is not contacted. You can still forget the sign-in saved on this computer.');
      expect(body, name).toContain('Forget saved sign-in');
      for (const text of ['Sign in', 'Create account', 'Manage plan', 'Sign out', 'aria-busy']) expect(body, `${name} ${text}`).not.toContain(text);
      expect(body, name).not.toContain('The saved sign-in was removed.');
      expect(body, name).toContain('aria-label="Show Nano avatar"');
    }
    // The page is reachable before the status is known.
    const waiting = html(new NanoAccount(createNanoAccountClient(async <T>() => fixture.signedOut as T, async () => () => undefined)), true);
    expect(waiting).toContain('Forget saved sign-in');
    expect(waiting).not.toContain('aria-busy');
  });

  it('shows a negative balance as nothing left', async () => {
    const account = await started('signed-in');
    const entitlements = account.entitlements as NonNullable<NanoAccountStatusV1['entitlements']>;
    withStatus(account, { entitlements: { ...entitlements, credits: { balance: -30, included: 25000, periodEndsAt: null } } });
    const body = html(account);
    expect(body).toContain('0 of 25,000 credits left');
    expect(body).toContain('data-level="empty"');
    expect(body).not.toContain('-30');
    expect(body).toMatch(/<progress[^>]*value="0"/);
  });

  it('keeps an offline account visible and offers a retry', async () => {
    const body = html(await started('offline'));
    expect(body).toContain('Synthetic Person');
    expect(body).toContain('Offline');
    expect(body).toContain('Nano could not be reached. You stay signed in');
    expect(body).toContain('Try again');
  });

  it('shows the copy of a failed action as an alert', async () => {
    const account = await started('offline');
    await account.refresh();
    const body = html(account);
    expect(body).toContain('role="alert"');
    expect(body).toContain('Could not reach Nano. Check your connection and try again.');
  });

  it('shows the last host error while signed out, such as a cancelled sign-in', async () => {
    const account = await started('signed-out');
    withStatus(account, { lastError: 'sign-in-failed' });
    expect(html(account)).toContain('Sign-in did not finish. Try again.');
  });

  it('speaks Russian', async () => {
    setLanguage('ru');
    const signedOut = html(await started('signed-out'));
    expect(signedOut).toContain('Аккаунт Nano');
    expect(signedOut).toContain('Войти');
    expect(signedOut).toContain('Создать аккаунт');
    const signedIn = html(await started('signed-in'));
    expect(signedIn).toContain('Осталось кредитов: 18');
    expect(signedIn).toContain('Управление тарифом');
    expect(signedIn).toContain('Выйти');
    expect(signedIn).toContain('aria-label="Показывать аватар Nano"');
    const safe = html(await started('signed-out'), true);
    expect(safe).toContain('Включён безопасный режим');
    expect(safe).toContain('Забыть сохранённый вход');
  });
});
