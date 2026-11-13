import type { Page } from '@playwright/test';
import { DEMO_PROJECTS } from '../src/host-api/lab/scenarios/demoChats';
import { expect, test } from './fixtures';

const codexModel = JSON.stringify(['openai-lab', 'gpt-lab-5-codex']);
const codexMini = JSON.stringify(['openai-lab', 'gpt-lab-5-mini']);

/** `SLOW_CATALOG_LATENCY_MS` of the lab host: how long `?catalog=slow` withholds a catalog. */
const SLOW_CATALOG_MS = 5_000;
/** `START_DELAY_MS` of `nanoAccount`: the account starts this long after the sidebar paints. */
const NANO_START_MS = 300;
/** Far beyond the time two protocol calls take, so the pause below is always in the page's future. */
const CLOCK_LEAD_MS = 60_000;

/**
 * Stops the page clock before the first script of the page runs: Playwright replays
 * `install` and `pauseAt` at document start, so the lab's slow catalogs are due a
 * fixed 5 s after the test starts and fire only when `page.clock.runFor` says so,
 * however loaded the machine is. Pausing after the page has loaded would race the
 * running clock (and the catalogs' own real-time delay).
 */
async function stopClock(page: Page): Promise<void> {
  const origin = Date.now();
  await page.clock.install({ time: origin });
  await page.clock.pauseAt(origin + CLOCK_LEAD_MS);
}

test('a cold remembered model blocks the first send until its own catalog answers', async ({ lab, page }) => {
  await page.addInitScript(({ workspace, modelKey }) => {
    localStorage.setItem('piui.shell.newchat.v1', JSON.stringify({
      [workspace]: { harness: 'codex', modelKey, thinkingLevel: 'high', fast: true },
    }));
  }, { workspace: DEMO_PROJECTS.piui, modelKey: codexModel });
  await lab.open('demo', '&catalog=slow');
  const home = page.getByRole('region', { name: 'What should we work on?' });
  const message = home.getByRole('textbox', { name: 'Message' });
  const start = home.getByRole('button', { name: 'Start chat' });
  await expect(home.getByRole('button', { name: 'Choose a model' })).toHaveAttribute('aria-busy', 'true');
  await message.fill('Use my remembered model');
  await expect(start).toBeDisabled();
  await message.press('Enter');
  await expect(message).toHaveValue('Use my remembered model');
  await expect(home.getByRole('button', { name: /^GPT Lab 5 Codex high/ })).toBeVisible();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Use my remembered model');
});

test('an unavailable remembered model requires a deliberate choice', async ({ lab, page }) => {
  await page.addInitScript(({ workspace }) => {
    localStorage.setItem('piui.shell.newchat.v1', JSON.stringify({
      [workspace]: { harness: 'codex', modelKey: JSON.stringify(['openai-lab', 'removed-model']) },
    }));
  }, { workspace: DEMO_PROJECTS.piui });
  await lab.open();
  const home = page.getByRole('region', { name: 'What should we work on?' });
  await home.getByRole('textbox', { name: 'Message' }).fill('Keep the draft');
  const start = home.getByRole('button', { name: 'Start chat' });
  const models = home.getByRole('button', { name: 'Choose a model' });
  await expect(models).not.toHaveAttribute('aria-busy', 'true');
  await expect(start).toBeDisabled();
  await models.click();
  await lab.option(/^Harness default/).click();
  await expect(start).toBeEnabled();
});

