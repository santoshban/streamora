import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatRuntime } from '../lib/format';
import { useMediaQuery } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { setTrailersMuted, useAutoplayPreviews, useTrailer, useTrailersMuted } from '../lib/trailers';
import type { HomeData } from '../lib/types';
import { CheckIcon, InfoIcon, PlayIcon, PlusIcon } from './Icons';
import { usePreviewOpen } from './Preview';
import { useListToggle, useOpenTitle, watchUrl } from './titleActions';
import { TrailerButton, TrailerVideo } from './TrailerVideo';
import { Button } from './ui';

type HeroData = NonNullable<HomeData['hero']>;
type TrailerPhase = 'waiting' | 'loading' | 'playing' | 'ended' | 'failed';

/** The trailer starts this long after the artwork appears (Netflix lets the art breathe first). */
const TRAILER_DELAY = 1800;
/** Inner padding of the billboard box (≈40px on a 1900px-wide window, like Netflix). */
const PAD = 'clamp(1.25rem,2.1vw,2.75rem)';
/** Netflix's billboard box fills the window under the nav (a small margin below),
 *  but never gets taller than 16:9 on narrow, tall windows. */
const BOX_HEIGHT = 'h-[max(22rem,min(calc(100svh-var(--header-h)-1.25rem),calc((100vw-2*var(--gutter))*0.5625)))]';
const RECENT_DAYS = 14;

/** Staggered entrance for the billboard's text blocks. */
const enter = (step: number): CSSProperties => ({ animationDelay: `${120 + step * 90}ms` });

/** The home billboard as an inset box: a wide rounded card that plays the trailer on
 *  desktop, a poster card on phones. */
export function Hero({ hero }: { hero: HeroData }) {
  const wide = useMediaQuery('(min-width: 640px)');
  return wide ? <Billboard hero={hero} /> : <PosterHero hero={hero} />;
}

function HeroTitle({ hero, className, imgClassName }: { hero: HeroData; className?: string; imgClassName?: string }) {
  const [failed, setFailed] = useState(false);
  if (hero.logo && !failed) {
    return <img src={hero.logo} alt={hero.title} onError={() => setFailed(true)} className={`object-contain drop-shadow-[0_4px_24px_rgb(0_0_0/0.5)] ${imgClassName ?? ''}`} />;
  }
  return <h1 className={`font-black tracking-tight drop-shadow-[0_2px_12px_rgb(0_0_0/0.6)] ${className ?? ''}`}>{hero.title}</h1>;
}

/** "Movie • Action • 2026 • 2h 19m • 15+" */
function MetaLine({ hero }: { hero: HeroData }) {
  const parts = [
    hero.kind === 'show' ? 'Series' : 'Movie',
    hero.genres[0],
    hero.year ? String(hero.year) : null,
    hero.kind === 'movie' ? formatRuntime(hero.runtimeMinutes) : null,
    hero.contentRating,
  ].filter((p): p is string => !!p);
  return (
    <p className="flex flex-wrap items-center text-[clamp(0.9rem,0.9vw,1.1rem)] font-semibold text-white [text-shadow:0_1px_4px_rgb(0_0_0/0.6)]">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="flex items-center">
          {i > 0 && <span className="px-[0.55em] text-[0.75em] text-white/70">&bull;</span>}
          {p}
        </span>
      ))}
    </p>
  );
}

function Chip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-[0.55em] rounded-[6px] bg-[rgb(30_30_30/0.85)] px-[0.8em] py-[0.5em] text-[clamp(0.72rem,0.7vw,0.85rem)] font-bold whitespace-nowrap text-white backdrop-blur-sm">
      {icon}
      {children}
    </span>
  );
}

