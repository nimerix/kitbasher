import { useEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';

export function IconButton({
  label,
  active = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      className={`icon-button ${active ? 'is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...props}
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  children,
  action,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="inspector-section" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        <span
          className="section-action"
          onClick={(e) => {
            if (action) e.preventDefault();
          }}
        >
          {action || <ChevronDown size={13} />}
        </span>
      </summary>
      <div className="section-content">{children}</div>
    </details>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const backdrop = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = backdrop.current!,
      previousFocus = document.activeElement as HTMLElement;
    const siblings = Array.from(element.parentElement?.children ?? []).filter(
      (e) => e !== element,
    ) as HTMLElement[];
    const previousInert = siblings.map((e) => e.inert);
    siblings.forEach((e) => (e.inert = true));
    const focusable = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type=file]), select:not(:disabled), [tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    element.addEventListener('keydown', keydown);
    return () => {
      element.removeEventListener('keydown', keydown);
      siblings.forEach((e, i) => (e.inert = previousInert[i]));
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <div
      ref={backdrop}
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'modal-wide' : ''}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 24 : 30}
      height={small ? 27 : 34}
      viewBox="0 0 30 34"
      fill="none"
      aria-hidden="true"
    >
      <path d="M15 1 28 8.5v16L15 32 2 24.5v-16L15 1Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="m2 8.5 13 7.6 13-7.6M15 16v16" stroke="currentColor" strokeWidth="1.8" />
      <path d="m9 5.2 13 7.5v7.1l-7 4.1-7-4.1V12.7" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function Keyboard({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