test('the pipeline assistant restores the session harness, model, reasoning and Fast', async ({ lab, page }) => {
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Release check', exact: true }).click();
  const toggle = editor.getByRole('button', { name: 'Assistant', exact: true });
  await toggle.click();
  const assistant = page.getByRole('complementary', { name: 'Pipeline assistant' });
  await assistant.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await lab.option(/^Codex/).click();
  await assistant.getByRole('button', { name: 'Default model' }).click();
  await lab.option(/^GPT Lab 5 Codex/).click();
  await page.getByRole('radio', { name: 'high', exact: true }).click();
  await page.getByRole('switch', { name: 'Fast mode' }).click();
  await page.keyboard.press('Escape');
  await assistant.getByRole('textbox', { name: 'Message to the assistant' }).fill('Explain this pipeline');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant.getByRole('button', { name: 'New conversation' })).toBeEnabled();
  const stop = assistant.getByRole('button', { name: 'Stop', exact: true });
  await stop.click();
  await expect(stop).toBeHidden();
  await assistant.getByRole('button', { name: 'Close assistant' }).click();
  await page.evaluate((modelKey) => localStorage.setItem('piui.pipeline.assistant.model.v1', JSON.stringify({ codex: modelKey })), codexMini);
  await toggle.click();

  await expect(assistant.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
  await assistant.getByRole('button', { name: /^GPT Lab 5 Codex high/ }).click();
  await expect(page.getByRole('radio', { name: 'high', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Fast mode' })).toBeChecked();
});

test('the assistant can send with the default model while catalogs have not answered', async ({ lab, page }) => {
  await stopClock(page);
  await lab.open('demo', '&catalog=slow');
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Assistant', exact: true }).click();
  const assistant = page.getByRole('complementary', { name: 'Pipeline assistant' });
  const message = assistant.getByRole('textbox', { name: 'Message to the assistant' });
  await message.fill('Build a review pipeline');
  await message.press('Enter');
  await expect(assistant.getByRole('button', { name: 'New conversation' })).toBeEnabled();
});

test('reopening the assistant while the first send is pending keeps the same conversation', async ({ lab, page }) => {
  const createRequests: unknown[] = [];
  let releaseCreate!: () => void;
  const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
  await page.exposeFunction('holdAssistantCreate', async (command: unknown) => {
    createRequests.push(command);
    await createPending;
  });
  await page.route('**/src/host-api/lab/labHost.ts*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      'const handler = handlers[command];',
      'if (command === "workspace_command_v15" && args.command?.type === "createSession") await window.holdAssistantCreate(args.command);\nconst handler = handlers[command];',
    );
    await route.fulfill({ response, body });
  });
  await lab.open();
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Release check', exact: true }).click();
  const toggle = editor.getByRole('button', { name: 'Assistant', exact: true });
  await toggle.click();
  const assistant = page.getByRole('complementary', { name: 'Pipeline assistant' });
  const message = assistant.getByRole('textbox', { name: 'Message to the assistant' });
  try {
    await message.fill('Start the assistant once');
    await message.press('Enter');
    await expect.poll(() => createRequests.length).toBe(1);
    await assistant.getByRole('button', { name: 'Close assistant' }).click();
    await toggle.click();
    await message.fill('Send a second first message');
    await expect(assistant.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await message.press('Enter');
  } finally {
    releaseCreate();
  }
  await expect(assistant.getByText('Start the assistant once', { exact: true })).toBeVisible();
  expect(createRequests).toHaveLength(1);
});

test('fresh catalog capabilities clear obsolete reasoning and Fast for a new assistant conversation', async ({ lab, page }) => {
  await stopClock(page);
  await lab.open('demo', '&catalog=slow');
  // The Nano account starts a moment after first paint and drops every remembered catalog
  // of the agents with a Nano model source, so a catalog remembered before that is gone.
  // Let it start first; what is remembered below is what the assistant then finds.
  await page.clock.runFor(NANO_START_MS);
  await expect(lab.sidebar.getByRole('button', { name: 'Sign in to Nano' })).toBeVisible();
  await page.evaluate((workspaceId) => {
    const harness = 'prime-agent';
    const model = { id: 'prime-lab-small', provider: 'prime-lab', name: 'Prime Lab Small', thinkingLevels: ['high'], supportsFast: true };
    localStorage.setItem('piui.pipeline.assistant.model.v1', JSON.stringify({ [harness]: JSON.stringify([model.provider, model.id]) }));
    localStorage.setItem('piui.harness.catalog.v1:' + JSON.stringify([workspaceId, harness]), JSON.stringify({
      at: Date.now(), result: { protocol: 18, harness, models: [model], resources: { items: [], warnings: [] } },
    }));
  }, DEMO_PROJECTS.piui);
  const editor = await lab.openPipelines();
  await editor.getByRole('button', { name: 'Assistant', exact: true }).click();
  const assistant = page.getByRole('complementary', { name: 'Pipeline assistant' });
  await assistant.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await lab.option(/^Prime Agent/).click();
  await assistant.getByRole('button', { name: 'Prime Lab Small', exact: true }).click();
  await page.getByRole('radio', { name: 'high', exact: true }).click();
  await page.getByRole('switch', { name: 'Fast mode' }).click();
  await page.keyboard.press('Escape');
  await expect(assistant.getByRole('button', { name: 'Prime Lab Small high', exact: true })).toBeVisible();
  // Only the remembered levels existed until now; the slow probe answers here.
  await page.clock.runFor(SLOW_CATALOG_MS);
  await assistant.getByRole('button', { name: 'Prime Lab Small', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'high', exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Fast mode' })).toHaveCount(0);
});
