import { create } from 'zustand';
import { cancelTask, completeTask, failTask, startTask, updateTask } from './activity';
import { DriveError, endDriveSession, forgetDriveToken, restoreDriveSession } from './google-auth';
import { DriveConflict, driveBinding, googleDrive } from './google-drive';
import { committedScene, liveSession, useEditor } from './store';
import type { DriveFile, GoogleDriveClient } from './google-drive';

type DriveStatus =
  | 'disconnected'
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'offline'
  | 'reconnect'
  | 'error'
  | 'conflict';

export const useDrive = create<{
  connected: boolean;
  dialogOpen: boolean;
  status: DriveStatus;
  progress: number;
  savedRevision: number;
  message: string | null;
  conflict: DriveFile | null;
}>(() => ({
  connected: false,
  dialogOpen: false,
  status: 'disconnected',
  progress: 0,
  savedRevision: -1,
  message: null,
  conflict: null,
}));

export const driveStatusText = (status: DriveStatus) =>
  ({
    disconnected: 'Google Drive',
    idle: 'Google Drive',
    pending: 'Waiting to save',
    saving: 'Saving to Drive…',
    saved: 'Saved to Drive',
    offline: 'Drive offline',
    reconnect: 'Reconnect Drive',
    error: 'Drive save failed',
    conflict: 'Drive file changed',
  })[status];

