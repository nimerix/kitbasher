import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelTask,
  clearFinishedTasks,
  clearNotifications,
  completeTask,
  dismissNotification,
  failTask,
  markAllNotificationsRead,
  notify,
  removeNotification,
  requestTaskCancellation,
  startTask,
  updateTask,
  useActivity,
} from '../../src/core/activity';

beforeEach(() => {
  for (const task of useActivity.getState().tasks) cancelTask(task.id);
  useActivity.setState({ tasks: [], notifications: [] });
});

const task = (id: string) => useActivity.getState().tasks.find((entry) => entry.id === id)!;

describe('background activity', () => {
  it('works on plain-HTTP LAN hosts where randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const id = startTask({ title: 'LAN inspection' });
      const notice = notify('LAN scene loaded', 'info');
      expect(id).toBeTruthy();
      expect(notice).toBeTruthy();
      expect(id).not.toBe(notice);
      expect(task(id).status).toBe('running');
      completeTask(id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tracks independent queued and running jobs without replacing their progress', () => {
    const inspection = startTask({ title: 'Inspect interference', progress: 0 });
    const index = startTask({ title: 'Prepare picking', status: 'queued' });
    updateTask(inspection, { detail: 'Checking pair 2 of 4', progress: 0.5 });
    updateTask(index, { status: 'running', detail: 'Building surface index' });

    expect(task(inspection)).toMatchObject({
      title: 'Inspect interference',
      status: 'running',
      detail: 'Checking pair 2 of 4',
      progress: 0.5,
    });
    expect(task(index)).toMatchObject({
      title: 'Prepare picking',
      status: 'running',
      progress: null,
      detail: 'Building surface index',
    });
    completeTask(inspection, '4 pairs checked');
    expect(task(index).status).toBe('running');
    expect(task(inspection)).toMatchObject({
      status: 'completed',
      detail: '4 pairs checked',
      progress: 1,
      cancellable: false,
      finishedAt: expect.any(Number),
    });
  });

  it('uses bounded real progress and treats unavailable progress as indeterminate', () => {
    const id = startTask({ title: 'Upload', progress: -0.1 });
    expect(task(id).progress).toBe(0);
    updateTask(id, { progress: 1.5 });
    expect(task(id).progress).toBe(1);
    updateTask(id, { progress: Number.NaN });
    expect(task(id).progress).toBeNull();
    updateTask(id, { progress: Infinity });
    expect(task(id).progress).toBeNull();
    updateTask(id, { progress: 0.3 });
    updateTask(id, { detail: 'Finalizing upload' });
    expect(task(id).progress).toBe(0.3);
    updateTask(id, { progress: null });
    expect(task(id).progress).toBeNull();
  });

  it('ignores late worker messages after completion, failure, or cancellation', () => {
    for (const terminal of [completeTask, failTask, cancelTask]) {
      const id = startTask({ title: 'Worker job' });
      terminal(id, 'Terminal result');
      const finished = task(id);
      const notifications = useActivity.getState().notifications.length;
      updateTask(id, { progress: 0.8, detail: 'Stale message', status: 'running' });
      completeTask(id, 'Late success');
      failTask(id, 'Late failure');
      cancelTask(id, 'Late cancellation');
      expect(task(id)).toEqual(finished);
      expect(useActivity.getState().notifications).toHaveLength(notifications);
    }
  });

  it('invokes real cancellation once and cannot cancel finished work', () => {
    let id = '';
    const cancel = vi.fn(() => cancelTask(id, 'Stopped by user'));
    id = startTask({ title: 'Heavy worker', cancel });
    expect(task(id).cancellable).toBe(true);
    requestTaskCancellation(id);
    requestTaskCancellation(id);
    expect(cancel).toHaveBeenCalledOnce();
    expect(task(id)).toMatchObject({ status: 'cancelled', cancellable: false });

    const finishedCancel = vi.fn();
    const completed = startTask({ title: 'Finished worker', cancel: finishedCancel });
    completeTask(completed);
    requestTaskCancellation(completed);
    expect(finishedCancel).not.toHaveBeenCalled();
  });

  it('does not pretend uncancellable jobs have been stopped', () => {
    const id = startTask({ title: 'Preparing file' });
    requestTaskCancellation(id);
    expect(task(id)).toMatchObject({ status: 'running', cancellable: false });
  });

  it('disables repeated abort requests while cancellation settles and records abort failures', () => {
    const cancel = vi.fn();
    const id = startTask({ title: 'Uploading a scene', cancel });
    requestTaskCancellation(id);
    requestTaskCancellation(id);
    expect(cancel).toHaveBeenCalledOnce();
    expect(task(id)).toMatchObject({ status: 'running', cancellable: false });
    cancelTask(id);
    expect(task(id).status).toBe('cancelled');

    const failed = startTask({
      title: 'Worker with failed abort',
      cancel: () => {
        throw new Error('Could not stop worker');
      },
    });
    requestTaskCancellation(failed);
    expect(task(failed)).toMatchObject({ status: 'failed', detail: 'Could not stop worker' });
    expect(useActivity.getState().notifications[0]).toMatchObject({
      kind: 'error',
      taskId: failed,
    });
  });

  it('bounds completed history without evicting long-running or queued jobs', () => {
    const running = startTask({ title: 'Large scan inspection' });
    const queued = startTask({ title: 'Pending index', status: 'queued' });
    for (let i = 0; i < 100; i++) {
      completeTask(startTask({ title: `Autosave ${i}`, notify: false }));
    }
    expect(useActivity.getState().tasks.length).toBeLessThan(102);
    expect(task(running).status).toBe('running');
    expect(task(queued).status).toBe('queued');
    completeTask(running, 'Large scan finished');
    expect(task(running)).toMatchObject({ status: 'completed', detail: 'Large scan finished' });
    expect(useActivity.getState().tasks.filter((entry) => entry.status === 'completed')[0].id).toBe(
      running,
    );
  });

  it('keeps failures visible even for quiet jobs and clears only finished tasks', () => {
    const completed = startTask({ title: 'Automatic display preparation', notify: false });
    const cancelled = startTask({ title: 'Superseded automatic job', notify: false });
    const failed = startTask({ title: 'Drive upload', notify: false });
    const running = startTask({ title: 'Interference check' });
    const queued = startTask({ title: 'Next mesh', status: 'queued' });
    completeTask(completed);
    cancelTask(cancelled);
    expect(useActivity.getState().notifications).toHaveLength(0);
    failTask(failed, 'Connection lost');
    expect(useActivity.getState().notifications).toEqual([
      expect.objectContaining({ kind: 'error', taskId: failed }),
    ]);
    expect(useActivity.getState().notifications[0].message).toContain('Connection lost');
    clearFinishedTasks();
    expect(
      useActivity
        .getState()
        .tasks.map((entry) => entry.id)
        .sort(),
    ).toEqual([running, queued].sort());
    expect(useActivity.getState().notifications).toHaveLength(1);
  });
});

