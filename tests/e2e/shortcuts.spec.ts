import { expect, test, type Page } from '@playwright/test';
import { BoxGeometry } from 'three';
import { serializeGeometry } from '../../src/core/geometry';

// Browser plugin not available. Flow: OS shortcuts / right-click -> shared editor
// commands -> real selection, clipboard, part edits, and accessible context menu.
const fixture = {
  format: 'kitbasher',
  version: 1,
  units: 'mm',
  name: 'Shortcut workbench',
  parts: [
    { id: 'a', name: 'Moving piece', position: [-18, 30, 0], locked: false },
    { id: 'b', name: 'Target piece', position: [0, 30, 0], locked: false },
    { id: 'fixed', name: 'Fixed base', position: [0, 5, 0], locked: true },
  ].map((part) => ({
    ...part,
    geometry: serializeGeometry(new BoxGeometry(16, 16, 16)),
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    visible: true,
    color: '#c7a48c',
    source: 'test',
  })),
  joints: [
    {
      id: 'contact',
      name: 'Contact',
      parentId: 'a',
      childId: 'b',
      parentAnchor: [9, 0, 0],
      childAnchor: [-9, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, false, true],
      keepConnected: true,
    },
  ],
};

async function editorState(page: Page) {
  return page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const { useEditor } = await import(
      urls.find((url) => /\/src\/core\/store\.ts(?:\?.*)?$/.test(url))!
    );
    const fiber = await import(urls.find((url) => url.includes('/@react-three_fiber.js'))!);
    const root = fiber._roots.get(document.querySelector('canvas')).store.getState();
    const state = useEditor.getState();
    return {
      selected: state.selected as string[],
      revision: state.revision as number,
      parts: state.scene.parts.map((part: any) => ({
        id: part.id,
        name: part.name,
        position: part.position,
        pivot: part.pivot,
        visible: part.visible,
        locked: part.locked,
      })),
      joints: state.scene.joints as typeof fixture.joints,
      clipboard: state.clipboard?.parts.map((part: any) => part.id) as string[] | undefined,
      point: state.contextMenu?.point,
      camera: root.camera.position.toArray(),
      tool: state.tool,
    };
  });
}

