import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { useDismiss } from '../lib/hooks';
import { EASE_OUT, reducedMotion } from '../lib/motion';
import { CheckIcon, ChevronDownIcon, XIcon } from './Icons';

// ── buttons ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'brand' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-white text-black hover:bg-white/75',
  brand: 'bg-brand text-white hover:bg-brand-dark',
  // Netflix's translucent grey "More Info" button.
  secondary: 'bg-[rgb(109_109_110/0.7)] text-white hover:bg-[rgb(109_109_110/0.4)]',
  ghost: 'text-neutral-200 hover:bg-white/10',
  danger: 'bg-red-700/80 text-white hover:bg-red-700',
};

const SIZES = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-base gap-2.5',
  /** Billboard buttons scale with the viewport, like Netflix's 1.2vw text. */
  hero: 'h-[clamp(2.5rem,2.55vw,3.25rem)] px-[clamp(1.2rem,1.6vw,2rem)] text-[clamp(1rem,1vw,1.25rem)] gap-[0.5em]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center rounded-[4px] font-semibold whitespace-nowrap transition-[background-color,transform,opacity] duration-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
      disabled={rest.disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={16} /> : null}
      {children}
    </button>
  );
}

/** Round icon button (preview card, detail modal) with a Netflix-style tooltip. */
export function IconButton({
  className = '',
  label,
  tone = 'outline',
  size = 'md',
  tip = true,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'outline' | 'solid'; size?: 'sm' | 'md' | 'lg'; tip?: boolean }) {
  const sizes = { sm: 'size-[clamp(30px,2.3vw,42px)]', md: 'size-10', lg: 'size-[clamp(2.6rem,3.1vw,3.5rem)]' };
  const tones = {
    outline: 'border-2 border-white/50 bg-[rgb(42_42_42/0.6)] text-white hover:border-white hover:bg-white/10',
    solid: 'bg-white text-black hover:bg-white/75',
  };
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={tip ? label : undefined}
      className={`grid shrink-0 place-items-center rounded-full transition-[background-color,border-color,transform] duration-200 active:scale-90 ${tip ? 'tip' : ''} ${sizes[size]} ${tones[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Netflix-style dropdown (season picker, genre filter): dark box, white caret, animated menu. */
export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  label,
  placeholder,
  className = '',
  buttonClassName = '',
  menuClassName = '',
  align = 'left',
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; detail?: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
  placeholder?: ReactNode;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-3 rounded-[3px] border border-white/40 bg-black px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-white/10 ${buttonClassName}`}
      >
        {current?.label ?? placeholder ?? label}
        <ChevronDownIcon size={16} className={`transition-transform duration-300 ease-caret ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={label}
          className={`absolute top-[calc(100%+4px)] z-30 max-h-[60vh] min-w-full overflow-y-auto rounded-[3px] border border-white/15 bg-black/95 py-1.5 text-sm shadow-2xl animate-menu ${align === 'right' ? 'right-0' : 'left-0'} ${menuClassName}`}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <li key={String(o.value)} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left whitespace-nowrap transition-colors hover:bg-white/10 ${selected ? 'font-semibold text-white' : 'text-ink'}`}
                >
                  <span className="w-4 shrink-0">{selected && <CheckIcon size={14} />}</span>
                  <span className="flex-1">{o.label}</span>
                  {o.detail != null && <span className="pl-4 text-xs font-normal text-muted">{o.detail}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Spinner({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({ children, tone = 'outline' }: { children: ReactNode; tone?: 'outline' | 'solid' | 'brand' | 'green' | 'amber' | 'red' }) {
  const tones = {
    outline: 'border border-neutral-400/60 text-neutral-200',
    solid: 'bg-neutral-700 text-neutral-100',
    brand: 'bg-brand/90 text-white',
    green: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
    red: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none ${tones[tone]}`}>{children}</span>;
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md bg-red-950/60 p-4 text-sm text-red-200 ring-1 ring-red-500/30">
      <p className="whitespace-pre-line">{message}</p>
      {onRetry && (
        <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? 'bg-brand' : 'bg-neutral-600'}`}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

/** Text input/select look without a width (combine with w-auto, w-16...). */
export const inputBase =
  'rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-neutral-400 focus:outline-none';
export const inputClass = `w-full ${inputBase}`;

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-neutral-200">{label}</span>
      {children}
      {hint && <span className="block text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}

// ── modal ────────────────────────────────────────────────────────────────────

let openModals = 0;

/** Accessible dialog with backdrop, Escape to close and body scroll lock.
 *  `origin` makes it zoom out of that rect (the tile that opened it). While `exiting`
 *  it plays its close animation, then calls `onExited`. */
export function Modal({
  onClose,
  children,
  label,
  className = 'max-w-lg',
  closeButton = true,
  origin,
  exiting = false,
  onExited,
}: {
  onClose: () => void;
  children: ReactNode;
  label: string;
  className?: string;
  closeButton?: boolean;
  origin?: DOMRect | null;
  exiting?: boolean;
  onExited?: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  useEffect(() => {
    openModals++;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exitingRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      if (--openModals === 0) document.body.style.overflow = '';
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  // Enter: zoom out of the origin rect (Netflix's tile → modal), or a quick pop.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || reducedMotion()) return;
    overlay.current?.animate([{ backgroundColor: 'rgb(0 0 0 / 0)' }, { backgroundColor: 'rgb(0 0 0 / 0.7)' }], { duration: 320, easing: 'ease-out' });
    if (origin && origin.width > 0) {
      const to = el.getBoundingClientRect();
      const scale = origin.width / to.width;
      el.animate(
        [
          { transformOrigin: 'top left', transform: `translate(${origin.left - to.left}px, ${origin.top - to.top}px) scale(${scale})`, opacity: 0.5 },
          { transformOrigin: 'top left', transform: 'none', opacity: 1 },
        ],
        { duration: 420, easing: EASE_OUT },
      );
    } else {
      el.animate([{ transform: 'scale(0.94)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: EASE_OUT });
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exit: shrink and fade, then let the owner unmount us.
  useEffect(() => {
    if (!exiting) return;
    const el = panel.current;
    if (!el || reducedMotion()) {
      onExitedRef.current?.();
      return;
    }
    const fade = overlay.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
    const shrink = el.animate([{ transform: 'none' }, { transform: 'scale(0.92)' }], { duration: 240, easing: 'ease-in', fill: 'forwards' });
    shrink.onfinish = () => onExitedRef.current?.();
    return () => {
      fade?.cancel();
      shrink.cancel();
    };
  }, [exiting]);

  return (
    <div
      ref={overlay}
      className={`fixed inset-0 z-50 overflow-y-auto bg-black/70 px-3 py-8 sm:px-6 sm:py-[2em] ${exiting ? 'pointer-events-none' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`relative mx-auto w-full overflow-hidden rounded-md bg-panel shadow-[0_3px_10px_rgb(0_0_0/0.75)] outline-none ${className}`}
      >
        {closeButton && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute top-[0.9em] right-[0.9em] z-20 grid size-9 place-items-center rounded-full bg-panel text-white transition-[transform,background-color] duration-200 hover:rotate-90 hover:bg-hover"
          >
            <XIcon size={20} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <Modal onClose={onClose} label={title} className="max-w-md">
      <div className="space-y-4 p-6">
        <h2 className="text-lg font-bold">{title}</h2>
        <div className="text-sm text-neutral-300">{message}</div>
        {error ? <ErrorNote error={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'brand'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-[4px] px-4 py-3 text-sm whitespace-pre-line shadow-xl ring-1 animate-fade-up ${
              t.tone === 'error' ? 'bg-red-950 text-red-100 ring-red-500/40' : 'bg-[#e6e6e6] font-semibold text-[#181818] ring-black/10'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
