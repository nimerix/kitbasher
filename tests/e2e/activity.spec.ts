import { expect, test, type Page } from '@playwright/test';

async function resetActivity(page: Page) {
  await page.evaluate(async () => {
    const url = '/src/core/activity.ts';
    const activity = await import(url);
    activity.clearFinishedTasks();
    activity.clearNotifications();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await resetActivity(page);
});

test('shows concurrent progress, cancels actual work, and retains finished jobs after reopening', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await page.evaluate(async () => {
    const url = '/src/core/activity.ts';
    const activity = await import(url);
    let id = '';
    id = activity.startTask({
      title: 'Detailed interference check',
      detail: 'Checking pair 3 of 8',
      progress: 0.375,
      cancel: () => activity.cancelTask(id, 'Worker stopped by user'),
    });
    activity.startTask({ title: 'Queued surface preparation', status: 'queued' });
    return id;
  });

  await page.getByRole('button', { name: 'Background activity', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Background activity', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Checking pair 3 of 8', { exact: true })).toBeVisible();
  const progress = panel.getByRole('progressbar', { name: 'Detailed interference check progress' });
  await expect(progress).toHaveAttribute('value', '0.375');
  await expect(progress).toBeVisible();
  await expect(panel.getByText('Queued surface preparation', { exact: true })).toBeVisible();
  await panel
    .getByRole('button', { name: 'Cancel Detailed interference check', exact: true })
    .click();
  await expect(panel.getByText('Worker stopped by user', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Cancel Detailed interference check' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(async (id) => {
      const url = '/src/core/activity.ts';
      return (await import(url)).useActivity
        .getState()
        .tasks.find((task: { id: string }) => task.id === id).status;
    }, id),
  ).toBe('cancelled');

  await panel.getByRole('button', { name: 'Close background activity', exact: true }).click();
  await page.getByRole('button', { name: 'Background activity', exact: true }).click();
  await expect(panel.getByText('Worker stopped by user', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear finished', exact: true }).click();
  await expect(panel.getByText('Detailed interference check', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Queued surface preparation', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Background activity', exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('keeps editor alerts in notification history after banner dismissal', async ({ page }) => {
  await page.evaluate(async () => {
    const url = '/src/core/store.ts';
    const editor = (await import(url)).useEditor.getState();
    editor.notify('Detailed inspection could not finish', 'error');
    editor.notify('Scene recovery is available', 'info');
  });
  const banners = page.locator('.toast');
  await expect(banners.filter({ hasText: 'Detailed inspection could not finish' })).toBeVisible();
  await banners
    .filter({ hasText: 'Detailed inspection could not finish' })
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click();
  await expect(banners.filter({ hasText: 'Detailed inspection could not finish' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(
    panel.getByText('Detailed inspection could not finish', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Scene recovery is available', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Mark all read', exact: true }).click();
  expect(
    await page.evaluate(async () => {
      const url = '/src/core/activity.ts';
      return (await import(url)).useActivity
        .getState()
        .notifications.every((entry: { read: boolean }) => entry.read);
    }),
  ).toBe(true);
  await panel.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(
    panel.getByText('Detailed inspection could not finish', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  await expect(
    panel.getByText('Detailed inspection could not finish', { exact: true }),
  ).toHaveCount(0);
});

test('keeps activity and alert controls usable in a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const url = '/src/core/activity.ts';
    const activity = await import(url);
    activity.startTask({
      title: 'Building surface index for a detailed imported miniature scan',
      detail: 'Preparing geometry while the rest of the workbench stays available',
      progress: null,
    });
    activity.notify(
      'Background processing completed for a very detailed imported model',
      'success',
    );
  });
  const activityButton = page.getByRole('button', { name: 'Background activity', exact: true });
  const notificationsButton = page.getByRole('button', { name: 'Notifications', exact: true });
  await expect(activityButton).toBeInViewport();
  await expect(notificationsButton).toBeInViewport();
  await activityButton.click();
  const activity = page.getByRole('region', { name: 'Background activity', exact: true });
  await expect(activity).toBeVisible();
  await expect(activity.getByRole('progressbar')).not.toHaveAttribute('value');
  const box = (await activity.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await activity.getByRole('button', { name: 'Close background activity', exact: true }).click();
  await notificationsButton.click();
  const notifications = page.getByRole('region', { name: 'Notifications', exact: true });
  await expect(notifications).toBeVisible();
  const notificationBox = (await notifications.boundingBox())!;
  expect(notificationBox.x).toBeGreaterThanOrEqual(0);
  expect(notificationBox.x + notificationBox.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(notifications).toHaveCount(0);
  await expect(notificationsButton).toBeFocused();
});
