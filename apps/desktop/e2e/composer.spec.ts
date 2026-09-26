import type { Locator, Page } from '@playwright/test';
import { expect, test, type Lab } from './fixtures';

/**
 * Composer inputs in the UI Lab: attachments (paperclip, paste, drop),
 * path references, `@` project files, harness `/` commands and `$` skills.
 * The lab's file dialog returns a screenshot and a project PDF; nothing is
 * read from disk and no model turn runs.
 */
const SCREENSHOT = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAY0lEQVR4nGPQUtMYVIhhwF0w6qAh76AKDYtBhUYdNPQchJam3rx4RGdEIJchK63IK6EEUd9Bgy6ERh005BxEYaImMrEP5RAaddCQc9BoST3qoGHnoNGSGpuDBhyNOmjUQZQiAPldjjHC8MlzAAAAAElFTkSuQmCC';

function home(page: Page): Locator {
  return page.getByRole('region', { name: 'What should we work on?' });
}

async function openChat(lab: Lab, title: RegExp): Promise<Locator> {
  await lab.chat(title).click();
  const message = lab.page.getByRole('textbox', { name: 'Message' });
  await expect(message).toBeVisible();
  return message;
}

/** Pastes or drops an image file, the way the clipboard or a browser drop delivers it. */
async function deliverImage(page: Page, kind: 'paste' | 'drop', name: string): Promise<void> {
  await page.evaluate(
    ({ kind, name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: 'image/png' }));
      const input = document.querySelector('textarea[aria-label="Message"]');
      if (!input) throw new Error('No composer');
      if (kind === 'paste') {
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      } else {
        const zone = input.parentElement ?? input;
        zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
        zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      }
    },
    { kind, name, base64: SCREENSHOT },
  );
}

test.describe('attachments', () => {
  test('the paperclip attaches a screenshot and confirms a file reference; remove discards the image', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    const message = composer.getByRole('textbox', { name: 'Message' });
    await message.fill('What is wrong on this screen?');
    await composer.getByRole('button', { name: 'Attach images or files' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reference this file by its path?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('PiUI does not upload, copy or attach them.');
    await expect(dialog.getByRole('list', { name: 'File references' })).toContainText('@docs/lab-spec.pdf');
    await dialog.getByRole('button', { name: 'Insert references' }).click();
    await expect(dialog).toBeHidden();
    await expect(message).toHaveValue('What is wrong on this screen? @docs/lab-spec.pdf ');
    const images = composer.getByRole('list', { name: 'Attached images' });
    await expect(images.getByRole('img', { name: 'Preview of lab-screenshot.png' })).toBeVisible();
    await images.getByRole('button', { name: 'Remove lab-screenshot.png' }).click();
    await expect(images).toHaveCount(0);

    // A pasted image is sent with the first message and shows in the transcript.
    await deliverImage(page, 'paste', 'pasted.png');
    await expect(composer.getByRole('list', { name: 'Attached images' }).getByText('pasted.png')).toBeVisible();
    await composer.getByRole('button', { name: 'Start chat' }).click();
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    await expect(transcript.getByText('What is wrong on this screen? @docs/lab-spec.pdf')).toBeVisible();
    await expect(transcript.getByRole('list', { name: 'Attached images' }).getByText('Image')).toBeVisible();
  });

  test('a harness without image input explains why the paperclip is unavailable', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    await composer.getByRole('button', { name: 'Pi', exact: true }).click();
    await lab.option(/^Prime Agent/).click();
    const attach = composer.getByRole('button', { name: 'Attach images or files' });
    await expect(attach).toHaveAttribute('aria-disabled', 'true');
    await expect(attach).toHaveAccessibleDescription('Prime Agent accepts text only in PiUI.');
    // Still focusable, so the reason can be read; activating it opens nothing.
    await attach.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // A dropped image is refused with the reason instead of being dropped silently.
    await deliverImage(page, 'drop', 'dropped.png');
    await expect(composer.getByRole('alert')).toContainText('dropped.png was not attached. Prime Agent accepts text only in PiUI.');
    await expect(composer.getByRole('list', { name: 'Attached images' })).toHaveCount(0);
  });

  test('an image dropped on an open chat is queued with the message', async ({ lab, page }) => {
    await lab.open();
    const message = await openChat(lab, /Route host calls through one transport/);
    await deliverImage(page, 'drop', 'diagram.png');
    await expect(page.getByRole('list', { name: 'Attached images' }).getByText('diagram.png')).toBeVisible();
    await message.fill('Does this diagram match the transport?');
    await page.keyboard.press('Enter');
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    await expect(transcript.getByText('Does this diagram match the transport?')).toBeVisible({ timeout: 15_000 });
    await expect(transcript.getByRole('list', { name: 'Attached images' }).last()).toContainText('Image');
    await expect(page.getByRole('list', { name: 'Attached images' }).getByText('diagram.png')).toHaveCount(0);
  });
});

