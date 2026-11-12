import { expect, test, type Page } from '@playwright/test';
import { readSavedScene } from './saved-scene';
import { readSceneFile } from '../../src/core/scene-file';

interface CloudFile {
  id: string;
  name: string;
  version: string;
  modifiedTime: string;
  appProperties: Record<string, string>;
  bytes: Buffer;
}

async function mockGoogle(page: Page, denied = false) {
  const cloud = {
    files: new Map<string, CloudFile>(),
    uploads: [] as string[],
    expired: false,
  };
  let allocated = 0;
  const sessions = new Map<
    string,
    { id: string; metadata: Partial<CloudFile>; chunks: Buffer[] }
  >();
  await page.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: {
      initTokenClient: (config) => ({ requestAccessToken: () => config.callback({
        access_token: 'test-access-token', expires_in: 3600,
        scope: ${JSON.stringify(denied ? '' : 'https://www.googleapis.com/auth/drive.file')}
      }) })
    } } };`,
    }),
  );
  await page.route(
    /^https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\/files/,
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (cloud.expired) {
        cloud.expired = false;
        await route.fulfill({ status: 401, json: {} });
        return;
      }
      expect(request.headers().authorization).toBe('Bearer test-access-token');
      if (url.pathname.endsWith('/generateIds')) {
        await route.fulfill({ json: { ids: [`cloud-${++allocated}`] } });
        return;
      }
      if (request.method() === 'PUT') {
        const session = sessions.get(url.searchParams.get('upload_id')!)!;
        session.chunks.push(request.postDataBuffer()!);
        const range = request.headers()['content-range'].match(/^bytes (\d+)-(\d+)\/(\d+)$/)!;
        if (Number(range[2]) + 1 < Number(range[3])) {
          await route.fulfill({
            status: 308,
            headers: { Range: `bytes=0-${range[2]}`, 'Access-Control-Expose-Headers': 'Range' },
          });
          return;
        }
        const previous = cloud.files.get(session.id);
        const file: CloudFile = {
          id: session.id,
          name: session.metadata.name!,
          version: String(Number(previous?.version ?? 0) + 1),
          modifiedTime: new Date().toISOString(),
          appProperties: session.metadata.appProperties!,
          bytes: Buffer.concat(session.chunks),
        };
        cloud.files.set(file.id, file);
        cloud.uploads.push(file.id);
        const { bytes: _, ...metadata } = file;
        await route.fulfill({ json: metadata });
        return;
      }
      if (url.searchParams.get('uploadType') === 'resumable') {
        const metadata = request.postDataJSON() as Partial<CloudFile>;
        const id = metadata.id ?? url.pathname.split('/').at(-1)!;
        const sessionId = `upload-${sessions.size}`;
        sessions.set(sessionId, { id, metadata, chunks: [] });
        await route.fulfill({
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/files/${id}?upload_id=${sessionId}`,
            'Access-Control-Expose-Headers': 'Location',
          },
        });
        return;
      }
      if (url.pathname.endsWith('/files')) {
        await route.fulfill({
          json: { files: [...cloud.files.values()].map(({ bytes: _, ...metadata }) => metadata) },
        });
        return;
      }
      const file = cloud.files.get(url.pathname.split('/').at(-1)!);
      if (!file) {
        await route.fulfill({ status: 404, json: {} });
        return;
      }
      if (url.searchParams.get('alt') === 'media') {
        await route.fulfill({ contentType: 'application/octet-stream', body: file.bytes });
        return;
      }
      const { bytes: _, ...metadata } = file;
      await route.fulfill({ json: metadata });
    },
  );
  return cloud;
}

const driveButton = (page: Page) => page.getByRole('button', { name: /^Google Drive:/ });
const saved = (page: Page) =>
  expect(driveButton(page)).toHaveAccessibleName('Google Drive: Saved to Drive');
