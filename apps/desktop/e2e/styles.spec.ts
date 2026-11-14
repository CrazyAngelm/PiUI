import { expect, test } from './fixtures';

test.describe('built-in styles', () => {
  test('reasoning ramp geometry follows Nano, Chaos and plugin ornaments without changing input', async ({ lab, page }) => {
    await lab.open();
    const home = page.getByRole('region', { name: 'What should we work on?' });
    async function verifyRamp(slanted: boolean, radius: string, overhang: string): Promise<void> {
      await lab.nav('New chat').click();
      await home.getByRole('button', { name: 'Pi', exact: true }).click();
      await lab.option(/^Codex/).click();
      await home.getByRole('button', { name: /^(Default model|Choose a model)$/ }).click();
      await lab.option(/^GPT Lab 5 Codex/).click();
      const ramp = page.getByRole('radiogroup', { name: 'Reasoning', exact: true });
      await expect(ramp).toBeVisible();
      await expect(ramp.getByRole('radio').first()).toHaveCSS('border-top-left-radius', radius);
      const geometry = await ramp.evaluate((group) => {
        const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        const auto = radios.find((radio) => radio.textContent?.trim() === 'Auto');
        const label = auto?.querySelector('.name');
        const bar = group.querySelector('.bar');
        if (!label || !bar) throw new Error('Missing actual reasoning presentation');
        const skew = (element: Element): number => new DOMMatrix(getComputedStyle(element).transform).c;
        return {
          skews: radios.map(skew),
          labelSkew: skew(label),
          radii: radios.map((radio) => getComputedStyle(radio).borderTopLeftRadius),
          barRadius: getComputedStyle(bar).borderTopLeftRadius,
          overhang: getComputedStyle(group).paddingRight,
          tilt: getComputedStyle(group).getPropertyValue('--tilt').trim(),
          hitTargets: radios.map((radio) => {
            const rect = radio.getBoundingClientRect();
            return document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)?.closest('[role="radio"]') === radio;
          }),
        };
      });
      expect(geometry.tilt).toBe(slanted ? '-12deg' : '0deg');
      for (const skew of geometry.skews) {
        if (slanted) expect(skew).toBeLessThan(0);
        else expect(skew).toBe(0);
      }
      expect(geometry.skews.every((skew) => skew === geometry.skews[0])).toBe(true);
      expect(geometry.labelSkew + geometry.skews[0]!).toBe(0);
      expect(geometry.radii.every((value) => value === radius)).toBe(true);
      expect(geometry.barRadius).toBe(radius);
      expect(geometry.overhang).toBe(overhang);
      expect(geometry.hitTargets.every(Boolean)).toBe(true);
      const high = ramp.getByRole('radio', { name: 'high', exact: true });
      await high.click();
      await expect(high).toBeChecked();
      await high.press('Home');
      const auto = ramp.getByRole('radio', { name: 'Auto', exact: true });
      await expect(auto).toBeChecked();
      await auto.press('ArrowRight');
      await expect(ramp.getByRole('radio').nth(1)).toBeChecked();
      await page.keyboard.press('Escape');
    }

    await verifyRamp(false, '6px', '0px');
    await lab.openSettings();
    const styles = page.getByRole('group', { name: 'Visual style', exact: true });
    await styles.getByRole('radio', { name: 'Chaos', exact: true }).click();
    await verifyRamp(true, '0px', '7px');
    await lab.openSettings();
    const theme = page.getByLabel('Plugin theme', { exact: true });
    await theme.selectOption(JSON.stringify(['example.paper-style', 'paper']));
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    await verifyRamp(false, '10px', '0px');
    await lab.openSettings();
    await theme.selectOption(JSON.stringify(['example.paper-style', 'terminal']));
    await expect(page.locator('html')).toHaveAttribute('data-plugin-style', 'true');
    await verifyRamp(true, '0px', '7px');
    await lab.openSettings();
    await styles.getByRole('radio', { name: 'Nano', exact: true }).click();
    await theme.selectOption('');
    await expect(page.locator('html')).not.toHaveAttribute('data-plugin-style');
    await verifyRamp(false, '6px', '0px');
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
