import { useEffect, useState } from 'react';
import {
  Cloud,
  CloudCheck,
  CloudOff,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import {
  authorizeDrive,
  DriveError,
  forgetDriveToken,
  googleClientId,
  loadGoogleIdentity,
  restoreDriveSession,
} from '../core/google-auth';
import { googleDrive } from '../core/google-drive';
import type { DriveFile } from '../core/google-drive';
import {
  disconnectDrive,
  driveAutosave,
  driveStatusText,
  openDriveScene,
  overwriteDriveScene,
  saveNewDriveScene,
  stopDriveAutosave,
  useDrive,
} from '../core/drive-sync';
import { downloadCurrentScene } from '../core/commands';
import { liveSession, useEditor } from '../core/store';
import { Modal } from './ui';

export function DriveButton() {
  const { status, message } = useDrive();
  const binding = useEditor((state) => state.driveFile);
  if (liveSession) return null;
  const text = binding ? driveStatusText(status) : 'Google Drive';
  const Icon =
    status === 'saving'
      ? LoaderCircle
      : status === 'saved'
        ? CloudCheck
        : ['offline', 'error', 'conflict', 'reconnect'].includes(status)
          ? CloudOff
          : Cloud;
  return (
    <button
      className={`button secondary drive-button drive-${status}`}
      title={message ?? (binding ? text : 'Save to Google Drive automatically')}
      aria-label={`Google Drive: ${text}`}
      onClick={() => useDrive.setState({ dialogOpen: true })}
    >
      <Icon size={15} className={status === 'saving' ? 'spin' : undefined} />
      <span aria-live="polite">{text}</span>
    </button>
  );
}

export function GoogleDriveDialog() {
  const { dialogOpen } = useDrive();
  return dialogOpen && !liveSession ? <DriveDialog /> : null;
}

function DriveDialog() {
  const { connected, status, message, progress, conflict } = useDrive();
  const binding = useEditor((state) => state.driveFile);
  const name = useEditor((state) => state.scene.name);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPage, setNextPage] = useState<string | undefined>();
  const [selected, setSelected] = useState<DriveFile | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [resolution, setResolution] = useState<'load' | 'overwrite' | null>(null);
  const close = () => useDrive.setState({ dialogOpen: false });
  const failed = (failure: unknown) => {
    setError(
      failure instanceof Error ? failure.message : 'Google Drive could not complete this action.',
    );
    if (failure instanceof DriveError && failure.kind === 'auth') {
      forgetDriveToken();
      useDrive.setState({ connected: false, status: 'reconnect' });
    }
  };
  const perform = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      failed(failure);
    } finally {
      setWorking(false);
    }
  };
  useEffect(() => {
    if (!googleClientId) return;
    let active = true;
    Promise.all([loadGoogleIdentity(), restoreDriveSession()])
      .then(([, restored]) => {
        if (active) {
          setReady(true);
          if (restored && !useDrive.getState().connected) driveAutosave.connected();
        }
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!connected) {
      setFiles([]);
      return;
    }
    let active = true;
    setListing(true);
    googleDrive
      .list()
      .then((page) => {
        if (active) {
          setFiles(page.files);
          setNextPage(page.nextPageToken);
        }
      })
      .catch((failure) => {
        if (active) failed(failure);
      })
      .finally(() => {
        if (active) setListing(false);
      });
    return () => {
      active = false;
    };
  }, [connected, refresh]);

  return (
    <Modal
      title="Google Drive"
      subtitle="Save once. Your assembly keeps saving as you work."
      onClose={close}
    >
      <div className="drive-dialog-content">
        {!googleClientId ? (
          <p>
            Google Drive has not been enabled for this installation yet. You can keep working and
            download a scene copy in the meantime.
          </p>
        ) : (
          <>
            <p>
              Kitbasher can access the files you create with it. Your scenes stay private in your
              Google Drive.
            </p>
            {!connected ? (
              <>
                {binding ? (
                  <p>
                    Reconnect to continue saving <strong>{name}</strong> to its existing Drive file.
                  </p>
                ) : null}
                <button
                  className="button primary"
                  disabled={!ready || working}
                  onClick={() =>
                    void perform(async () => {
                      await authorizeDrive();
                      driveAutosave.connected();
                    })
                  }
                >
                  {working || !ready ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Cloud size={15} />
                  )}
                  {binding ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                </button>
                {!ready && error ? (
                  <button
                    className="button secondary"
                    onClick={() =>
                      void perform(async () => {
                        await loadGoogleIdentity();
                        if (await restoreDriveSession()) driveAutosave.connected();
                        setReady(true);
                      })
                    }
                  >
                    Retry Google sign-in
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <section className="drive-current" aria-label="Current scene in Google Drive">
                  <div>
                    <strong>{name}</strong>
                    <p role="status">
                      {binding ? driveStatusText(status) : 'This scene is only in this browser.'}
                    </p>
                  </div>
                  {binding && status === 'saving' ? (
                    <progress aria-label="Google Drive upload progress" value={progress} max={1} />
                  ) : null}
                  {binding ? (
                    <>
                      <a
                        className="button secondary"
                        href={`https://drive.google.com/file/d/${encodeURIComponent(binding.id)}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink size={14} />
                        View in Drive
                      </a>
                      {['error', 'pending', 'offline'].includes(status) ? (
                        <button
                          className="button secondary"
                          disabled={working}
                          onClick={() => driveAutosave.retry()}
                        >
                          <RefreshCw size={14} />
                          Retry saving
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <button
                      className="button primary"
                      disabled={working}
                      onClick={() => void perform(saveNewDriveScene)}
                    >
                      <Cloud size={15} />
                      Save this scene to Drive
                    </button>
                  )}
                </section>
                {binding && status === 'conflict' ? (
                  <section className="drive-open-confirmation" aria-label="Resolve Drive conflict">
                    <strong>Choose which scene to keep</strong>
                    <p>
                      Your local edits are safe in this browser. Drive has a different version
                      {conflict?.modifiedTime
                        ? ` saved ${new Date(conflict.modifiedTime).toLocaleString()}`
                        : ''}
                      .
                    </p>
                    {resolution ? (
                      <>
                        <p>
                          {resolution === 'load'
                            ? 'Load the Drive version and discard the current local edits? Download a scene copy first if you want to keep them.'
                            : 'Replace the Drive version with your current local scene? Other devices will see this version.'}
                        </p>
                        <div className="drive-inline-actions">
                          <button
                            className="button secondary"
                            disabled={working}
                            onClick={() => setResolution(null)}
                          >
                            Cancel
                          </button>
                          <button
                            className="button primary"
                            disabled={working}
                            onClick={() =>
                              void perform(async () => {
                                if (resolution === 'load') {
                                  if (await openDriveScene(binding.id, true)) close();
                                } else if (conflict) {
                                  await overwriteDriveScene(conflict);
                                }
                                setResolution(null);
                              })
                            }
                          >
                            {resolution === 'load'
                              ? 'Discard local edits and load'
                              : 'Confirm overwrite'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="drive-inline-actions">
                        <button
                          className="button secondary"
                          disabled={working}
                          onClick={() => setResolution('load')}
                        >
                          Load Drive version
                        </button>
                        <button
                          className="button secondary"
                          disabled={working || !conflict}
                          onClick={() => setResolution('overwrite')}
                        >
                          Overwrite Drive version
                        </button>
                        <button
                          className="button secondary"
                          disabled={working}
                          onClick={() => {
                            setError(null);
                            driveAutosave.retry();
                          }}
                        >
                          Check again
                        </button>
                      </div>
                    )}
                  </section>
                ) : null}
                <div className="drive-list-heading">
                  <strong>Your Drive scenes</strong>
                  <button
                    className="button secondary"
                    disabled={working || listing}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    <RefreshCw size={13} />
                    Refresh
                  </button>
                </div>
                {selected ? (
                  <div className="drive-open-confirmation">
                    <strong>Open {selected.name}?</strong>
                    <p>
                      This replaces the current workbench. Save or download any changes you want to
                      keep first.
                    </p>
                    <div className="drive-inline-actions">
                      <button
                        className="button secondary"
                        disabled={working}
                        onClick={() => setSelected(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="button primary"
                        disabled={working}
                        onClick={() =>
                          void perform(async () => {
                            if (await openDriveScene(selected.id)) close();
                          })
                        }
                      >
                        <FolderOpen size={14} />
                        Open scene
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {listing ? (
                      <p role="status">Loading Drive scenes…</p>
                    ) : files.length === 0 ? (
                      <p>No scenes saved with Kitbasher yet.</p>
                    ) : null}
                    <ul className="drive-file-list" aria-label="Scenes saved with Kitbasher">
                      {files.map((file) => (
                        <li key={file.id}>
                          <button disabled={working} onClick={() => setSelected(file)}>
                            <FolderOpen size={17} />
                            <span>
                              <strong>{file.name}</strong>
                              {file.modifiedTime ? (
                                <small>{new Date(file.modifiedTime).toLocaleString()}</small>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {nextPage ? (
                      <button
                        className="button secondary"
                        disabled={working || listing}
                        onClick={() =>
                          void perform(async () => {
                            const page = await googleDrive.list(nextPage);
                            setFiles((current) => [
                              ...current,
                              ...page.files.filter(
                                (file) => !current.some((old) => old.id === file.id),
                              ),
                            ]);
                            setNextPage(page.nextPageToken);
                          })
                        }
                      >
                        Load more scenes
                      </button>
                    ) : null}
                  </>
                )}
              </>
            )}
          </>
        )}
        {error || message ? (
          <p className="drive-error" role="alert">
            {error ?? message}
          </p>
        ) : null}
        {binding ? (
          <div className="drive-inline-actions">
            {connected ? (
              <button
                className="button secondary"
                disabled={working}
                onClick={() => void perform(saveNewDriveScene)}
              >
                Save a new Drive copy
              </button>
            ) : null}
            <button className="button secondary" disabled={working} onClick={stopDriveAutosave}>
              Stop autosave
            </button>
          </div>
        ) : null}
        <p className="drive-note">
          Local recovery continues while offline. Wait for “Saved to Drive” before closing. Use one
          editor at a time for each Drive scene. Your connection is restored when possible; Google
          may occasionally ask you to reconnect.
        </p>
      </div>
      <div className="modal-footer">
        {connected ? (
          <button
            className="button secondary"
            disabled={working}
            onClick={() => void perform(disconnectDrive)}
          >
            Disconnect
          </button>
        ) : null}
        <button className="button secondary" onClick={() => void downloadCurrentScene()}>
          <Download size={14} />
          Download scene copy
        </button>
        <button className="button primary" onClick={close}>
          Done
        </button>
      </div>
    </Modal>
  );
}