test.describe('mentions', () => {
  test('@ picks a project file with the keyboard', async ({ lab, page }) => {
    await lab.open();
    const composer = home(page);
    const message = composer.getByRole('textbox', { name: 'Message' });
    await message.fill('Explain @chat/comp');
    const files = page.getByRole('listbox', { name: 'Project files' });
    await expect(files.getByRole('option').first()).toHaveText('src/app/chat/ChatComposer.svelte');
    await expect(message).toHaveAttribute('aria-activedescendant', 'new-chat-menu-0');
    await page.keyboard.press('Enter');
    await expect(message).toHaveValue('Explain @src/app/chat/ChatComposer.svelte ');
    await expect(files).toBeHidden();
    // Escape closes the menu without changing the text.
    await message.pressSequentially('@READ');
    await expect(page.getByRole('listbox', { name: 'Project files' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Project files' })).toBeHidden();
    await expect(message).toHaveValue('Explain @src/app/chat/ChatComposer.svelte @READ');
  });

  test('/ lists the harness commands with a badge and inserts, never runs, them', async ({ lab, page }) => {
    await lab.open();
    const message = await openChat(lab, /Map pipeline editor shortcuts/);
    await message.fill('/rev');
    const commands = page.getByRole('listbox', { name: 'Available commands' });
    const review = commands.getByRole('option', { name: /\/review/ });
    await expect(review).toContainText('Claude');
    await expect(review).toContainText('Review the current changes');
    await review.click();
    await expect(message).toHaveValue('/review ');
    await expect(commands).toBeHidden();
    // PiUI's own commands keep their badge beside the native ones.
    await message.fill('/');
    await expect(page.getByRole('listbox', { name: 'Available commands' }).getByRole('option', { name: /\/run/ })).toContainText('PiUI');
  });

  test('$ inserts a Codex skill mention', async ({ lab, page }) => {
    await lab.open();
    const message = await openChat(lab, /Route host calls through one transport/);
    await message.fill('Please use $te');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option', { name: /\$test-runner/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(message).toHaveValue('Please use $test-runner ');
  });
});

test('a harness catalog refresh never undoes the new-chat harness and model pick', async ({ lab, page }) => {
  await lab.open();
  const composer = home(page);
  await composer.getByRole('button', { name: 'Pi', exact: true }).click();
  await lab.option(/^Codex/).click();
  await composer.getByRole('button', { name: 'Default model' }).click();
  await lab.option(/^GPT Lab 5 Codex/).click();
  await expect(composer.getByRole('button', { name: 'GPT Lab 5 Codex', exact: true })).toBeVisible();
  // Pinning a project reloads the workspace catalog (like any session event).
  await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
  await page.getByRole('menuitem', { name: 'Unpin' }).click();
  await lab.sidebar.getByRole('button', { name: 'Options for piui' }).click();
  await expect(page.getByRole('menuitem', { name: 'Pin to top' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(composer.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'GPT Lab 5 Codex', exact: true })).toBeVisible();
});
