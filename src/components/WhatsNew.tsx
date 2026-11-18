import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Sparkles, X } from 'lucide-react';
import { latestRelease, releases } from '../docs/changelog';
import type { ChangeKind } from '../docs/changelog';
import { useDismiss } from './ui';

const seenKey = 'kitbasher.seen-release';
const shownReleases = 3;
const kindLabels: Record<ChangeKind, string> = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function readSeen() {
  try {
    const seen = localStorage.getItem(seenKey);
    // First visits start current; only releases shipped after that are announced.
    if (seen === null) localStorage.setItem(seenKey, latestRelease.version);
    return seen ?? latestRelease.version;
  } catch {
    return latestRelease.version;
  }
}

function markSeen() {
  try {
    localStorage.setItem(seenKey, latestRelease.version);
  } catch {
    // Storage can be unavailable; the dot then just clears for this session.
  }
}

const formatDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(() => readSeen() !== latestRelease.version);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useDismiss(container, open, close);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    markSeen();
    setUnseen(false);
  }, [open]);
  return (
    <div className="whats-new-center" ref={container}>
      <button
        ref={trigger}
        className="activity-trigger"
        aria-label={unseen ? `What’s new: version ${latestRelease.version} is new` : 'What’s new'}
        title="What’s new"
        aria-expanded={open}
        aria-controls="whats-new-panel"
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={17} />
        {unseen ? <span className="whats-new-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <section
          className="activity-panel whats-new-panel"
          id="whats-new-panel"
          aria-label="What’s new"
        >
          <div className="activity-panel-heading">
            <div>
              <h2 ref={heading} tabIndex={-1}>
                What’s new
              </h2>
              <p>You’re on version {latestRelease.version}</p>
            </div>
            <button className="icon-button" aria-label="Close what’s new" onClick={close}>
              <X size={16} />
            </button>
          </div>
          <div className="activity-panel-content">
            {releases.slice(0, shownReleases).map((release) => (
              <article className="whats-new-release" key={release.version}>
                <header>
                  <strong>{release.title}</strong>
                  <span>
                    {release.version} ·{' '}
                    <time dateTime={release.date}>{formatDate(release.date)}</time>
                  </span>
                </header>
                <ul>
                  {release.changes.map((change, i) => (
                    <li key={i}>
                      <span className={`whats-new-kind ${change.kind}`}>
                        {kindLabels[change.kind]}
                      </span>
                      <p>{change.text}</p>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <a
            className="whats-new-all"
            href={`./docs/?guide=whats-new#v${latestRelease.version.replaceAll('.', '-')}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            All release notes <ExternalLink size={12} />
          </a>
        </section>
      ) : null}
    </div>
  );
}