async function connectAndSave(page: Page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Restoring your local assembly…')).toHaveCount(0);
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click();
  await page.getByRole('button', { name: 'Save this scene to Drive', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await saved(page);
}
async function rename(page: Page, name: string) {
  await page.getByTitle('Rename assembly', { exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Assembly name', exact: true });
  await input.fill(name);
  await input.press('Enter');
}

test('saves edits to one portable Drive file and reconnects to it after local recovery', async ({
  page,
}) => {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  await rename(page, 'Drive assembly');
  await saved(page);
  await page.locator('.part-select[title="Torso shell"]').click();
  const position = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await position.fill('12');
  await position.press('Enter');
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.keyboard.press('ControlOrMeta+s');
  await saved(page);
  expect(downloads).toEqual([]);
  expect(cloud.files.size).toBe(1);
  expect(cloud.uploads).toEqual(['cloud-1', 'cloud-1', 'cloud-1']);
  const uploaded = await readSceneFile(
    new Blob([new Uint8Array(cloud.files.get('cloud-1')!.bytes)]),
  );
  expect(uploaded.name).toBe('Drive assembly');
  expect(uploaded.parts).toHaveLength(15);
  expect(uploaded.parts.find((part) => part.id === 'torso')!.position[0]).toBe(12);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered your local assembly', { exact: true })).toBeVisible();
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Reconnect Drive');
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Reconnect Google Drive', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Drive' })).toBeVisible();
  expect(cloud.files.size).toBe(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download scene copy', exact: true }).click();
  const download = await downloading;
  const { scene, bytes } = await readSavedScene((await download.path())!);
  expect(scene.name).toBe('Drive assembly');
  expect(bytes.includes(Buffer.from('test-access-token'))).toBe(false);
  expect(bytes.includes(Buffer.from('driveFile'))).toBe(false);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await rename(page, 'After recovery');
  await saved(page);
  expect(cloud.uploads.every((id) => id === 'cloud-1')).toBe(true);
});

test('opens a Drive scene after creating a new scene without uploading the replacement to the old file', async ({
  page,
}) => {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: /New assembly/ }).click();
  await page.getByRole('button', { name: /Empty assembly/ }).click();
  await expect(page.locator('.part-row')).toHaveCount(0);
  await driveButton(page).click();
  await page.getByRole('button', { name: /Scout.*\.kitbash/ }).click();
  await page.getByRole('button', { name: 'Open scene', exact: true }).click();
  await saved(page);
  await expect(page.locator('.part-row')).toHaveCount(15);
  expect(cloud.uploads).toEqual(['cloud-1']);
});

test('retains offline edits and automatically uploads them on reconnect', async ({
  page,
  context,
}) => {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  await context.setOffline(true);
  await rename(page, 'Edited offline');
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive offline');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  expect(cloud.uploads).toHaveLength(1);
  await context.setOffline(false);
  await saved(page);
  expect(cloud.files.get('cloud-1')!.name).toBe('Edited offline.kitbash');
  expect(cloud.uploads).toHaveLength(2);
});

test('handles expired authorization and remote conflicts without creating duplicates or overwriting the remote file', async ({
  page,
}) => {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  cloud.expired = true;
  await rename(page, 'Needs reconnect');
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Reconnect Drive');
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Reconnect Google Drive', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await saved(page);
  const remote = cloud.files.get('cloud-1')!;
  remote.version = '50';
  remote.appProperties = { kitbasher: 'scene', kitbasherWrite: 'another-editor' };
  await rename(page, 'Local conflicting edits');
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive file changed');
  expect(cloud.uploads).toHaveLength(2);
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Save a new Drive copy', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await saved(page);
  expect(cloud.files.size).toBe(2);
  expect(cloud.files.get('cloud-1')!.name).toBe('Needs reconnect.kitbash');
  expect(cloud.files.get('cloud-2')!.name).toBe('Local conflicting edits.kitbash');
});

test('explains denied Drive permission and keeps the scene local', async ({ page }) => {
  const cloud = await mockGoogle(page, true);
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Connect Google Drive', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('access was not granted');
  expect(cloud.files.size).toBe(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeVisible();
});

test('keeps Drive controls reachable on a phone-sized screen', async ({ page }) => {
  await mockGoogle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await connectAndSave(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await driveButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Google Drive', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download scene copy', exact: true }),
  ).toBeInViewport();
});
