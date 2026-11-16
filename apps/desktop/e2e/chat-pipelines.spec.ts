import type { Locator, Page } from '@playwright/test';
import { labUuid } from '../src/host-api/lab/labRandom';
import { expect, test, type Lab } from './fixtures';

// Same seed as demoChats, without loading the browser-only Lab runtime in Node.
const demoProjectId = labUuid('demo:project:piui');

/** The composer on Home ("What should we work on?"). */
function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

test.describe('chat pipelines', () => {
  test('a new chat goes through a pipeline, then the chat agent gets its result', async ({ lab, page }) => {
    test.slow(); // The lab run and the follow-up turn use real timers.
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Code review');
    await lab.option(/^Code review/).click();
    // A pipeline picks the models of its steps; only who answers stays.
    await expect(composer.getByRole('button', { name: 'Default model' })).toHaveCount(0);
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toContainText('then Prime Agent continues the chat');

    await composer.getByRole('textbox', { name: 'Message' }).fill('Review the login flow for session fixation');
    await composer.getByRole('button', { name: 'Start chat' }).click();

    const card = page.getByRole('article', { name: 'Pipeline run: Code review' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Succeeded', { timeout: 30_000 });
    await expect(card).toContainText('Answer from Reviewer');

    // Follow-ups talk to the chat's own agent and carry the result once.
    await expect(page.getByText('The next message hands the pipeline result to Prime Agent.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('Summarize the risks in two bullets');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    await expect(transcript.getByText('Handed on the result of Code review')).toBeVisible();
    await expect(page.getByText('The next message hands the pipeline result to Prime Agent.')).toHaveCount(0);
  });

  test('a template chosen in the composer is saved and run on send, without opening the editor', async ({ lab, page }) => {
    test.slow(); // The lab run uses real timers.
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('radio', { name: 'Pipelines' }).click();
    await lab.option(/^Review loop.*built-in/).click();

    // Choosing only selects: the editor stays closed and the chip names the template.
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Review loop', exact: true })).toBeVisible();
    await expect(page.getByText('Sending saves this template as a pipeline in this project.')).toBeVisible();
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toContainText('Runs Review loop');

    await composer.getByRole('textbox', { name: 'Message' }).fill('Add input validation to the signup form');
    await composer.getByRole('button', { name: 'Start chat' }).click();

    await expect(lab.toast(/Saved .Review loop. to this project.s pipelines/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toHaveCount(0);
    await expect(page.getByRole('article', { name: 'Pipeline run: Review loop' })).toBeVisible({ timeout: 30_000 });
  });

  test('the executor picker has a Direct and a Pipelines tab, and only Pipelines offers the editor', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    const search = page.getByRole('combobox', { name: 'Who answers' });
    const manage = page.getByRole('button', { name: 'Manage pipelines' });
    const tabs = page.getByRole('group', { name: 'Executor type' });

    // Opens on the tab of the current executor, with the search focused.
    await expect(search).toBeFocused();
    await expect(tabs.getByRole('radio', { name: 'Direct' })).toBeChecked();
    await expect(manage).toHaveCount(0);
    await expect(lab.option(/^Review loop/)).toHaveCount(0);

    // Left and right switch the tab while the search is empty; clicking a tab keeps the search focused.
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('radio', { name: 'Pipelines' })).toBeChecked();
    await expect(lab.option(/^Review loop.*built-in/)).toBeVisible();
    await expect(manage).toBeVisible();
    await tabs.getByRole('radio', { name: 'Direct' }).click();
    await expect(search).toBeFocused();
    await expect(manage).toHaveCount(0);

    // A search spans both tabs.
    await search.fill('Review loop');
    await expect(lab.option(/^Review loop.*built-in/)).toBeVisible();
    await search.fill('');

    await tabs.getByRole('radio', { name: 'Pipelines' }).click();
    await manage.click();
    await expect(page.getByRole('region', { name: 'Pipeline editor' })).toBeVisible({ timeout: 30_000 });
  });

  test('project, permissions and worktree share one keyboard-operable chip', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    const chip = composer.getByRole('button', { name: /^Project and permissions: piui/ });
    await chip.focus();
    await page.keyboard.press('Enter');
    const readOnly = page.getByRole('radio', { name: /^Read only/ });
    await readOnly.check();
    await page.keyboard.press('Escape');
    await expect(composer.getByRole('button', { name: /^Project and permissions: piui · Read only$/ })).toBeVisible();
  });
});

test.describe('the executor of a new chat', () => {
  const CHOICE_KEY = 'piui.shell.newchat.v1';

  test('starts as the last one chosen: a pipeline or a harness, also after a restart', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    const pipeline = composer.getByRole('group', { name: 'Pipeline for this message' });
    await expect(composer.getByRole('button', { name: 'Pi', exact: true })).toBeVisible();
    await expect(pipeline).toHaveCount(0);

    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Code review');
    await lab.option(/^Code review/).click();
    await expect(pipeline).toContainText('then Prime Agent continues the chat');

    // Another screen and back: a new composer starts with the pipeline.
    await lab.openRuns();
    await lab.nav('New chat').click();
    await expect(composer.getByRole('button', { name: 'Code review', exact: true })).toBeVisible();
    await expect(pipeline).toContainText('then Prime Agent continues the chat');

    // A restart: the lab host starts over, the stored picks stay.
    await page.reload();
    await expect(lab.sidebar).toBeVisible({ timeout: 30_000 });
    await expect(composer.getByRole('button', { name: 'Code review', exact: true })).toBeVisible();
    await expect(pipeline).toContainText('then Prime Agent continues the chat');

    // A harness chosen instead is what the next chat starts with.
    await composer.getByRole('button', { name: 'Code review', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Codex');
    await lab.option(/^Codex/).click();
    await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await expect(pipeline).toHaveCount(0);
    await page.reload();
    await expect(lab.sidebar).toBeVisible({ timeout: 30_000 });
    await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await expect(pipeline).toHaveCount(0);
  });

  test('a remembered pipeline that is gone falls back to the harness without an error', async ({ lab, page }) => {
    await page.addInitScript(({ workspace, key }) => {
      localStorage.setItem(key, JSON.stringify({
        [workspace]: { harness: 'codex', executor: { pipeline: 'deleted-pipeline', chatDefault: '' } },
      }));
    }, { workspace: demoProjectId, key: CHOICE_KEY });
    await lab.open();
    const composer = home(page);
    await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    // The check of the remembered pipeline is asynchronous: give it the time it needs to have failed.
    await page.waitForTimeout(500);
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await expect(page.getByText(/no longer saved/)).toHaveCount(0);
    await expect(composer.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  test('safe mode keeps talking to the harness even when a pipeline was remembered', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Code review');
    await lab.option(/^Code review/).click();
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toBeVisible();

    await lab.open('safe');
    await expect(composer.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await page.waitForTimeout(500);
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Code review', exact: true })).toHaveCount(0);
  });

  /**
   * Restarts the lab with the launch command read held back, as a slow host would answer. The first
   * page load has no hold: the pipeline is chosen there, so a restart finds it remembered.
   */
  async function restartWithSlowPipelineRead(page: Page): Promise<{ release: () => void; reads: () => number }> {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.exposeFunction('holdLaunchCommand', async () => {
      reads += 1;
      await gate;
    });
    await page.route('**/src/host-api/lab/labHost.ts*', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        'const handler = handlers[command];',
        'if (command === "orchestration_get_launch_command_v6") await window.holdLaunchCommand();\nconst handler = handlers[command];',
      );
      await route.fulfill({ response, body });
    });
    await page.reload();
    return { release, reads: () => reads };
  }

  async function chooseReviewPipeline(lab: Lab, page: Page): Promise<void> {
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await page.getByRole('combobox', { name: 'Who answers' }).fill('Code review');
    await lab.option(/^Code review/).click();
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toBeVisible();
  }

  test('a send waits for the remembered pipeline to be checked, then goes through it', async ({ lab, page }) => {
    await lab.open();
    await chooseReviewPipeline(lab, page);
    const { release, reads } = await restartWithSlowPipelineRead(page);
    const composer = home(page);
    const message = composer.getByRole('textbox', { name: 'Message' });
    const start = composer.getByRole('button', { name: 'Start chat' });
    try {
      await expect(lab.sidebar).toBeVisible({ timeout: 30_000 });
      await expect.poll(reads).toBeGreaterThan(0);
      await message.fill('Review the login flow');
      // The check is still open: neither the button nor Enter starts a direct chat that would replace the memory.
      await expect(start).toBeDisabled();
      await message.press('Enter');
      await expect(message).toHaveValue('Review the login flow');
      await expect(page.getByRole('heading', { level: 1, name: 'What should we work on?' })).toBeVisible();
    } finally {
      release();
    }
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toContainText('then Prime Agent continues the chat');
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole('article', { name: 'Pipeline run: Code review' })).toBeVisible({ timeout: 30_000 });
  });

  test('choosing in the picker ends the wait at once and the choice stands', async ({ lab, page }) => {
    await lab.open();
    await chooseReviewPipeline(lab, page);
    const { release, reads } = await restartWithSlowPipelineRead(page);
    const composer = home(page);
    const start = composer.getByRole('button', { name: 'Start chat' });
    try {
      await expect(lab.sidebar).toBeVisible({ timeout: 30_000 });
      await expect.poll(reads).toBeGreaterThan(0);
      await composer.getByRole('textbox', { name: 'Message' }).fill('Talk to the harness');
      await expect(start).toBeDisabled();
      await composer.getByRole('button', { name: 'Pi', exact: true }).click();
      await page.getByRole('combobox', { name: 'Who answers' }).fill('Codex');
      await lab.option(/^Codex/).click();
      await expect(start).toBeEnabled();
    } finally {
      release();
    }
    // The late answer about the remembered pipeline does not take the person's choice back.
    await page.waitForTimeout(500);
    await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
    await expect(composer.getByRole('group', { name: 'Pipeline for this message' })).toHaveCount(0);
  });
});

test.describe('pipeline code that cannot load', () => {
  // The refused module request is logged by the browser.
  test.use({ allowConsoleErrors: true });

  test('a new chat still talks directly, and the chip offers to load again', async ({ lab, page }) => {
    await page.route('**/src/app/chatPipelines/pipelineCode.ts*', (route) => route.abort());
    await lab.open();
    const composer = home(page);
    const chip = composer.getByRole('button', { name: 'Pi', exact: true });
    await expect(chip).toHaveAttribute('title', 'Pipelines could not be loaded. Try again.');
    await expect(chip).toBeEnabled();

    await composer.getByRole('textbox', { name: 'Message' }).fill('Say hello without a pipeline');
    await composer.getByRole('button', { name: 'Start chat' }).click();
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('Say hello without a pipeline');
  });
});