describe('in-app notifications', () => {
  it('retains simultaneous messages when banners are dismissed', () => {
    const saved = notify('Scene saved');
    const failed = notify('Upload failed', 'error');
    dismissNotification(saved);
    expect(useActivity.getState().notifications).toHaveLength(2);
    expect(useActivity.getState().notifications.find((entry) => entry.id === saved)).toMatchObject({
      message: 'Scene saved',
      kind: 'success',
      dismissed: true,
    });
    expect(useActivity.getState().notifications.find((entry) => entry.id === failed)).toMatchObject(
      {
        message: 'Upload failed',
        kind: 'error',
        dismissed: false,
      },
    );
  });

  it('supports read state, individual removal, and clearing history independently of jobs', () => {
    const job = startTask({ title: 'Inspection' });
    const first = notify('Preparing scene', 'info');
    const second = notify('Some meshes are open', 'warning', { taskId: job });
    expect(useActivity.getState().notifications.every((entry) => !entry.read)).toBe(true);
    markAllNotificationsRead();
    expect(useActivity.getState().notifications.every((entry) => entry.read)).toBe(true);
    removeNotification(first);
    expect(useActivity.getState().notifications.map((entry) => entry.id)).toEqual([second]);
    clearNotifications();
    expect(useActivity.getState().notifications).toHaveLength(0);
    expect(task(job).status).toBe('running');
  });
});
