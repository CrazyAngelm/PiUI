import { expect, test } from './fixtures';

test.describe('built-in styles', () => {
  test('reasoning gauge geometry follows Nano, Chaos and plugin ornaments without changing input', async ({ lab, page }) => {
    await lab.open();
    const home = page.getByRole('region', { name: 'What should we work on?' });
    // A harness and model picked for a new chat stay picked for the next one.
    let picked = false;
    async function verifyGauge(slanted: boolean, radius: string): Promise<void> {
      await lab.nav('New chat').click();
      if (picked) {
        await home.getByRole('button', { name: /^GPT Lab 5 Codex/ }).click();
      } else {
        await home.getByRole('button', { name: 'Pi', exact: true }).click();
        await lab.option(/^Codex/).click();
        await home.getByRole('button', { name: /^(Default model|Choose a model)$/ }).click();
        await lab.option(/^GPT Lab 5 Codex/).click();
        picked = true;
      }
      const gauge = page.getByRole('radiogroup', { name: 'Reasoning', exact: true });
      await expect(gauge).toBeVisible();
      const geometry = await gauge.evaluate((group) => {
        const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        const dock = group.querySelector('.dock');
        const icon = dock?.querySelector('svg');
        const track = group.querySelector('.track');
        const tick = group.querySelector('.stop:not(.stop--zero) .tick');
        const thumb = group.querySelector('.thumb:not(.thumb--ghost)');
        if (!dock || !icon || !track || !tick || !thumb) throw new Error('Missing actual reasoning presentation');
        const skew = (element: Element, pseudo?: string): number => new DOMMatrix(getComputedStyle(element, pseudo).transform).c;
        return {
          tilt: getComputedStyle(group).getPropertyValue('--tilt').trim(),
          slants: [skew(track), skew(tick), skew(dock), skew(thumb, '::before')],
          iconSkew: skew(icon),
          buttonSkews: radios.map((radio) => skew(radio)),
          tickRadius: getComputedStyle(tick).borderTopLeftRadius,
          thumbRadius: getComputedStyle(thumb, '::before').borderTopLeftRadius,
          hitTargets: radios.map((radio) => {
            const rect = radio.getBoundingClientRect();
            return document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)?.closest('[role="radio"]') === radio;
          }),
        };
      });
      expect(geometry.tilt).toBe(slanted ? '-12deg' : '0deg');
      for (const slant of geometry.slants) {
        if (slanted) expect(slant).toBeLessThan(0);
        else expect(slant).toBe(0);
      }
      expect(geometry.slants.every((slant) => slant === geometry.slants[0])).toBe(true);
      // The icon cancels the dock's lean; the buttons themselves never lean.
      expect(geometry.iconSkew + geometry.slants[0]!).toBeCloseTo(0);
      expect(geometry.buttonSkews.every((value) => value === 0)).toBe(true);
      expect(geometry.tickRadius).toBe(radius);
      expect(geometry.thumbRadius).toBe(radius);
      expect(geometry.hitTargets.every(Boolean)).toBe(true);

      // A press that slides along the rail picks the stop it is released on.
      const low = gauge.getByRole('radio', { name: 'low', exact: true });
      const xhigh = gauge.getByRole('radio', { name: 'xhigh', exact: true });
      const from = await low.boundingBox();
      const to = await xhigh.boundingBox();
      if (!from || !to) throw new Error('Missing reasoning stops');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(xhigh).toBeChecked();
      // A slide leaves no click behind on a stop, and Enter still picks the focused one.
      await low.press('Enter');
      await expect(low).toBeChecked();

      // Synthetic pointers: a second finger neither steers nor ends the first one's slide,
      // and the click a touch slide leaves on its starting stop does not undo it.
      const medium = gauge.getByRole('radio', { name: 'medium', exact: true });
      const high = gauge.getByRole('radio', { name: 'high', exact: true });
      const centre = async (stop: typeof low): Promise<number> => {
        const box = await stop.boundingBox();
        if (!box) throw new Error('Missing reasoning stop');
        return box.x + box.width / 2;
      };
      const send = (type: string, pointerId: number, clientX: number, target: typeof low | null): Promise<void> => {
        const init = { pointerId, pointerType: 'touch', isPrimary: true, button: 0, clientX, clientY: 0, bubbles: true, cancelable: true };
        return target
          ? target.evaluate((element, event) => void element.dispatchEvent(new PointerEvent(event.type, event.init)), { type, init })
          : page.evaluate((event) => void window.dispatchEvent(new PointerEvent(event.type, event.init)), { type, init });
      };
      await send('pointerdown', 11, await centre(low), low);
      await send('pointermove', 12, await centre(medium), null);
      await send('pointerup', 12, await centre(medium), null);
      await send('pointerup', 11, await centre(high), null);
      await expect(high).toBeChecked();

      await send('pointerdown', 13, await centre(low), low);
      await send('pointerup', 13, await centre(xhigh), null);
      await low.evaluate((element) => void element.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true })));
      await expect(xhigh).toBeChecked();
      // Let the lab apply a wrong second pick, if there were one, before the negative check.
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      await expect(xhigh).toBeChecked();
      await expect(low).not.toBeChecked();

      await high.click();
      await expect(high).toBeChecked();
      await high.press('Home');
      const auto = gauge.getByRole('radio', { name: 'Auto', exact: true });
      await expect(auto).toBeChecked();
      await auto.press('ArrowRight');
      await expect(gauge.getByRole('radio').nth(1)).toBeChecked();
      await page.keyboard.press('Escape');
    }

    await verifyGauge(false, '6px');
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).click();
    await verifyGauge(true, '0px');
    await lab.openSettings();
    const theme = page.getByLabel('Plugin theme', { exact: true });
    await theme.selectOption(JSON.stringify(['example.paper-style', 'paper']));
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    await verifyGauge(false, '10px');
    await lab.openSettings();
    await theme.selectOption(JSON.stringify(['example.paper-style', 'terminal']));
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    await verifyGauge(true, '0px');
    await lab.openSettings();
    await styles.getByRole('radio', { name: 'Nano', exact: true }).click();
    await theme.selectOption('');
    await expect(page.locator('html')).not.toHaveAttribute('data-plugin-style');
    await verifyGauge(false, '6px');
  });

  test('starts in Nano and changes style independently from appearance by keyboard', async ({ lab, page }) => {
    await lab.open();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
    await lab.openSettings();
    const identityColors = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['chaos', 'chaos-gold', 'chaos-spark', 'accent'].map((token) => css.getPropertyValue(`--piui-${token}`).trim());
    });
    expect(new Set(identityColors).size).toBe(identityColors.length);
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    const appearance = page.getByRole('group', { name: 'Theme', exact: true });
    await appearance.getByRole('radio', { name: 'Light', exact: true }).press('Enter');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(styles.getByRole('radio', { name: 'Chaos', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-action').trim())).toBe('#9e354e');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-action').trim())).toBe('#107150');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-decoration-marker-shape').trim())).toBe('none');
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await lab.openSettings();
    await expect(styles.getByRole('radio', { name: 'Chaos', exact: true })).toBeChecked();
  });

  test('follows system appearance in both styles', async ({ lab, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await lab.open();
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#ebefee');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#101513');
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#131214');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-bg').trim())).toBe('#f4f4f4');
  });

  test('reports blocked persistence while still applying the choice', async ({ lab, page }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key === 'piui.appearance.style') throw new DOMException('Storage blocked', 'SecurityError');
        setItem.call(this, key, value);
      };
    });
    await lab.open();
    await lab.openSettings();
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await expect(page.getByRole('status').filter({ hasText: 'This style could not be saved.' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
  });

  test('keeps the fallback of partial plugin palettes across style changes', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    await page.getByLabel('Plugin theme', { exact: true }).selectOption(JSON.stringify(['example.midnight-theme', 'partial']));
    const action = () => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return [css.getPropertyValue('--piui-action').trim(), css.getPropertyValue('--piui-action-ink').trim()];
    });
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    const ornament = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--piui-decoration-secondary').trim());
    await expect.poll(ornament).toBe('#f0c050');
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Chaos', exact: true }).click();
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    await page.getByRole('group', { name: 'Visual style', exact: true }).getByRole('radio', { name: 'Nano', exact: true }).click();
    await expect.poll(action).toEqual(['#9e354e', '#eeeeee']);
    await expect.poll(ornament).toBe('#f0c050');
    await page.getByLabel('Plugin theme', { exact: true }).selectOption('');
    await expect.poll(action).toEqual(['#10845e', '#ffffff']);
  });

  test('works in safe mode without Nano requests from the WebView', async ({ lab, page }) => {
    const nanoRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).hostname.endsWith('nanoagents.ru')) nanoRequests.push(request.url());
    });
    await lab.open('safe');
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'chaos');
    await styles.getByRole('radio', { name: 'Nano', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'nano');
    expect(nanoRequests).toEqual([]);
  });

  test('applies a declared plugin style and restores built-ins when its owner is disabled', async ({ lab, page }) => {
    await lab.open();
    await lab.openSettings();
    const theme = page.getByLabel('Plugin theme', { exact: true });
    await theme.focus();
    await theme.selectOption(JSON.stringify(['example.paper-style', 'paper']));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    const presentation = () => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['radius-md', 'decoration-marker-shape', 'font-ui'].map((token) => css.getPropertyValue(`--piui-${token}`).trim());
    });
    await expect.poll(presentation).toEqual(['16px', 'none', '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif']);
    await theme.selectOption(JSON.stringify(['example.paper-style', 'terminal']));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(async () => (await presentation()).slice(0, 2)).toEqual(['0px', 'polygon(40% 0, 100% 0, 60% 100%, 0 100%)']);
    await expect.poll(async () => (await presentation())[2]).toContain('Cascadia Code');
    const appearance = page.getByRole('group', { name: 'Theme', exact: true });
    await appearance.getByRole('radio', { name: 'Light', exact: true }).press('Enter');
    await expect(page.locator('html')).not.toHaveAttribute('data-plugin-style');
    await expect.poll(async () => (await presentation()).slice(0, 2)).toEqual(['10px', 'none']);
    await appearance.getByRole('radio', { name: 'Dark', exact: true }).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Plugins' }).click();
    const toggle = page.getByRole('article', { name: 'Paper style', exact: true }).getByRole('switch', { name: 'Enable Paper style' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('html')).not.toHaveAttribute('data-plugin-style');
    await expect.poll(async () => (await presentation()).slice(0, 2)).toEqual(['10px', 'none']);
    await page.keyboard.press('Space');
    await expect(toggle).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
  });
});