/** A single writer coalesces edits made during an upload into the next revision. */
export class DriveAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  private pendingSince = 0;
  private failures = 0;
  private stopped = true;
  private paused = false;
  private activityId: string | undefined;

  constructor(private readonly client: Pick<GoogleDriveClient, 'save'> = googleDrive) {}

  start() {
    if (liveSession) return () => {};
    this.stopped = false;
    this.unsubscribe?.();
    this.unsubscribe = useEditor.subscribe((state, previous) => {
      if (
        state.sceneEpoch !== previous.sceneEpoch ||
        state.driveFile?.id !== previous.driveFile?.id
      ) {
        this.cancel();
        this.failures = 0;
        useDrive.setState({
          savedRevision: -1,
          conflict: null,
          message: null,
          progress: 0,
          status: state.driveFile
            ? useDrive.getState().connected
              ? 'pending'
              : 'reconnect'
            : useDrive.getState().connected
              ? 'idle'
              : 'disconnected',
        });
        this.schedule();
      } else if (state.revision !== previous.revision) this.schedule();
    });
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
    window.addEventListener('beforeunload', this.beforeUnload);
    this.schedule();
    void restoreDriveSession()
      .then((connected) => {
        if (!this.stopped && connected && !useDrive.getState().connected) this.connected();
      })
      .catch(() => {
        /* A user can retry connecting in the Drive dialog. */
      });
    return () => {
      this.stopped = true;
      this.cancel();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      window.removeEventListener('online', this.online);
      window.removeEventListener('offline', this.offline);
      window.removeEventListener('beforeunload', this.beforeUnload);
    };
  }

  private cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingSince = 0;
    this.controller?.abort();
    if (this.activityId) cancelTask(this.activityId, 'Drive save stopped for this scene.');
    this.activityId = undefined;
  }

  private dirty() {
    return (
      !!useEditor.getState().driveFile &&
      useEditor.getState().revision !== useDrive.getState().savedRevision
    );
  }

  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  private online = () => {
    if (!useDrive.getState().connected)
      void restoreDriveSession()
        .then((connected) => {
          if (!this.stopped && connected) this.connected();
        })
        .catch(() => {});
    if (useDrive.getState().status === 'offline' || this.failures) this.retry();
  };
  private offline = () => {
    if (this.dirty()) {
      useDrive.setState({ status: 'offline' });
      if (this.activityId)
        updateTask(this.activityId, { detail: 'Waiting for a network connection', progress: null });
    }
  };

  private schedule(delay?: number) {
    if (this.stopped || this.paused || !this.dirty()) return;
    const state = useDrive.getState();
    if (!state.connected) {
      if (this.activityId)
        updateTask(this.activityId, {
          detail: 'Waiting to reconnect Google Drive',
          progress: null,
        });
      useDrive.setState({ status: 'reconnect' });
      return;
    }
    if (['conflict', 'error', 'reconnect'].includes(state.status)) return;
    if (!navigator.onLine) {
      if (this.activityId)
        updateTask(this.activityId, { detail: 'Waiting for a network connection', progress: null });
      useDrive.setState({ status: 'offline' });
      return;
    }
    if (this.inFlight) return;
    // Editing during backoff must not keep postponing the retry indefinitely.
    if (this.failures && this.timer && delay === undefined) return;
    this.pendingSince ||= Date.now();
    // Save after a short pause, and at least every eight seconds during continuous edits.
    const wait =
      delay ??
      (this.failures
        ? Math.min(30000, 2000 * 2 ** (this.failures - 1))
        : Math.min(1500, Math.max(0, 8000 - (Date.now() - this.pendingSince))));
    clearTimeout(this.timer);
    useDrive.setState({ status: 'pending' });
    const detail = this.failures ? 'Waiting to retry the upload' : 'Waiting for edits to settle';
    if (this.activityId) updateTask(this.activityId, { status: 'queued', detail, progress: null });
    else
      this.activityId = startTask({
        title: `Save to Drive · ${useEditor.getState().scene.name}`,
        detail,
        status: 'queued',
        progress: null,
        notify: false,
      });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  private run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const state = useEditor.getState(),
      binding = state.driveFile;
    if (this.stopped || this.paused || !binding || !this.dirty()) return Promise.resolve();
    if (!useDrive.getState().connected || !navigator.onLine) {
      this.schedule();
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingSince = 0;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () =>
      !this.stopped &&
      this.generation === generation &&
      useEditor.getState().sceneEpoch === state.sceneEpoch &&
      useEditor.getState().driveFile?.id === binding.id;
    const pending = { ...binding, pendingWriteId: binding.pendingWriteId ?? crypto.randomUUID() };
    useEditor.setState({ driveFile: pending });
    useDrive.setState({ status: 'saving', progress: 0, message: null });
    const taskId =
      this.activityId ??
      startTask({
        title: `Save to Drive · ${state.scene.name}`,
        notify: false,
      });
    this.activityId = taskId;
    updateTask(taskId, { status: 'running', detail: 'Preparing scene for upload', progress: null });
    this.inFlight = (async () => {
      try {
        const file = await this.client.save(
          committedScene(state),
          pending,
          controller.signal,
          (progress) => {
            if (current()) {
              useDrive.setState({ progress });
              updateTask(taskId, {
                detail: progress < 1 ? 'Uploading scene' : 'Confirming saved scene',
                progress,
              });
            }
          },
        );
        if (!current()) {
          cancelTask(taskId, 'Drive save stopped for this scene.');
          return;
        }
        // Acknowledgements only cover the captured revision, never edits made during upload.
        useEditor.setState({ driveFile: driveBinding(file) });
        this.failures = 0;
        useDrive.setState({
          savedRevision: state.revision,
          status: 'saved',
          conflict: null,
          progress: 1,
          message: null,
        });
        completeTask(taskId, `${state.scene.name} saved to Google Drive.`);
      } catch (error) {
        if (!current() || controller.signal.aborted) {
          cancelTask(taskId, 'Drive save stopped for this scene.');
          return;
        }
        const failure =
          error instanceof DriveError
            ? error
            : new DriveError(
                error instanceof Error ? error.message : 'Google Drive could not save this scene.',
              );
        failTask(
          taskId,
          failure.kind === 'retryable'
            ? `${failure.message} Autosave will retry when connected.`
            : failure.message,
        );
        if (failure.kind === 'auth') {
          forgetDriveToken();
          useDrive.setState({ connected: false, status: 'reconnect', message: failure.message });
        } else if (failure.kind === 'retryable') {
          this.failures++;
          useDrive.setState({
            status: navigator.onLine ? 'pending' : 'offline',
            message: failure.message,
          });
        } else
          useDrive.setState({
            status: failure.kind === 'conflict' ? 'conflict' : 'error',
            conflict: failure instanceof DriveConflict ? failure.file : null,
            message: failure.message,
          });
      } finally {
        if (this.activityId === taskId) this.activityId = undefined;
        this.inFlight = undefined;
        if (this.controller === controller) this.controller = undefined;
        this.schedule();
      }
    })();
    return this.inFlight;
  }

  connected() {
    useDrive.setState({
      connected: true,
      status: useDrive.getState().conflict
        ? 'conflict'
        : useEditor.getState().driveFile
          ? this.dirty()
            ? 'pending'
            : 'saved'
          : 'idle',
      message: null,
    });
    this.schedule(0);
  }

  retry() {
    this.failures = 0;
    useDrive.setState({
      status: !useDrive.getState().connected
        ? 'reconnect'
        : !useEditor.getState().driveFile
          ? 'idle'
          : this.dirty()
            ? 'pending'
            : 'saved',
      message: null,
    });
    this.schedule(0);
  }

  acceptOpenedScene() {
    if (this.activityId) cancelTask(this.activityId, 'This revision is already saved to Drive.');
    this.activityId = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    useDrive.setState({
      savedRevision: useEditor.getState().revision,
      status: 'saved',
      conflict: null,
      message: null,
    });
  }

  /** Explicit conflict resolution must not race a queued or unfinished upload. */
  async whilePaused<T>(action: () => Promise<T>): Promise<T> {
    if (this.paused) throw new Error('A Drive action is already in progress.');
    this.paused = true;
    this.cancel();
    try {
      await this.inFlight;
      return await action();
    } finally {
      this.paused = false;
      this.schedule();
    }
  }

  /** Used before replacing a scene. Failure leaves the current assembly intact. */
  async flush(): Promise<boolean> {
    while (this.dirty()) {
      const state = useDrive.getState();
      if (
        this.paused ||
        !state.connected ||
        !navigator.onLine ||
        ['conflict', 'error', 'reconnect'].includes(state.status)
      )
        return false;
      await this.run();
      if (this.failures || this.stopped) return false;
    }
    return true;
  }
}

