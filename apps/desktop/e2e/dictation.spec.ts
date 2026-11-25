import type { Locator, Page } from '@playwright/test';
import { labUuid } from '../src/host-api/lab/labRandom';
import { expect, test, type Lab } from './fixtures';

// The Lab has no microphone, so no spec records: it checks the settings, the key state and when
// the button is offered. Recording itself is covered by the Vitest suites.

const dictate = (page: Page): Locator => page.getByRole('button', { name: 'Dictate', exact: true });

async function openChat(lab: Lab): Promise<void> {
  await lab.chat(/Route host calls through one transport/).click();
  await expect(lab.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function openDictation(lab: Lab): Promise<void> {
  const sections = await lab.openSettings();
  await sections.getByRole('button', { name: 'Dictation', exact: true }).press('Enter');
  await expect(lab.page.getByRole('heading', { name: 'Dictation', level: 2, exact: true })).toBeVisible();
}

const source = (page: Page): Locator => page.getByRole('combobox', { name: 'Speech to text', exact: true });
const keyGroup = (page: Page): Locator => page.getByRole('group', { name: /^API key/ });

test('OpenAI is set up by keyboard without a Nano sign-in, and removing its key hides the button', async ({ lab, page }) => {
  await lab.open();
  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);

  await openDictation(lab);
  await source(page).focus();
  await expect(source(page)).toBeFocused();
  await source(page).selectOption('openai');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-4o-transcribe');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await keyGroup(page).getByRole('button', { name: 'Set API key…', exact: true }).press('Enter');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Saved in the system credential store');

  await openChat(lab);
  await expect(dictate(page)).toBeVisible();
  await expect(dictate(page)).toBeEnabled();

  await openDictation(lab);
  await keyGroup(page).getByRole('button', { name: 'Remove API key', exact: true }).press('Enter');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('a custom endpoint refuses plain http to another computer, then works with a local one and no key', async ({ lab, page }) => {
  await lab.open();
  await openDictation(lab);
  await source(page).selectOption('custom');
  const address = page.getByLabel('API base URL', { exact: true });
  await address.fill('http://example.test/v1');
  await address.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter an HTTPS address. HTTP works only for this computer (localhost).' })).toBeVisible();
  await expect(address).toHaveValue('http://example.test/v1');

  await address.fill('http://127.0.0.1:8000/v1');
  await address.press('Tab');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const model = page.getByLabel('Model', { exact: true });
  await model.fill('whisper-local');
  await model.press('Tab');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Not set');
  await expect(address).toHaveValue('http://127.0.0.1:8000/v1');

  await openChat(lab);
  await expect(dictate(page)).toBeVisible();
  lab.expectNoErrors();
});

test('the Nano subscription stays the default when signed in, and Off hides the button everywhere', async ({ lab, page }) => {
  await lab.open('demo', '&nano=signed-in');
  await openChat(lab);
  await expect(dictate(page)).toBeVisible();

  await openDictation(lab);
  await expect(source(page)).toHaveValue('nano');
  await expect(source(page).locator('option:checked')).toHaveText('Nano subscription');
  await source(page).selectOption('off');
  await expect(source(page)).toHaveValue('off');

  await openChat(lab);
  await expect(dictate(page)).toHaveCount(0);
  await lab.nav('New chat').click();
  await expect(page.getByRole('region', { name: 'What should we work on?' })).toBeVisible();
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('microphone selection uses permission, keeps a disconnected choice visible, and can reset to default', async ({ lab, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        async getUserMedia(constraints: MediaStreamConstraints) {
          if (constraints.audio !== true) throw new Error('Expected ordinary microphone discovery permission');
          sessionStorage.setItem('fixture-microphone-stream', 'open');
          return { getTracks: () => [{ stop: () => sessionStorage.setItem('fixture-microphone-stream', 'closed') }] };
        },
        async enumerateDevices() {
          if (sessionStorage.getItem('fixture-microphone-stream') !== 'open') throw new Error('Microphone permission not requested');
          return [
            { kind: 'audioinput', deviceId: 'default', label: 'Default: Built-in Audio' },
            { kind: 'audioinput', deviceId: 'analog', label: 'Built-in Audio' },
            { kind: 'audioinput', deviceId: 'unlabeled', label: '' },
            ...(sessionStorage.getItem('fixture-g733-unplugged') === null
              ? [{ kind: 'audioinput', deviceId: 'g733', label: 'Logitech G733' }]
              : []),
          ];
        },
      },
    });
  });
  await lab.open();
  await openDictation(lab);

  const microphone = page.getByRole('combobox', { name: 'Microphone', exact: true });
  const find = page.getByRole('button', { name: 'Find microphones', exact: true });
  await expect(microphone.locator('option:checked')).toHaveText('Default microphone');
  expect(await page.evaluate(() => sessionStorage.getItem('fixture-microphone-stream'))).toBeNull();

  await find.press('Enter');
  await expect(microphone.locator('option').filter({ hasText: 'Microphone 2' })).toHaveCount(1);
  await microphone.selectOption({ label: 'Logitech G733' });
  await expect(microphone).toHaveValue('g733');
  expect(await page.evaluate(() => sessionStorage.getItem('fixture-microphone-stream'))).toBe('closed');

  await openChat(lab);
  await openDictation(lab);
  await expect(microphone).toHaveValue('g733');
  await page.evaluate(() => sessionStorage.setItem('fixture-g733-unplugged', '1'));
  await find.press('Enter');
  await expect(microphone.locator('option:checked')).toHaveText('Saved microphone (unavailable)');
  await expect(page.getByRole('status').filter({ hasText: 'The selected microphone is unavailable.' })).toBeVisible();

  await microphone.selectOption({ label: 'Default microphone' });
  await openChat(lab);
  await openDictation(lab);
  await expect(microphone).toHaveValue('');
});

