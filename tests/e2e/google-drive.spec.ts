import { expect, test, type Page } from '@playwright/test';
import { readSavedScene } from './saved-scene';
import { readSceneFile, sceneFileBlob } from '../../src/core/scene-file';
import { createHash } from 'node:crypto';

interface CloudFile {
  id: string;
  name: string;
  version: string;
  modifiedTime: string;
  md5Checksum: string;
  appProperties: Record<string, string>;
  bytes: Buffer;
}

async function mockGoogle(page: Page, denied = false, hosted = false) {
  const cloud = {
    files: new Map<string, CloudFile>(),
    uploads: [] as string[],
    expired: false,
    renewals: 0,
    authorizations: 0,
    connected: false,
    revoked: false,
  };
  await page.route('**/api/drive/*', (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!hosted) return route.fulfill({ status: 404, body: '' });
    if (action === 'connect') {
      cloud.connected = true;
      cloud.authorizations++;
    }
    if (action === 'disconnect') cloud.connected = false;
    if (action === 'session' && cloud.revoked)
      return route.fulfill({ status: 401, json: { error: 'Reconnect Google Drive' } });
    if (action === 'session' && cloud.connected) cloud.renewals++;
    return route.fulfill({
      json: cloud.connected
        ? {
            enabled: true,
            access_token: 'test-access-token',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file',
          }
        : { enabled: true },
    });
  });
  let allocated = 0;
  const sessions = new Map<
    string,
    { id: string; metadata: Partial<CloudFile>; chunks: Buffer[] }
  >();
  await page.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: {
      initCodeClient: (config) => ({ requestCode: () => config.callback({ code: 'test-code' }) }),
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
          md5Checksum: createHash('md5').update(Buffer.concat(session.chunks)).digest('hex'),
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

test('saves edits to one portable Drive file and stays connected after local recovery', async ({
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
  // Leave enough time for a mistakenly queued autosave to run.
  await page.waitForTimeout(2000);
  await saved(page);
  expect(cloud.uploads).toHaveLength(3);
  await driveButton(page).click();
  await expect(
    page.getByRole('button', { name: 'Reconnect Google Drive', exact: true }),
  ).toHaveCount(0);
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
  expect(cloud.uploads).toHaveLength(4);
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
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered your local assembly', { exact: true })).toBeVisible();
  await page.waitForTimeout(2000);
  await saved(page);
  expect(cloud.uploads).toEqual(['cloud-1']);
});

for (const legacy of [false, true]) {
  test(`recovers pending offline edits${legacy ? ' from an older cache' : ''} and saves them to the same Drive file`, async ({
    page,
    context,
  }) => {
    const cloud = await mockGoogle(page);
    await connectAndSave(page);
    await context.setOffline(true);
    await rename(page, 'Pending across reload');
    await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive offline');
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
    expect(cloud.uploads).toHaveLength(1);
    if (legacy) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const open = indexedDB.open('kitbasher-workbench', 2);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const transaction = db.transaction('scenes', 'readwrite');
              const store = transaction.objectStore('scenes');
              const read = store.get('current');
              read.onsuccess = () => {
                delete read.result.driveSaved;
                store.put(read.result, 'current');
              };
              transaction.oncomplete = () => {
                db.close();
                resolve();
              };
              transaction.onabort = () => {
                db.close();
                reject(transaction.error);
              };
            };
          }),
      );
    }
    // Close while still offline so the old page cannot upload before recovery.
    page.once('dialog', (dialog) => dialog.accept());
    await page.goto('about:blank');
    await context.setOffline(false);
    await page.goto('/');
    await expect(page.getByText('Recovered your local assembly', { exact: true })).toBeVisible();
    await saved(page);
    expect(cloud.uploads).toEqual(['cloud-1', 'cloud-1']);
    expect(cloud.files.get('cloud-1')!.name).toBe('Pending across reload.kitbash');
    await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Recovered your local assembly', { exact: true })).toBeVisible();
    await page.waitForTimeout(2000);
    await saved(page);
    expect(cloud.uploads).toHaveLength(2);
  });
}

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
  await changeRemote(remote, 'Cloud edits');
  await rename(page, 'Local conflicting edits');
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive file changed');
  expect(cloud.uploads).toHaveLength(2);
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Save a new Drive copy', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await saved(page);
  expect(cloud.files.size).toBe(2);
  expect(cloud.files.get('cloud-1')!.name).toBe('Cloud edits.kitbash');
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

