import { useEffect, useId, useRef, useState } from 'react';
import { Button, Modal, Toggle } from '../components/ui';
import { useEqualizerState, useMusic } from './context';
import { EQ_BANDS, EQ_PRESETS, EQ_RANGE } from './equalizer';

const label = (hz: number) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));
const signed = (db: number) => (db > 0 ? `+${db}` : db < 0 ? `−${Math.abs(db)}` : '0');

/** Vertical position of a gain, in % of the graph (a little room above and below). */
const yOf = (db: number) => 50 - (db / EQ_RANGE) * 42;
const xOf = (i: number) => ((i + 0.5) / EQ_BANDS.length) * 100;

/** A smooth line through the bands (Catmull-Rom as Béziers), flat out to both edges; 0–1000 units. */
function curvePath(gains: number[]): string {
  const pts = gains.map((g, i) => [xOf(i) * 10, yOf(g) * 10] as const);
  let d = `M0 ${pts[0]![1]} L${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
  }
  return `${d} L1000 ${pts[pts.length - 1]![1]}`;
}

function EqGraph({ gains, enabled, onBand }: { gains: number[]; enabled: boolean; onBand: (i: number, db: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const gradient = useId();
  const n = EQ_BANDS.length;

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const band = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
    const pct = ((e.clientY - r.top) / r.height) * 100;
    return { band, db: ((50 - pct) / 42) * EQ_RANGE };
  };

  const line = curvePath(gains);
  const shown = drag ?? focus;
  return (
    <div className="flex gap-2">
      {/* dB scale */}
      <div className="relative h-52 w-11 shrink-0 text-right text-[11px] text-white/50 tabular-nums sm:h-60">
        {[EQ_RANGE, 0, -EQ_RANGE].map((db) => (
          <span key={db} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${yOf(db)}%` }}>
            {signed(db)} dB
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div
          ref={ref}
          className={`relative h-52 touch-none rounded-lg bg-black/30 ring-1 ring-white/10 transition-opacity select-none sm:h-60 ${enabled ? '' : 'opacity-50'}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const { band, db } = at(e);
            setDrag(band);
            onBand(band, db);
          }}
          onPointerMove={(e) => drag !== null && onBand(drag, at(e).db)}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        >
          {/* Grid: ±12, ±6 and the 0 dB line; one faint column per band. */}
          {[EQ_RANGE, EQ_RANGE / 2, 0, -EQ_RANGE / 2, -EQ_RANGE].map((db) => (
            <span key={db} aria-hidden="true" className={`absolute inset-x-0 h-px ${db === 0 ? 'bg-white/25' : 'bg-white/[0.07]'}`} style={{ top: `${yOf(db)}%` }} />
          ))}
          {EQ_BANDS.map((hz, i) => (
            <span key={hz} aria-hidden="true" className="absolute inset-y-[8%] w-px -translate-x-1/2 bg-white/[0.07]" style={{ left: `${xOf(i)}%` }} />
          ))}
          <svg aria-hidden="true" viewBox="0 0 1000 1000" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible">
            <defs>
              <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#ff0033" stopOpacity="0.45" />
                <stop offset="0.5" stopColor="#ff0033" stopOpacity="0.08" />
                <stop offset="1" stopColor="#ff0033" stopOpacity="0.45" />
              </linearGradient>
            </defs>
            <path d={`${line} L1000 500 L0 500 Z`} fill={`url(#${gradient})`} />
            <path d={line} fill="none" stroke="#fff" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          {gains.map((g, i) => {
            const hz = EQ_BANDS[i]!;
            const active = shown === i;
            return (
              <button
                key={hz}
                type="button"
                role="slider"
                aria-label={`${label(hz)}Hz`}
                aria-orientation="vertical"
                aria-valuemin={-EQ_RANGE}
                aria-valuemax={EQ_RANGE}
                aria-valuenow={g}
                aria-valuetext={`${signed(g)} dB`}
                onFocus={() => setFocus(i)}
                onBlur={() => setFocus((f) => (f === i ? null : f))}
                onKeyDown={(e) => {
                  const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
                  if (step !== undefined) onBand(i, g + step);
                  else if (e.key === 'Home' || e.key === '0') onBand(i, 0);
                  else return;
                  e.preventDefault();
                }}
                className={`absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgb(0_0_0/0.35)] outline-none transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-[#ff0033] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${active ? 'scale-125' : ''}`}
                style={{ left: `${xOf(i)}%`, top: `${yOf(g)}%` }}
              >
                {active && (
                  <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-black tabular-nums">
                    {signed(g)} dB
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex text-[11px] text-white/60 tabular-nums">
          {EQ_BANDS.map((hz) => (
            <span key={hz} className="flex-1 text-center">
              {label(hz)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Presets, ten bands and a preamp, saved for this profile on this device. */
export default function EqualizerDialog({ onClose }: { onClose: () => void }) {
  const { player } = useMusic();
  const eq = player.equalizer;
  const s = useEqualizerState();
  const presets = useRef<HTMLDivElement>(null);
  // The chosen preset may be scrolled out of sight at the end of the row.
  useEffect(() => {
    presets.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  return (
    <Modal onClose={onClose} label="Equalizer" className="max-w-2xl !rounded-xl !bg-[#212121]" closeButton={false}>
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">Equalizer</h2>
            <p className="text-sm text-white/60">Shapes how music sounds on this device.</p>
          </div>
          <Toggle checked={s.enabled} onChange={(on) => eq.setEnabled(on)} label="Equalizer on" disabled={!eq.supported} />
        </div>

        {!eq.supported ? (
          <p className="mt-6 rounded-lg bg-white/5 px-4 py-3 text-sm text-white/70">This browser can’t change how audio sounds.</p>
        ) : (
          <>
            <div
              ref={presets}
              role="radiogroup"
              aria-label="Presets"
              className="no-scrollbar -mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%-56px),transparent)] sm:-mx-6 sm:px-6"
            >
              {[...(s.preset === 'custom' ? [{ id: 'custom', label: 'Custom' }] : []), ...EQ_PRESETS].map((p) => {
                const on = s.enabled && s.preset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => (p.id === 'custom' ? eq.setEnabled(true) : eq.setPreset(p.id))}
                    className={`h-8 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
                      on ? 'bg-white text-black' : 'border border-white/10 bg-white/[0.1] text-white hover:bg-white/[0.2]'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <EqGraph gains={s.gains} enabled={s.enabled} onBand={(i, db) => eq.setBand(i, db)} />
            </div>

            <label className="mt-6 flex items-center gap-4">
              <span className="w-16 shrink-0 text-sm font-medium">Preamp</span>
              <input
                type="range"
                min={-EQ_RANGE}
                max={EQ_RANGE}
                step={0.5}
                value={s.preamp}
                onChange={(e) => eq.setPreamp(Number(e.target.value))}
                className="range-slim min-w-0 flex-1"
                style={{
                  background: `linear-gradient(to right, rgb(255 255 255 / 0.3) ${Math.min(50, ((s.preamp + EQ_RANGE) / (2 * EQ_RANGE)) * 100)}%, #fff ${Math.min(50, ((s.preamp + EQ_RANGE) / (2 * EQ_RANGE)) * 100)}%, #fff ${Math.max(50, ((s.preamp + EQ_RANGE) / (2 * EQ_RANGE)) * 100)}%, rgb(255 255 255 / 0.3) ${Math.max(50, ((s.preamp + EQ_RANGE) / (2 * EQ_RANGE)) * 100)}%)`,
                }}
              />
              <span className="w-14 shrink-0 text-right text-sm text-white/70 tabular-nums">{signed(s.preamp)} dB</span>
            </label>
            <p className="mt-2 text-xs text-white/50">Lower the preamp if boosted songs sound harsh or distorted.</p>
          </>
        )}

        <div className="mt-6 flex justify-between gap-2">
          <Button variant="ghost" className="!rounded-full" onClick={() => eq.reset()} disabled={!eq.supported || (s.preset === 'flat' && s.preamp === 0)}>
            Reset
          </Button>
          <Button variant="primary" className="!rounded-full" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