test('safe mode says dictation is off and offers no setup', async ({ lab, page }) => {
  await lab.open('safe');
  await openDictation(lab);
  await expect(page.getByText('Safe mode is on: dictation is off.', { exact: true })).toBeVisible();
  await expect(source(page)).toHaveCount(0);
  await lab.nav('New chat').click();
  await expect(page.getByRole('region', { name: 'What should we work on?' })).toBeVisible();
  await expect(dictate(page)).toHaveCount(0);
  lab.expectNoErrors();
});

test('a recording that failed to transcribe stays in the composer and Retry puts its words in', async ({ lab, page }) => {
  await lab.open();
  await openDictation(lab);
  await source(page).selectOption('openai');
  await keyGroup(page).getByRole('button', { name: 'Set API key…', exact: true }).press('Enter');
  await expect(keyGroup(page).getByRole('status')).toHaveText('Saved in the system credential store');

  // The Lab has no microphone: a clip that an earlier run could not send is put where the app keeps it.
  const scope = `chat:${labUuid('demo:session:transport')}`;
  await page.evaluate(async (pendingScope) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('piui-dictation-pending', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('recordings', { keyPath: 'scope' });
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('recordings', 'readwrite');
      transaction.objectStore('recordings').put({
        id: 'seeded',
        scope: pendingScope,
        blob: new Blob(['FAIL-ONCE audio'], { type: 'audio/webm' }),
        mimeType: 'audio/webm',
        durationMs: 102_000,
        createdAt: Date.now(),
        reason: 'failed',
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, scope);

  await openChat(lab);
  const bar = page.getByRole('group', { name: 'Unsent recording', exact: true });
  await expect(bar).toContainText('Recording 1:42 was not transcribed');
  await expect(bar.getByRole('button', { name: 'Save audio', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

  // The Lab's provider refuses this clip once: the bar stays and the recording is kept.
  await bar.getByRole('button', { name: 'Retry', exact: true }).press('Enter');
  await expect(page.getByText('The speech service is not working right now. Try again later.')).toBeVisible();
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: 'Retry', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(/This is synthetic dictated text\./);
  await expect(bar).toHaveCount(0);
  lab.expectNoErrors();
});