async function changeRemote(file: CloudFile, name: string) {
  const scene = await readSceneFile(new Blob([new Uint8Array(file.bytes)]));
  scene.name = name;
  file.bytes = Buffer.from(await (await sceneFileBlob(scene)).arrayBuffer());
  file.md5Checksum = createHash('md5').update(file.bytes).digest('hex');
  file.name = `${name}.kitbash`;
  file.version = String(Number(file.version) + 10);
  // Deliberately retain appProperties: updates outside Kitbasher can preserve them.
}

async function conflictingScene(page: Page) {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  await changeRemote(cloud.files.get('cloud-1')!, 'Cloud assembly');
  await rename(page, 'Local assembly');
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive file changed');
  await driveButton(page).click();
  return cloud;
}

test('loads the cloud version directly from a conflict, with cancel leaving local edits intact', async ({
  page,
}) => {
  const cloud = await conflictingScene(page);
  await page.screenshot({
    path: '/tmp/kitbasher-drive-conflict-desktop.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Load Drive version', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTitle('Rename assembly', { exact: true })).toContainText('Local assembly');
  await page.getByRole('button', { name: 'Load Drive version', exact: true }).click();
  await page.getByRole('button', { name: 'Discard local edits and load', exact: true }).click();
  await saved(page);
  await expect(page.getByTitle('Rename assembly', { exact: true })).toContainText('Cloud assembly');
  expect(cloud.uploads).toEqual(['cloud-1']);
});

test('overwrites the reviewed Drive version only after explicit confirmation', async ({ page }) => {
  const cloud = await conflictingScene(page);
  await page.getByRole('button', { name: 'Overwrite Drive version', exact: true }).click();
  expect(cloud.uploads).toHaveLength(1);
  await page.getByRole('button', { name: 'Confirm overwrite', exact: true }).click();
  await saved(page);
  expect(cloud.files.get('cloud-1')!.name).toBe('Local assembly.kitbash');
  expect(cloud.files.size).toBe(1);
});

test('checks again when the remote scene changes after the overwrite confirmation was shown', async ({
  page,
}) => {
  const cloud = await conflictingScene(page);
  await page.getByRole('button', { name: 'Overwrite Drive version', exact: true }).click();
  await changeRemote(cloud.files.get('cloud-1')!, 'Newer cloud edits');
  await page.getByRole('button', { name: 'Confirm overwrite', exact: true }).click();
  await expect(driveButton(page)).toHaveAccessibleName('Google Drive: Drive file changed');
  expect(cloud.uploads).toHaveLength(1);
  expect(cloud.files.get('cloud-1')!.name).toBe('Newer cloud edits.kitbash');
});

test('keeps local edits and binding if loading the conflict version fails', async ({ page }) => {
  await conflictingScene(page);
  await page.route('**/drive/v3/files/cloud-1?alt=media', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.getByRole('button', { name: 'Load Drive version', exact: true }).click();
  await page.getByRole('button', { name: 'Discard local edits and load', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Google Drive', exact: true }).getByRole('alert'),
  ).toContainText('temporarily unavailable');
  await expect(page.getByTitle('Rename assembly', { exact: true })).toContainText('Local assembly');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Overwrite Drive version', exact: true }),
  ).toBeEnabled();
});

test('ignores metadata-only version changes and keeps saving to the same Drive file', async ({
  page,
}) => {
  const cloud = await mockGoogle(page);
  await connectAndSave(page);
  cloud.files.get('cloud-1')!.version = '50';
  await rename(page, 'No content conflict');
  await saved(page);
  expect(cloud.uploads).toEqual(['cloud-1', 'cloud-1']);
});

test('renews hosted authorization and restores after reload without reconnect, but respects disconnect', async ({
  page,
}) => {
  const cloud = await mockGoogle(page, false, true);
  await connectAndSave(page);
  cloud.expired = true;
  await rename(page, 'Renewed in background');
  await saved(page);
  expect(cloud.authorizations).toBe(1);
  expect(cloud.renewals).toBe(1);
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered your local assembly', { exact: true })).toBeVisible();
  await page.waitForTimeout(2000);
  await saved(page);
  expect(cloud.uploads).toHaveLength(2);
  expect(cloud.authorizations).toBe(1);
  expect(cloud.renewals).toBe(2);
  await driveButton(page).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connect Google Drive', exact: true }),
  ).toBeEnabled();
  expect(cloud.connected).toBe(false);
});

test('keeps conflict resolution usable on a phone', async ({ page }) => {
  await conflictingScene(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const load = page.getByRole('button', { name: 'Load Drive version', exact: true });
  await load.scrollIntoViewIfNeeded();
  await expect(load).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({
    path: '/tmp/kitbasher-drive-conflict-phone.png',
    animations: 'disabled',
  });
  await load.click();
  await page.getByRole('button', { name: 'Discard local edits and load', exact: true }).click();
  await saved(page);
});
