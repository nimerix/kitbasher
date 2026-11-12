import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveAutosave, useDrive } from '../../src/core/drive-sync';
import { DriveError } from '../../src/core/google-auth';
import { useEditor } from '../../src/core/store';
import type { DriveFile } from '../../src/core/google-drive';

const file = { id: 'cloud-1', name: 'Assembly.kitbash', version: '2' };
const save = vi.fn();
let sync: DriveAutosave;
let stop: () => void;
const edit = (name: string) => useEditor.getState().renameScene(name);
const bound = () => useEditor.setState({ driveFile: { id: file.id, version: '1' } });
const deferred = () => {
  let resolve!: (file: DriveFile) => void;
  const promise = new Promise<DriveFile>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  save.mockReset().mockResolvedValue(file);
  useEditor.getState().setScene({ name: 'Assembly', parts: [], joints: [] });
  useDrive.setState({
    connected: true,
    status: 'idle',
    savedRevision: -1,
    message: null,
    dialogOpen: false,
  });
  sync = new DriveAutosave({ save });
  stop = sync.start();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Drive autosave coordination', () => {
  it('coalesces rapid edits and saves only the newest revision', async () => {
    bound();
    edit('First');
    await vi.advanceTimersByTimeAsync(800);
    edit('Latest');
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].name).toBe('Latest');
    expect(useDrive.getState().savedRevision).toBe(useEditor.getState().revision);
    expect(useEditor.getState().driveFile).toEqual({ id: file.id, version: '2' });
  });

  it('makes progress during continuous editing instead of postponing forever', async () => {
    bound();
    for (let i = 0; i < 8; i++) {
      edit(`Edit ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('serializes uploads and does not mark newer edits as saved by an older acknowledgement', async () => {
    const first = deferred();
    save.mockReturnValueOnce(first.promise);
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    const firstRevision = useEditor.getState().revision;
    edit('During upload');
    await vi.advanceTimersByTimeAsync(4000);
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(file);
    await vi.advanceTimersByTimeAsync(0);
    expect(useDrive.getState().savedRevision).toBe(firstRevision);
    expect(useDrive.getState().status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].name).toBe('During upload');
    expect(save.mock.calls[1][1].version).toBe('2');
    expect(useDrive.getState().savedRevision).toBe(useEditor.getState().revision);
  });

  it('aborts an old scene and ignores its late acknowledgement after replacement', async () => {
    const old = deferred();
    save.mockReturnValueOnce(old.promise);
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    useEditor.getState().setScene({ name: 'New scene', parts: [], joints: [] });
    expect((save.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    old.resolve(file);
    await vi.advanceTimersByTimeAsync(10000);
    expect(useEditor.getState().driveFile).toBeNull();
    expect(useDrive.getState().status).toBe('idle');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps edits pending offline and sends the latest state when the connection returns', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    bound();
    edit('Offline change');
    await vi.advanceTimersByTimeAsync(10000);
    expect(useDrive.getState().status).toBe('offline');
    expect(save).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(save.mock.calls[0][0].name).toBe('Offline change');
    expect(useDrive.getState().status).toBe('saved');
  });

  it('retries transient failures with the same upload identity and latest scene', async () => {
    save.mockRejectedValueOnce(new DriveError('Network', 'retryable'));
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    const pendingId = save.mock.calls[0][1].pendingWriteId;
    edit('Edited while retrying');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1].pendingWriteId).toBe(pendingId);
    expect(save.mock.calls[1][0].name).toBe('Edited while retrying');
    expect(useDrive.getState().status).toBe('saved');
  });

  it('waits for explicit reconnect after authorization expires', async () => {
    save.mockRejectedValueOnce(new DriveError('Reconnect', 'auth'));
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    edit('Still editing');
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(useDrive.getState()).toMatchObject({ status: 'reconnect', connected: false });
    expect(await sync.flush()).toBe(false);
    sync.connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not postpone retry backoff while the user keeps editing', async () => {
    save.mockRejectedValueOnce(new DriveError('Network', 'retryable'));
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    for (let i = 0; i < 4; i++) {
      edit(`Retry edit ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].name).toBe('Retry edit 3');
  });

  it('keeps a clean scene saved when reconnecting after a file-list authorization error', async () => {
    bound();
    sync.acceptOpenedScene();
    useDrive.setState({ connected: false, status: 'reconnect' });
    sync.connected();
    await vi.advanceTimersByTimeAsync(10000);
    expect(useDrive.getState().status).toBe('saved');
    expect(save).not.toHaveBeenCalled();
  });

  it('stops on conflicts and refuses scene replacement until resolved', async () => {
    save.mockRejectedValueOnce(new DriveError('Changed elsewhere', 'conflict'));
    bound();
    await vi.advanceTimersByTimeAsync(1500);
    edit('Local changes');
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(useDrive.getState().status).toBe('conflict');
    expect(await sync.flush()).toBe(false);
  });

  it('flushes pending changes immediately and warns on unload only while unsynced', async () => {
    bound();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(await sync.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const savedEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });

  it('does not rewrite an opened scene until it is edited', async () => {
    bound();
    sync.acceptOpenedScene();
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).not.toHaveBeenCalled();
    edit('Renamed');
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
