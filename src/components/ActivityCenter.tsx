import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Info,
  LoaderCircle,
  X,
} from 'lucide-react';
import {
  clearFinishedTasks,
  clearNotifications,
  dismissNotification,
  isTaskActive,
  markAllNotificationsRead,
  removeNotification,
  requestTaskCancellation,
  useActivity,
} from '../core/activity';
import type { AppNotification, BackgroundTask, NotificationKind } from '../core/activity';
import { useEditor } from '../core/store';
import { useDismiss } from './ui';

function NoticeIcon({ kind }: { kind: NotificationKind }) {
  return kind === 'success' ? (
    <CheckCircle2 size={16} />
  ) : kind === 'error' || kind === 'warning' ? (
    <CircleAlert size={16} />
  ) : (
    <Info size={16} />
  );
}
function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
const statusLabels = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function TaskRow({ task, now }: { task: BackgroundTask; now: number }) {
  const active = isTaskActive(task);
  return (
    <article className={`activity-row activity-${task.status}`} aria-label={task.title}>
      <div className="activity-row-heading">
        {task.status === 'running' ? (
          <LoaderCircle className="spin" size={15} />
        ) : task.status === 'queued' ? (
          <Clock3 size={15} />
        ) : task.status === 'failed' ? (
          <CircleAlert size={15} />
        ) : task.status === 'cancelled' ? (
          <X size={15} />
        ) : (
          <CheckCircle2 size={15} />
        )}
        <strong>{task.title}</strong>
        {active && task.cancellable ? (
          <button
            className="activity-text-button"
            aria-label={`Cancel ${task.title}`}
            onClick={() => requestTaskCancellation(task.id)}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <p>{task.detail || statusLabels[task.status]}</p>
      {active ? (
        <progress
          aria-label={`${task.title} progress`}
          max={1}
          value={task.progress ?? undefined}
        />
      ) : null}
      <div className="activity-row-meta">
        <span>
          {statusLabels[task.status]}
          {active && task.progress !== null
            ? ` · ${Math.round(task.progress * 100)}% of stage`
            : ''}
        </span>
        <span>{duration((task.finishedAt ?? now) - task.startedAt)} elapsed</span>
      </div>
    </article>
  );
}

export function ActivityCenter() {
  const tasks = useActivity((state) => state.tasks);
  const notifications = useActivity((state) => state.notifications);
  const [panel, setPanel] = useState<'activity' | 'notifications' | null>(null);
  const [now, setNow] = useState(Date.now);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const active = tasks.filter(isTaskActive);
  const finished = tasks.filter((task) => !isTaskActive(task));
  const unread = notifications.filter((item) => !item.read).length;
  const close = useCallback(() => {
    setPanel(null);
    trigger.current?.focus();
  }, []);
  useDismiss(container, !!panel, close);
  useEffect(() => {
    if (panel) heading.current?.focus();
  }, [panel]);
  useEffect(() => {
    if (panel !== 'activity' || !active.length) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [panel, active.length]);
  const open = (next: typeof panel, button: HTMLButtonElement) => {
    trigger.current = button;
    setNow(Date.now());
    setPanel(panel === next ? null : next);
  };
  return (
    <div className="activity-center" ref={container}>
      <button
        className={`activity-trigger ${active.length ? 'has-activity' : ''}`}
        aria-label="Background activity"
        title="Background activity"
        aria-expanded={panel === 'activity'}
        aria-controls="background-activity-panel"
        onClick={(event) => open('activity', event.currentTarget)}
      >
        {active.length ? <LoaderCircle className="spin" size={17} /> : <Activity size={17} />}
        {active.length ? <span className="activity-badge">{active.length}</span> : null}
      </button>
      <button
        className="activity-trigger"
        aria-label="Notifications"
        title={unread ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={panel === 'notifications'}
        aria-controls="notifications-panel"
        onClick={(event) => open('notifications', event.currentTarget)}
      >
        <Bell size={17} />
        {unread ? (
          <span className="activity-badge notification-badge">{unread > 99 ? '99+' : unread}</span>
        ) : null}
      </button>
      {panel ? (
        <section
          className="activity-panel"
          id={panel === 'activity' ? 'background-activity-panel' : 'notifications-panel'}
          aria-label={panel === 'activity' ? 'Background activity' : 'Notifications'}
        >
          <div className="activity-panel-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                {panel === 'activity' ? 'Background activity' : 'Notifications'}
              </h2>
              <p>
                {panel === 'activity'
                  ? `${active.length} active · recent jobs this session`
                  : `${unread} unread · this session`}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label={
                panel === 'activity' ? 'Close background activity' : 'Close notifications'
              }
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          <div className="activity-panel-actions">
            {panel === 'activity' ? (
              <button
                className="activity-text-button"
                disabled={!finished.length}
                onClick={clearFinishedTasks}
              >
                Clear finished
              </button>
            ) : (
              <>
                <button
                  className="activity-text-button"
                  disabled={!unread}
                  onClick={markAllNotificationsRead}
                >
                  <Check size={13} /> Mark all read
                </button>
                <button
                  className="activity-text-button"
                  disabled={!notifications.length}
                  onClick={clearNotifications}
                >
                  Clear notifications
                </button>
              </>
            )}
          </div>
          <div className="activity-panel-content">
            {panel === 'activity' ? (
              tasks.length ? (
                [...active, ...finished].map((task) => (
                  <TaskRow key={task.id} task={task} now={now} />
                ))
              ) : (
                <div className="activity-empty">
                  <Activity size={24} />
                  <strong>No background jobs yet</strong>
                  <p>Interference checks, mesh preparation and Drive uploads appear here.</p>
                </div>
              )
            ) : notifications.length ? (
              notifications.map((item) => (
                <article
                  key={item.id}
                  className={`notification-row notification-${item.kind} ${item.read ? '' : 'unread'}`}
                >
                  <NoticeIcon kind={item.kind} />
                  <div>
                    <p>{item.message}</p>
                    <time dateTime={new Date(item.createdAt).toISOString()}>
                      {new Date(item.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Remove notification: ${item.message}`}
                    onClick={() => removeNotification(item.id)}
                  >
                    <X size={13} />
                  </button>
                </article>
              ))
            ) : (
              <div className="activity-empty">
                <Bell size={24} />
                <strong>You're all caught up</strong>
                <p>Completed work and alerts will appear here.</p>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ToastItem({ notice }: { notice: AppNotification }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    // Errors stay until dismissed. Other banners can always be revisited in Notifications.
    if (paused || notice.kind === 'error' || notice.kind === 'warning') return;
    const timer = setTimeout(() => dismissNotification(notice.id), 5000);
    return () => clearTimeout(timer);
  }, [notice.id, notice.kind, paused]);
  return (
    <div
      className={`toast toast-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <NoticeIcon kind={notice.kind} />
      <span>{notice.message}</span>
      <button aria-label="Dismiss notification" onClick={() => dismissNotification(notice.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function NotificationToasts() {
  const notifications = useActivity((state) => state.notifications);
  // Keep the existing transient editor message used by the headset and duplicate suppression.
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => {
        if (useEditor.getState().toast?.id === toast.id) useEditor.setState({ toast: null });
      },
      toast.kind === 'error' ? 7000 : 3500,
    );
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="notification-toasts" aria-label="Recent notifications">
      {notifications
        .filter((item) => !item.dismissed)
        .slice(0, 3)
        .map((notice) => (
          <ToastItem key={notice.id} notice={notice} />
        ))}
    </div>
  );
}
