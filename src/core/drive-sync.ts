import { create } from 'zustand';
import { DriveError, forgetDriveToken } from './google-auth';
import { googleDrive } from './google-drive';
import { liveSession, useEditor } from './store';
import type { GoogleDriveClient } from './google-drive';

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
}>(() => ({
  connected: false,
  dialogOpen: false,
  status: 'disconnected',
  progress: 0,
  savedRevision: -1,
  message: null,
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
    if (useDrive.getState().status === 'offline' || this.failures) this.retry();
  };
  private offline = () => {
    if (this.dirty()) useDrive.setState({ status: 'offline' });
  };

  private schedule(delay?: number) {
    if (this.stopped || !this.dirty()) return;
    const state = useDrive.getState();
    if (!state.connected) {
      useDrive.setState({ status: 'reconnect' });
      return;
    }
    if (['conflict', 'error', 'reconnect'].includes(state.status)) return;
    if (!navigator.onLine) {
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
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
  }

  private run(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const state = useEditor.getState(),
      binding = state.driveFile;
    if (this.stopped || !binding || !this.dirty()) return Promise.resolve();
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
    this.inFlight = (async () => {
      try {
        const file = await this.client.save(state.scene, pending, controller.signal, (progress) => {
          if (current()) useDrive.setState({ progress });
        });
        if (!current()) return;
        // Acknowledgements only cover the captured revision, never edits made during upload.
        useEditor.setState({ driveFile: { id: file.id, version: file.version } });
        this.failures = 0;
        useDrive.setState({
          savedRevision: state.revision,
          status: 'saved',
          progress: 1,
          message: null,
        });
      } catch (error) {
        if (!current() || controller.signal.aborted) return;
        const failure =
          error instanceof DriveError
            ? error
            : new DriveError(
                error instanceof Error ? error.message : 'Google Drive could not save this scene.',
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
            message: failure.message,
          });
      } finally {
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
      status: useEditor.getState().driveFile ? (this.dirty() ? 'pending' : 'saved') : 'idle',
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
    clearTimeout(this.timer);
    this.timer = undefined;
    useDrive.setState({
      savedRevision: useEditor.getState().revision,
      status: 'saved',
      message: null,
    });
  }

  /** Used before replacing a scene. Failure leaves the current assembly intact. */
  async flush(): Promise<boolean> {
    while (this.dirty()) {
      const state = useDrive.getState();
      if (
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

export function disconnectDrive() {
  stopDriveAutosave();
  forgetDriveToken();
  useDrive.setState({ connected: false, status: 'disconnected', message: null });
}

export async function saveNewDriveScene() {
  const epoch = useEditor.getState().sceneEpoch;
  const id = await googleDrive.allocateId();
  if (useEditor.getState().sceneEpoch !== epoch) return;
  useEditor.setState({ driveFile: { id, version: null } });
  driveAutosave.retry();
}

export async function openDriveScene(id: string) {
  if (!(await flushDriveBeforeReplace())) return false;
  const state = useEditor.getState();
  state.setBusy('Opening scene from Google Drive…');
  try {
    const { scene, file } = await googleDrive.open(id);
    if (
      useEditor.getState().sceneEpoch !== state.sceneEpoch ||
      useEditor.getState().revision !== state.revision
    ) {
      throw new Error('The workbench changed while this scene was opening. Please open it again.');
    }
    state.setScene(scene, false, { id: file.id, version: file.version });
    driveAutosave.acceptOpenedScene();
    state.notify('Scene opened from Google Drive');
    return true;
  } finally {
    state.setBusy(null);
  }
}
