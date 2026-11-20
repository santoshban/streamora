import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { XIcon } from './Icons';

// ── buttons ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'brand' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-white text-black hover:bg-white/80',
  brand: 'bg-brand text-white hover:bg-brand-dark',
  secondary: 'bg-neutral-500/40 text-white hover:bg-neutral-500/60 backdrop-blur',
  ghost: 'text-neutral-200 hover:bg-white/10',
  danger: 'bg-red-700/80 text-white hover:bg-red-700',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  const sizes = { sm: 'h-8 px-3 text-sm gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-base gap-2.5' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center rounded-md font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${VARIANTS[variant]} ${className}`}
      disabled={rest.disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={16} /> : null}
      {children}
    </button>
  );
}

/** Round icon button (detail modal actions, card hover actions). */
export function IconButton({ className = '', label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`grid size-10 shrink-0 place-items-center rounded-full border-2 border-neutral-400/70 bg-neutral-900/60 text-white transition hover:border-white ${className}`}
      {...rest}
    >
      {children}
    </button>
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

/** Accessible dialog with backdrop, Escape to close and body scroll lock. */
export function Modal({
  onClose,
  children,
  label,
  className = 'max-w-lg',
  closeButton = true,
}: {
  onClose: () => void;
  children: ReactNode;
  label: string;
  className?: string;
  closeButton?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    openModals++;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      if (--openModals === 0) document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70 px-3 py-8 backdrop-blur-sm sm:px-6 sm:py-12"
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
        className={`relative mx-auto w-full overflow-hidden rounded-lg bg-neutral-900 shadow-2xl ring-1 ring-white/10 outline-none animate-[pop_.18s_ease-out] ${className}`}
      >
        {closeButton && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute top-3 right-3 z-20 grid size-9 place-items-center rounded-full bg-neutral-900/80 text-white hover:bg-neutral-800"
          >
            <XIcon size={18} />
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
            className={`pointer-events-auto rounded-md px-4 py-3 text-sm whitespace-pre-line shadow-xl ring-1 animate-[pop_.18s_ease-out] ${
              t.tone === 'error' ? 'bg-red-950 text-red-100 ring-red-500/40' : 'bg-neutral-800 text-white ring-white/10'
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