function Billboard({ hero }: { hero: HeroData }) {
  const { navigate, query } = useRouter();
  const openTitle = useOpenTitle();
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(!hero.backdrop);
  const target = hero.target;

  // ── trailer ──────────────────────────────────────────────────────────────
  const autoplay = useAutoplayPreviews();
  const trailer = useTrailer(hero.id, autoplay);
  const muted = useTrailersMuted();
  const [phase, setPhase] = useState<TrailerPhase>('waiting');
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const previewOpen = usePreviewOpen();
  const modalOpen = query.has('title');

  useEffect(() => {
    if (!trailer || !loaded || phase !== 'waiting') return;
    const timer = setTimeout(() => setPhase('loading'), TRAILER_DELAY);
    return () => clearTimeout(timer);
  }, [trailer, loaded, phase]);

  // Pause once the billboard is mostly scrolled away, or the tab is hidden.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView((entry?.intersectionRatio ?? 0) >= 0.35), { threshold: [0, 0.35, 0.6] });
    observer.observe(el);
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // One video at a time: a hover preview or the detail modal pauses the billboard.
  const active = inView && pageVisible && !previewOpen && !modalOpen;
  const videoMounted = !!trailer && (phase === 'loading' || phase === 'playing');
  const showVideo = phase === 'playing' && active;
  const recent = Date.parse(hero.addedAt) >= Date.now() - RECENT_DAYS * 86_400_000;
  const details = () => openTitle(hero.id, box.current);

  return (
    <section className="gutter-x pt-[calc(var(--header-h)+0.625rem)]">
      {/* The whole box opens the details, like the artwork elsewhere; buttons stop the click. */}
      <div
        ref={box}
        data-clickable
        onClick={details}
        className={`group/billboard relative isolate ${BOX_HEIGHT} overflow-hidden rounded-(--box-radius) bg-raised ring-1 ring-white/10 animate-[pop_0.6s_var(--ease-out-expo)_backwards]`}
      >
        {hero.backdrop && (
          <img
            src={hero.backdrop}
            alt=""
            onLoad={() => setLoaded(true)}
            className={`absolute inset-0 size-full object-cover object-[50%_25%] transition-opacity duration-1000 animate-ken-burns ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {videoMounted && (
          <TrailerVideo
            videoKey={trailer.key}
            muted={muted}
            playing={active}
            visible={showVideo}
            onStart={() => setPhase('playing')}
            onEnd={() => setPhase('ended')}
            onFail={() => setPhase('failed')}
            zoom={1.1}
          />
        )}
        {/* Netflix's billboard vignette: a darker lower-left corner for the title and buttons. */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(77deg,rgb(0_0_0/0.6)_0%,rgb(0_0_0/0.2)_36%,transparent_60%)]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/45 to-transparent" />

        {(videoMounted || phase === 'ended') && (
          <div className="absolute z-10" style={{ top: PAD, right: PAD }}>
            <TrailerButton
              size="sm"
              mode={phase === 'ended' ? 'replay' : muted ? 'muted' : 'unmuted'}
              onClick={() => (phase === 'ended' ? setPhase('loading') : setTrailersMuted(!muted))}
            />
          </div>
        )}

        <div className="absolute w-[min(34vw,40rem)] min-w-[18rem]" style={{ left: PAD, bottom: PAD }}>
          <div className="animate-fade-up" style={enter(0)}>
            <HeroTitle hero={hero} className="text-[clamp(2.5rem,5vw,6rem)] leading-[0.92]" imgClassName="max-h-[min(25vh,12vw)] max-w-[min(30vw,36rem)] object-left-bottom" />
          </div>
          <div className="pt-[clamp(0.9rem,1.75vw,2.1rem)] animate-fade-up" style={enter(1)}>
            <MetaLine hero={hero} />
          </div>
          <div
            className="flex flex-wrap gap-[clamp(0.5rem,0.65vw,0.8rem)] pt-[clamp(1.25rem,3vw,3.5rem)] animate-fade-up"
            style={enter(2)}
            onClick={(e) => e.stopPropagation()}
          >
            {target && (
              <Button variant="primary" size="hero" className="rounded-full! pr-[1.5em]! pl-[1.2em]!" onClick={() => navigate(watchUrl(target))}>
                <PlayIcon className="size-[1.3em]" />
                {target.resume ? 'Resume' : 'Play'}
                {target.episodeLabel && <span className="font-normal opacity-80">{target.episodeLabel}</span>}
              </Button>
            )}
            <Button
              variant="secondary"
              size="hero"
              className="rounded-full! px-[1.25em]! bg-[rgb(109_109_110/0.62)]! backdrop-blur-sm hover:bg-[rgb(109_109_110/0.42)]!"
              onClick={details}
            >
              More info
            </Button>
          </div>
        </div>

        {(recent || hero.resolution === '4K' || hero.hdr) && (
          <div className="absolute flex gap-2 animate-[fade-in_0.5s_ease-out_0.7s_backwards]" style={{ right: PAD, bottom: PAD }}>
            {recent && <Chip icon={<span className="size-[0.8em] rounded-[2px] bg-brand" />}>Recently added</Chip>}
            {hero.resolution === '4K' && <Chip>4K Ultra HD</Chip>}
            {hero.hdr && <Chip>{hero.hdr}</Chip>}
          </div>
        )}
      </div>
    </section>
  );
}

/** Phones: a centred poster card with Play / My List side by side, like Netflix's app. */
function PosterHero({ hero }: { hero: HeroData }) {
  const { navigate } = useRouter();
  const openTitle = useOpenTitle();
  const [inList, toggleList] = useListToggle(hero.inList, hero.id);
  const [touched, setTouched] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const image = hero.poster ?? hero.backdrop;
  const target = hero.target;

  return (
    <section className="px-[5vw] pt-[calc(var(--header-h)+0.75rem)]">
      {/* Tapping anywhere on the card opens the details; the title is the keyboard path. */}
      <div
        onClick={(e) => openTitle(hero.id, e.currentTarget)}
        className="relative mx-auto aspect-[3/4] max-h-[72svh] w-full max-w-[26rem] cursor-pointer overflow-hidden rounded-xl bg-raised shadow-[0_14px_44px_rgb(0_0_0/0.7)] ring-1 ring-white/15 animate-[pop_0.5s_var(--ease-out-expo)_backwards]"
      >
        {image && (
          <img
            src={image}
            alt=""
            onLoad={() => setLoaded(true)}
            className={`absolute inset-0 size-full object-cover ${hero.poster ? 'object-top' : ''} transition-opacity duration-700 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4 text-center">
          <button
            type="button"
            aria-label={`More info on ${hero.title}`}
            onClick={(e) => {
              e.stopPropagation();
              openTitle(hero.id, e.currentTarget.parentElement?.parentElement ?? null);
            }}
            // Key-art posters already carry the title, so it is only drawn over a backdrop.
            className={hero.poster ? 'sr-only focus-visible:not-sr-only focus-visible:text-lg focus-visible:font-bold' : 'w-full animate-fade-up'}
            style={enter(0)}
          >
            {hero.poster ? hero.title : <HeroTitle hero={hero} className="text-4xl leading-none" imgClassName="mx-auto max-h-24 max-w-[80%] object-bottom" />}
          </button>
          {hero.genres.length > 0 && (
            <p className="text-sm font-medium text-ink animate-fade-up" style={enter(1)}>
              {hero.genres.slice(0, 3).join(' • ')}
            </p>
          )}
          <div className="grid w-full grid-cols-2 gap-2.5 animate-fade-up" style={enter(2)}>
            {target ? (
              <Button
                variant="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(watchUrl(target));
                }}
              >
                <PlayIcon size={20} /> {target.resume ? 'Resume' : 'Play'}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  openTitle(hero.id);
                }}
              >
                <InfoIcon size={20} /> Info
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                setTouched(true);
                void toggleList();
              }}
            >
              {inList ? (
                <CheckIcon key="in" size={20} className={touched ? 'animate-icon-pop' : ''} />
              ) : (
                <PlusIcon key="out" size={20} className={touched ? 'animate-icon-pop' : ''} />
              )}
              My List
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Placeholder with the billboard's exact geometry while the home rows load. */
export function HeroSkeleton() {
  const wide = useMediaQuery('(min-width: 640px)');
  return wide ? (
    <section className="gutter-x pt-[calc(var(--header-h)+0.625rem)]" aria-hidden="true">
      <div className={`${BOX_HEIGHT} rounded-(--box-radius) animate-skeleton`} />
    </section>
  ) : (
    <section className="px-[5vw] pt-[calc(var(--header-h)+0.75rem)]" aria-hidden="true">
      <div className="mx-auto aspect-[3/4] max-h-[72svh] w-full max-w-[26rem] rounded-xl animate-skeleton" />
    </section>
  );
}