export const driveAutosave = new DriveAutosave();

export async function flushDriveBeforeReplace() {
  if (await driveAutosave.flush()) return true;
  useDrive.setState({ dialogOpen: true });
  useEditor
    .getState()
    .notify(
      'The current scene has not reached Drive. Retry saving, or download a copy and stop autosave before replacing it.',
      'error',
    );
  return false;
}

export function stopDriveAutosave() {
  useEditor.setState({ driveFile: null });
}

export async function disconnectDrive() {
  stopDriveAutosave();
  useDrive.setState({ connected: false, status: 'disconnected', message: null, conflict: null });
  await endDriveSession();
}

export async function saveNewDriveScene() {
  const epoch = useEditor.getState().sceneEpoch;
  const id = await googleDrive.allocateId();
  if (useEditor.getState().sceneEpoch !== epoch) return;
  useEditor.setState({ driveFile: { id, version: null } });
  driveAutosave.retry();
}

export async function openDriveScene(id: string, discardLocal = false) {
  if (!discardLocal && !(await flushDriveBeforeReplace())) return false;
  return driveAutosave.whilePaused(async () => {
    const state = useEditor.getState();
    state.setBusy('Opening scene from Google Drive…');
    try {
      const { scene, file } = await googleDrive.open(id);
      if (
        useEditor.getState().sceneEpoch !== state.sceneEpoch ||
        useEditor.getState().revision !== state.revision
      ) {
        throw new Error(
          'The workbench changed while this scene was opening. Please open it again.',
        );
      }
      state.setScene(scene, false, driveBinding(file));
      driveAutosave.acceptOpenedScene();
      state.notify('Scene opened from Google Drive');
      return true;
    } finally {
      state.setBusy(null);
    }
  });
}

/** The confirmation names the remote version being replaced, not an unchecked force write. */
export async function overwriteDriveScene(file: DriveFile) {
  const state = useEditor.getState();
  if (state.driveFile?.id !== file.id)
    throw new Error('The current Drive scene changed. Check again.');
  await driveAutosave.whilePaused(async () => {
    if (
      useEditor.getState().sceneEpoch !== state.sceneEpoch ||
      useEditor.getState().driveFile?.id !== file.id
    )
      throw new Error('The current Drive scene changed. Check again.');
    useEditor.setState({ driveFile: driveBinding(file) });
    useDrive.setState({ savedRevision: -1, status: 'pending', conflict: null, message: null });
  });
  return driveAutosave.flush();
}
