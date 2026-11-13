import { create } from 'zustand';

export type NotificationKind = 'success' | 'error' | 'info' | 'warning';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface BackgroundTask {
  id: string;
  title: string;
  detail: string;
  /** Fraction of the named stage, or null when the operation cannot measure its progress. */
  progress: number | null;
  status: TaskStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  cancellable: boolean;
}
export interface AppNotification {
  id: string;
  message: string;
  kind: NotificationKind;
  createdAt: number;
  read: boolean;
  dismissed: boolean;
  taskId?: string;
}
interface TaskOptions {
  title: string;
  detail?: string;
  progress?: number | null;
  status?: 'queued' | 'running';
  cancel?: () => void;
  notify?: boolean;
}
const controls = new Map<string, Pick<TaskOptions, 'cancel' | 'notify'>>();
// randomUUID requires a secure context; the local workbench also runs over LAN HTTP.
const activityId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
export const isTaskActive = (task: BackgroundTask) =>
  task.status === 'running' || task.status === 'queued';
const fraction = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;

/** Session history only: never restore a running job after its worker has gone away. */
export const useActivity = create<{
  tasks: BackgroundTask[];
  notifications: AppNotification[];
}>(() => ({ tasks: [], notifications: [] }));

export function notify(
  message: string,
  kind: NotificationKind = 'success',
  options: { taskId?: string } = {},
) {
  const id = activityId();
  useActivity.setState((state) => ({
    notifications: [
      { id, message, kind, createdAt: Date.now(), read: false, dismissed: false, ...options },
      ...state.notifications,
    ].slice(0, 100),
  }));
  return id;
}

export function dismissNotification(id: string) {
  useActivity.setState((state) => ({
    notifications: state.notifications.map((item) =>
      item.id === id ? { ...item, dismissed: true } : item,
    ),
  }));
}
export function markAllNotificationsRead() {
  useActivity.setState((state) => ({
    notifications: state.notifications.map((item) => ({ ...item, read: true })),
  }));
}
export function removeNotification(id: string) {
  useActivity.setState((state) => ({
    notifications: state.notifications.filter((item) => item.id !== id),
  }));
}
export function clearNotifications() {
  useActivity.setState({ notifications: [] });
}

export function startTask(options: TaskOptions) {
  const id = activityId();
  const now = Date.now();
  controls.set(id, { cancel: options.cancel, notify: options.notify });
  useActivity.setState((state) => ({
    tasks: [
      {
        id,
        title: options.title,
        detail: options.detail ?? '',
        progress: fraction(options.progress),
        status: options.status ?? 'running',
        startedAt: now,
        updatedAt: now,
        cancellable: !!options.cancel,
      },
      ...state.tasks,
    ],
  }));
  return id;
}
export function updateTask(
  id: string,
  patch: { detail?: string; progress?: number | null; status?: 'queued' | 'running' },
) {
  useActivity.setState((state) => ({
    tasks: state.tasks.map((task) =>
      task.id === id && isTaskActive(task)
        ? {
            ...task,
            ...patch,
            ...('progress' in patch ? { progress: fraction(patch.progress) } : {}),
            updatedAt: Date.now(),
          }
        : task,
    ),
  }));
}
function finishTask(id: string, status: 'completed' | 'failed' | 'cancelled', detail?: string) {
  const task = useActivity.getState().tasks.find((item) => item.id === id);
  if (!task || !isTaskActive(task)) return;
  const shouldNotify = controls.get(id)?.notify !== false;
  controls.delete(id);
  const now = Date.now();
  useActivity.setState((state) => {
    let finished = 0;
    return {
      tasks: state.tasks
        .map((item) =>
          item.id === id
            ? {
                ...item,
                status,
                detail: detail ?? item.detail,
                progress: status === 'completed' ? 1 : item.progress,
                updatedAt: now,
                finishedAt: now,
                cancellable: false,
              }
            : item,
        )
        // Retain recent outcomes even when an old job finishes after many quick jobs.
        .sort((a, b) => {
          if (isTaskActive(a) !== isTaskActive(b)) return isTaskActive(a) ? -1 : 1;
          if (isTaskActive(a)) return b.startedAt - a.startedAt;
          if (a.id === id) return -1;
          if (b.id === id) return 1;
          return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
        })
        .filter((item) => isTaskActive(item) || ++finished <= 50),
    };
  });
  if (status === 'failed')
    notify(`${task.title}: ${detail || 'The operation failed.'}`, 'error', { taskId: id });
  else if (status === 'completed' && shouldNotify)
    notify(`${task.title} completed${detail ? ` · ${detail}` : ''}`, 'success', { taskId: id });
}
export const completeTask = (id: string, detail?: string) => finishTask(id, 'completed', detail);
export const failTask = (id: string, error: string) => finishTask(id, 'failed', error);
export const cancelTask = (id: string, detail = 'Cancelled') => finishTask(id, 'cancelled', detail);

export function requestTaskCancellation(id: string) {
  const task = useActivity.getState().tasks.find((item) => item.id === id);
  const control = controls.get(id);
  if (!task || !isTaskActive(task) || !control?.cancel) return;
  const cancel = control.cancel;
  // Disable immediately, including while an asynchronous abort settles.
  control.cancel = undefined;
  useActivity.setState((state) => ({
    tasks: state.tasks.map((item) => (item.id === id ? { ...item, cancellable: false } : item)),
  }));
  try {
    cancel();
  } catch (error) {
    failTask(id, error instanceof Error ? error.message : String(error));
  }
}
export function clearFinishedTasks() {
  useActivity.setState((state) => ({ tasks: state.tasks.filter(isTaskActive) }));
}
