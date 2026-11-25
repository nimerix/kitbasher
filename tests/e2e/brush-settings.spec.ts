import { expect, test } from '@playwright/test';

for (const tool of ['Sculpt', 'Warp', 'Refine']) {
  test(`right-click and shortcuts resize the active ${tool} brush`, async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
    await page
      .getByRole('toolbar', { name: 'Assembly tools' })
      .getByRole('button', { name: new RegExp('^' + tool + '\\b') })
      .click();
    if (tool === 'Refine') await page.getByRole('radio', { name: 'Brush', exact: true }).click();
    const inspectorRadius = page.getByRole('spinbutton', {
      name: tool === 'Sculpt' ? 'Radius' : 'Brush radius',
      exact: true,
    });
    await expect(inspectorRadius).toBeVisible();
    await canvas.click({ button: 'right' });
    const popup = page.getByRole('dialog', { name: 'Brush settings' });
    const radius = popup.getByRole('spinbutton', { name: 'Brush radius' });
    await expect(radius).toBeFocused();
    await radius.fill('2');
    await popup.getByRole('button', { name: 'Done' }).click();
    await expect(inspectorRadius).toHaveValue('2');
    await page.keyboard.press(']');
    await expect(inspectorRadius).toHaveValue('2.5');
    await page.keyboard.press('[');
    await expect(inspectorRadius).toHaveValue('2');
    await page.keyboard.press('Shift+F10');
    await expect(radius).toBeFocused();
    await expect(radius).toHaveValue('2');
    if (tool === 'Warp') await expect(popup.getByRole('button', { name: 'Erase' })).toBeVisible();
    else await expect(popup.getByRole('button', { name: 'Erase' })).toHaveCount(0);
  });
}
