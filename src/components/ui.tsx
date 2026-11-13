import { Component, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ErrorInfo, ReactNode, RefObject } from 'react';
import { ChevronDown, LockKeyhole, X } from 'lucide-react';
import { clearRecovery } from '../core/recovery';
import type { AxisLocks, Vec3 } from '../core/types';

/** The last autosave survives a render failure, so offer a way back to it. */
export class AppBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Kitbasher:', error, info.componentStack);
  }
  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="app-crash" role="alert">
        <h1>Something went wrong</h1>
        <p>Reloading restores your last local save. Recent changes may need to be repeated.</p>
        <code>{this.state.error}</code>
        <div>
          <button className="button primary" onClick={() => location.reload()}>
            Reload Kitbasher
          </button>
          {/* A recovered scene that keeps failing would otherwise lock the user out. */}
          <button
            className="button secondary"
            onClick={() => {
              void clearRecovery()
                .catch(() => {})
                .finally(() => location.reload());
            }}
          >
            Discard local save and reload
          </button>
        </div>
      </div>
    );
  }
}

/** Close a floating menu on an outside press or Escape, before tool shortcuts see the key. */
export function useDismiss(
  container: RefObject<HTMLElement | null>,
  open: boolean,
  dismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [container, open, dismiss]);
}

export function IconButton({
  label,
  active,
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

export function NumericInput({
  id,
  value,
  onCommit,
  label,
  disabled = false,
  step = 1,
  min,
  max,
}: {
  id?: string;
  value: number;
  onCommit: (value: number) => void;
  label: string;
  disabled?: boolean;
  step?: number;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  return (
    <input
      id={id}
      aria-label={label}
      type="number"
      value={draft}
      disabled={disabled}
      step={step}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(String(Number(value.toFixed(3))));
          return;
        }
        const next = Number(draft);
        if (
          draft !== '' &&
          Number.isFinite(next) &&
          (min === undefined || next >= min) &&
          (max === undefined || next <= max)
        ) {
          if (next !== Number(value.toFixed(3))) onCommit(next);
        }
        // A rejected constraint edit leaves the committed value unchanged.
        setDraft(String(Number(value.toFixed(3))));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(String(Number(value.toFixed(3))));
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function VectorFields({
  label,
  values,
  onCommit,
  disabled = false,
  locks,
  unit,
  step = 1,
  min,
}: {
  label: string;
  values: Vec3;
  onCommit: (values: Vec3) => void;
  disabled?: boolean;
  locks?: AxisLocks;
  unit?: string;
  step?: number;
  min?: number;
}) {
  return (
    <div className="vector-control">
      <div className="field-label">
        <span>{label}</span>
        <small>{unit}</small>
      </div>
      <div className="vector-fields">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label
            key={axis}
            className={`axis-field axis-${axis.toLowerCase()} ${disabled || locks?.[i] ? 'disabled' : ''}`}
          >
            <span>{axis}</span>
            <NumericInput
              label={`${label} ${axis}`}
              value={values[i]}
              step={step}
              min={min}
              disabled={disabled || locks?.[i]}
              onCommit={(value) => {
                const next = [...values] as Vec3;
                next[i] = value;
                onCommit(next);
              }}
            />
            {locks?.[i] ? <LockKeyhole size={9} /> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Range and color inputs fire React's onChange throughout a drag and the native change event
 * once it ends. `begin()` is true only for a drag's first change, so each drag is one undo step.
 */
export function useDragCheckpoint() {
  const input = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const element = input.current!;
    const end = () => {
      dragging.current = false;
    };
    // A drag that ends where it began fires no change, so a new press also ends the last one.
    const events = ['change', 'pointerdown', 'keydown'];
    events.forEach((name) => element.addEventListener(name, end));
    return () => events.forEach((name) => element.removeEventListener(name, end));
  }, []);
  const begin = () => {
    const first = !dragging.current;
    dragging.current = true;
    return first;
  };
  return { input, begin };
}

export function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string, checkpoint: boolean) => void;
}) {
  const { input, begin } = useDragCheckpoint();
  return (
    <input
      ref={input}
      aria-label={label}
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value, begin())}
    />
  );
}

/** A swatch, its hex value or another short text, and a picker that opens on click. */
export function ColorControl({
  label,
  value,
  text,
  onChange,
}: {
  label: string;
  value: string;
  text?: string;
  onChange: (value: string, checkpoint: boolean) => void;
}) {
  return (
    <label className="color-control">
      <ColorInput label={label} value={value} onChange={onChange} />
      <span>{text ?? value.toUpperCase()}</span>
      <ChevronDown size={11} />
    </label>
  );
}

export function RangeInput({
  label,
  value,
  limit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  limit: { min: number; max: number; step: number };
  disabled?: boolean;
  onChange: (value: number, checkpoint: boolean) => void;
}) {
  const { input, begin } = useDragCheckpoint();
  return (
    <input
      ref={input}
      type="range"
      aria-label={label}
      min={limit.min}
      max={limit.max}
      step={limit.step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value), begin())}
    />
  );
}

export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** One choice of several. Arrow keys move the choice, and Tab enters at the chosen option. */
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T | null;
  options: { id: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const tabStop = options.some((o) => o.id === value) ? value : options[0]?.id;
  return (
    <div ref={group} role="radiogroup" aria-label={label} className={className}>
      {options.map((option, i) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          tabIndex={option.id === tabStop ? 0 : -1}
          title={option.title}
          className={option.id === value ? 'active' : ''}
          onClick={() => option.id !== value && onChange(option.id)}
          onKeyDown={(e) => {
            const step =
              e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (!step) return;
            e.preventDefault();
            const next = (i + step + options.length) % options.length;
            onChange(options[next].id);
            group.current?.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
