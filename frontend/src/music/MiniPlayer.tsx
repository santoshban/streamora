import { useRouter } from '../lib/router';
import { useMusic, usePlayerState } from './context';
import { CloseIcon, NextIcon, PauseIcon, PlayIcon } from './icons';
import { Art, PlayingBars } from './ui';

/**
 * Music keeps playing while you browse movies and shows: this pill in the
 * corner shows what's on and opens the music player.
 */
export function MiniPlayer() {
  const { player } = useMusic();
  const state = usePlayerState();
  const { navigate } = useRouter();
  const item = state.queue[state.index];
  if (!item || !state.active) return null;
  const { track } = item;

  return (
    <div className="fixed right-4 bottom-4 z-40 flex max-w-[min(26rem,calc(100vw-2rem))] items-center gap-2 rounded-full bg-[#212121]/95 p-1.5 pr-2 shadow-[0_6px_30px_rgb(0_0_0/0.6)] ring-1 ring-white/10 backdrop-blur animate-fade-up">
      <button
        type="button"
        onClick={() => {
          navigate('/music');
          player.setExpanded(true);
        }}
        className="flex min-w-0 items-center gap-3 rounded-full pr-1 text-left"
        aria-label={`Open the music player: ${track.title}`}
      >
        <span className="relative">
          <Art src={track.art} seed={track.album.id} round className="size-10" />
          {state.playing && (
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/50">
              <PlayingBars />
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-white">{track.title}</span>
          <span className="block truncate text-xs text-white/60">{track.artistName}</span>
        </span>
      </button>
      <button type="button" aria-label={state.playing ? 'Pause' : 'Play'} onClick={() => player.toggle()} className="grid size-9 shrink-0 place-items-center rounded-full text-white hover:bg-white/10">
        {state.playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
      </button>
      <button type="button" aria-label="Next" onClick={() => player.next()} className="grid size-9 shrink-0 place-items-center rounded-full text-white hover:bg-white/10">
        <NextIcon size={22} />
      </button>
      {!state.playing && (
        <button type="button" aria-label="Hide" onClick={() => player.hide()} className="grid size-8 shrink-0 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white">
          <CloseIcon size={18} />
        </button>
      )}
    </div>
  );
}