async function screenPoint(page: Page, id: string, local: number[]) {
  const box = (await page.locator('canvas').boundingBox())!;
  const ndc = await page.evaluate(
    async ({ id, local }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((url) => url.includes('/@react-three_fiber.js'))!;
      const root = (await import(url))._roots
        .get(document.querySelector('canvas'))
        .store.getState();
      const mesh = root.scene.getObjectByName(`part:${id}`);
      mesh.updateWorldMatrix(true, false);
      const point = root.camera.position.clone().fromArray(local);
      return mesh.localToWorld(point).project(root.camera).toArray();
    },
    { id, local },
  );
  return { x: box.x + ((ndc[0] + 1) * box.width) / 2, y: box.y + ((1 - ndc[1]) * box.height) / 2 };
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') messages.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByLabel('Open Kitbasher scene').setInputFiles({
    name: 'shortcuts.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await expect(page.locator('.document-title')).toContainText(fixture.name);
  await page.locator('.part-select[title="Moving piece"]').click();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

for (const modifier of ['Control', 'Meta']) {
  test(`${modifier} selects all components, including hidden/fixed parts, while text fields keep native editing`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Hide Target piece', exact: true }).click();
    const before = await editorState(page);
    await page.keyboard.press(`${modifier}+a`);
    expect((await editorState(page)).selected).toEqual(['a', 'b', 'fixed']);
    await expect(page.locator('.part-row.selected')).toHaveCount(3);
    expect((await editorState(page)).revision).toBe(before.revision);
    await page.keyboard.press(`${modifier}+Shift+a`);
    expect((await editorState(page)).selected).toEqual([]);
    await page.locator('.part-select[title="Moving piece"]').click();
    const search = page.getByRole('textbox', { name: 'Search parts' });
    await search.fill('Moving');
    await search.press(`${modifier}+a`);
    expect(
      await search.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual(
      await page.evaluate(
        (modifier) =>
          modifier === 'Control' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
            ? [0, 0]
            : [0, 6],
        modifier,
      ),
    );
    expect((await editorState(page)).selected).toEqual(['a']);
    await search.dispatchEvent('contextmenu', { button: 2, bubbles: true });
    await expect(page.getByRole('menu', { name: 'Component actions' })).toHaveCount(0);
    await search.press('Backspace');
    expect((await editorState(page)).parts).toHaveLength(3);
  });
}

test('copies and pastes a joined selection through OS shortcuts, then undoes/redoes it', async ({
  page,
}) => {
  await page.locator('.part-select[title="Target piece"]').click({ modifiers: ['Shift'] });
  const before = await editorState(page);
  await page.keyboard.press('Meta+c');
  expect((await editorState(page)).revision).toBe(before.revision);
  await page.keyboard.press('Meta+v');
  const pasted = await editorState(page);
  expect(pasted.parts).toHaveLength(5);
  expect(pasted.selected).toHaveLength(2);
  expect(pasted.parts.at(-2)?.position).toEqual([-6, 30, 0]);
  expect(pasted.joints).toHaveLength(2);
  expect(pasted.joints[1].parentId).toBe(pasted.selected[0]);
  expect(pasted.joints[1].childId).toBe(pasted.selected[1]);
  await page.keyboard.press('Control+z');
  expect((await editorState(page)).parts).toHaveLength(3);
  await page.keyboard.press('Control+y');
  expect((await editorState(page)).parts).toHaveLength(5);
  await page.keyboard.press('Control+v');
  expect((await editorState(page)).parts.at(-2)?.position).toEqual([6, 30, 0]);
});

test('cuts unlocked components, pastes in place, renames with F2, and preserves text editing in the dialog', async ({
  page,
}) => {
  await page.locator('.part-select[title="Fixed base"]').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+x');
  const cut = await editorState(page);
  expect(cut.parts.map((part: any) => part.id)).toEqual(['b', 'fixed']);
  expect(cut.selected).toEqual(['fixed']);
  await page.keyboard.press('Control+v');
  expect((await editorState(page)).parts.at(-1)?.position).toEqual([-18, 30, 0]);
  await page.keyboard.press('F2');
  const input = page.getByRole('textbox', { name: 'Component name', exact: true });
  await expect(input).toBeFocused();
  await input.press('Meta+a');
  await input.pressSequentially('Renamed shoulder');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.part-select[title="Renamed shoulder"]')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.part-select[title="Moving piece"]')).toBeVisible();
});

test('shares Edit-menu commands and supports keyboard navigation, typeahead, Space, and Escape in the context menu', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: /^Select all components/ }).click();
  expect((await editorState(page)).selected).toHaveLength(3);
  await page.keyboard.press('Control+Shift+a');
  const part = page.locator('.part-select[title="Moving piece"]');
  await part.click();
  await part.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Component actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Move', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: /^Deselect all/ })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.type('copy');
  await expect(menu.getByRole('menuitem', { name: /^Copy components/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(menu).toHaveCount(0);
  expect((await editorState(page)).clipboard).toEqual(['a']);
  await part.press('Shift+F10');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(part).toBeFocused();
  expect((await editorState(page)).selected).toEqual(['a']);
  await page.keyboard.press('Control+Shift+a');
  await page.locator('.viewport').focus();
  await page.keyboard.press('ContextMenu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Paste components/ })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Move', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('right-clicks real mesh surfaces to target a part and set its pivot without opening after a pan drag', async ({
  page,
}) => {
  await page.keyboard.press('1');
  const location = await screenPoint(page, 'b', [0, 0, 8]);
  const menu = page.getByRole('menu', { name: 'Component actions' });
  await page.mouse.move(location.x, location.y);
  await page.mouse.down({ button: 'right' });
  // Model platforms that report a context menu on press, before any drag.
  await page.locator('canvas').evaluate((canvas, point) => {
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        button: 2,
        buttons: 2,
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, location);
  await expect(menu).toHaveCount(0);
  await page.mouse.up({ button: 'right' });
  await expect(menu).toBeVisible();
  const clicked = await editorState(page);
  expect(clicked.selected).toEqual(['b']);
  expect(clicked.point.partId).toBe('b');
  await menu.getByRole('menuitem', { name: 'Set pivot here', exact: true }).click();
  expect(
    (await editorState(page)).parts.find((part: any) => part.id === 'b')?.pivot[2],
  ).toBeCloseTo(8, 2);
  const before = await editorState(page);
  const bounds = (await page.locator('canvas').boundingBox())!;
  const start = { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height * 0.6 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await page.locator('canvas').evaluate((canvas, point) => {
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        button: 2,
        buttons: 2,
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, start);
  await expect(menu).toHaveCount(0);
  expect((await editorState(page)).selected).toEqual(before.selected);
  await page.mouse.move(start.x + 85, start.y + 20, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect(menu).toHaveCount(0);
  expect((await editorState(page)).selected).toEqual(before.selected);
  expect((await editorState(page)).camera).not.toEqual(before.camera);
});

test('preserves multiselection under right-click and makes visibility and selected-interface inspection undoable', async ({
  page,
}) => {
  const partA = page.locator('.part-select[title="Moving piece"]');
  await page.locator('.part-select[title="Target piece"]').click({ modifiers: ['Shift'] });
  await partA.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Component actions' });
  await expect(menu).toBeVisible();
  expect((await editorState(page)).selected).toEqual(['a', 'b']);
  await expect(menu.getByRole('menuitem', { name: /^Rename component/ })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Inspect selected interfaces', exact: true }).click();
  await expect(page.getByLabel('Inspection scope')).toHaveValue('selected');
  await page.getByRole('button', { name: 'Close interference view', exact: true }).click();
  await partA.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Hide others', exact: true }).click();
  expect(
    (await editorState(page)).parts.filter((part: any) => part.visible).map((part: any) => part.id),
  ).toEqual(['a', 'b']);
  await page.keyboard.press('Meta+z');
  expect((await editorState(page)).parts.every((part: any) => part.visible)).toBe(true);
  await page.locator('.part-select[title="Fixed base"] svg').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: /^Delete unlocked/ })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /^Cut components/ })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Unlock selected', exact: true }).click();
  expect((await editorState(page)).parts.find((part: any) => part.id === 'fixed')?.locked).toBe(
    false,
  );
});

test('supports find/save/import/export shortcuts and fits the context menu in a narrow viewport', async ({
  page,
}) => {
  await page.keyboard.press('Control+f');
  const search = page.getByRole('textbox', { name: 'Search parts' });
  await expect(search).toBeFocused();
  await search.fill('Target');
  await expect(page.locator('.part-row')).toHaveCount(1);
  await search.fill('');
  await search.press('Tab');
  const download = page.waitForEvent('download');
  await page.keyboard.press('Meta+Shift+s');
  expect((await download).suggestedFilename()).toMatch(/\.kitbash$/);
  await page.keyboard.press('Control+i');
  await expect(
    page.getByRole('dialog', { name: 'Every assembly starts with parts.' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+e');
  await expect(page.getByRole('dialog', { name: 'Ready for the next step.' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+n');
  await expect(page.getByRole('dialog', { name: 'Start something new.' })).toBeVisible();
  await page.keyboard.press('Escape');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  await (
    await chooser
  ).setFiles({
    name: 'shortcuts.kitbash',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.part-select[title="Moving piece"]').click({ button: 'right' });
  await page.screenshot({ path: '/tmp/kitbasher-context-menu-desktop.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.viewport').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Component actions' });
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: /^Deselect all/ })).toBeFocused();
  await page.screenshot({ path: '/tmp/kitbasher-context-menu-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
