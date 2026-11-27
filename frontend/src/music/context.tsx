import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, inputClass, Modal, useToast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { inAndroidApp, MUSIC_COMMAND_EVENT, postToApp } from '../lib/native';
import type { EqSettings } from './equalizer';
import { MusicPlayer, type PlayerState, type PlayerTime } from './player';
import type { Playlist, Track } from './types';

const EqualizerDialog = lazy(() => import('./EqualizerDialog'));

interface MusicContextValue {
  player: MusicPlayer;
  playlists: Playlist[] | undefined;
  reloadPlaylists(): void;
  /** Like state after local changes (lists fetched earlier may be stale). */
  isLiked(track: Pick<Track, 'id' | 'liked'>): boolean;
  toggleLike(track: Track): Promise<void>;
  /** Opens "Save to playlist" for these tracks. */
  saveToPlaylist(tracks: Track[]): void;
  /** Opens "New playlist", optionally with tracks in it. */
  newPlaylist(tracks?: Track[]): void;
  /** Opens the equalizer. */
  openEqualizer(): void;
  likesVersion: number;
}

const MusicContext = createContext<MusicContextValue | null>(null);

/** Owns the profile's music player. Mounted for the whole signed-in session. */
export function MusicProvider({ profileId, children }: { profileId: number; children: ReactNode }) {
  const toast = useToast();
  const playerRef = useRef<MusicPlayer | null>(null);
  playerRef.current ??= new MusicPlayer(`streamora.music.${profileId}`);
  const player = playerRef.current;
  useEffect(() => {
    player.attach();
    return () => player.detach();
  }, [player]);
  useAndroidMusicBridge(player);

  const [playlists, setPlaylists] = useState<Playlist[]>();
  const [tick, setTick] = useState(0);
  const reloadPlaylists = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    api
      .get<{ playlists: Playlist[] }>('/api/music/playlists', { signal: controller.signal })
      .then((r) => setPlaylists(r.playlists))
      .catch(() => undefined);
    return () => controller.abort();
  }, [tick]);

  const likes = useRef(new Map<number, boolean>()).current;
  const [likesVersion, setLikesVersion] = useState(0);
  const isLiked = useCallback((t: Pick<Track, 'id' | 'liked'>) => likes.get(t.id) ?? t.liked, [likes]);

  const toggleLike = useCallback(
    async (track: Track) => {
      const liked = !(likes.get(track.id) ?? track.liked);
      likes.set(track.id, liked);
      setLikesVersion((v) => v + 1);
      player.patchTrack(track.id, { liked });
      try {
        await api.put(`/api/music/tracks/${track.id}/like`, { liked });
        toast(liked ? 'Added to Liked music' : 'Removed from Liked music');
      } catch (err) {
        likes.set(track.id, !liked);
        setLikesVersion((v) => v + 1);
        player.patchTrack(track.id, { liked: !liked });
        toast(errorText(err), 'error');
      }
    },
    [likes, player, toast],
  );

  const [dialog, setDialog] = useState<{ kind: 'save' | 'new'; tracks: Track[] } | null>(null);
  const [equalizer, setEqualizer] = useState(false);
  const value = useMemo<MusicContextValue>(
    () => ({
      player,
      playlists,
      reloadPlaylists,
      isLiked,
      toggleLike,
      saveToPlaylist: (tracks) => setDialog({ kind: 'save', tracks }),
      newPlaylist: (tracks = []) => setDialog({ kind: 'new', tracks }),
      openEqualizer: () => setEqualizer(true),
      likesVersion,
    }),
    [player, playlists, reloadPlaylists, isLiked, toggleLike, likesVersion],
  );

  return (
    <MusicContext.Provider value={value}>
      {children}
      {dialog?.kind === 'save' && (
        <SaveToPlaylistDialog tracks={dialog.tracks} onClose={() => setDialog(null)} onNew={() => setDialog({ kind: 'new', tracks: dialog.tracks })} />
      )}
      {dialog?.kind === 'new' && <PlaylistDialog tracks={dialog.tracks} onClose={() => setDialog(null)} />}
      {equalizer && (
        <Suspense fallback={null}>
          <EqualizerDialog onClose={() => setEqualizer(false)} />
        </Suspense>
      )}
    </MusicContext.Provider>
  );
}

export function useMusic(): MusicContextValue {
  const value = useContext(MusicContext);
  if (!value) throw new Error('useMusic outside MusicProvider');
  return value;
}

/** The music player, or null outside a signed-in session. */
export function useOptionalPlayer(): MusicPlayer | null {
  return useContext(MusicContext)?.player ?? null;
}

export function usePlayerState(): PlayerState {
  const { player } = useMusic();
  return useSyncExternalStore(player.subscribe, player.getState);
}

export function usePlayerTime(): PlayerTime {
  const { player } = useMusic();
  return useSyncExternalStore(player.subscribeTime, player.getTime);
}

export function useEqualizerState(): EqSettings {
  const { player } = useMusic();
  return useSyncExternalStore(player.equalizer.subscribe, player.equalizer.getState);
}

// ── Android app ──────────────────────────────────────────────────────────────

/**
 * In the Android app, tells the app what's playing (it shows a media
 * notification and keeps the page alive in the background) and takes its
 * play/pause/next/seek commands.
 */
function useAndroidMusicBridge(player: MusicPlayer) {
  useEffect(() => {
    if (!inAndroidApp) return;
    let lastKey = '';
    let sentPosition = 0;
    let sentAt = 0;
    let sentPlaying = false;

    const send = () => {
      const s = player.getState();
      const t = player.getTime();
      const item = s.queue[s.index];
      if (!item) {
        if (lastKey !== 'stopped') postToApp({ type: 'music', state: 'stopped' });
        lastKey = 'stopped';
        return;
      }
      const state = s.playing ? 'playing' : 'paused';
      const hasNext = s.index < s.queue.length - 1 || s.repeat === 'all' || s.autoplay;
      const key = `${state}|${item.key}|${s.buffering}|${hasNext}|${Math.round(t.duration)}|${item.track.title}`;
      // Seeks: the position moved away from where the app is extrapolating it.
      const expected = sentPosition + (sentPlaying ? (performance.now() - sentAt) / 1000 : 0);
      if (key === lastKey && Math.abs(t.current - expected) < 2) return;
      lastKey = key;
      sentPosition = t.current;
      sentAt = performance.now();
      sentPlaying = s.playing;
      const { track } = item;
      postToApp({
        type: 'music',
        state,
        track: {
          id: track.id,
          title: track.title,
          artist: track.artistName,
          album: track.album.title,
          art: track.art ? new URL(track.art, window.location.origin).href : null,
        },
        durationMs: Math.round((t.duration || track.duration || 0) * 1000),
        positionMs: Math.round(t.current * 1000),
        buffering: s.buffering,
        hasNext,
      });
    };

    const onCommand = (e: Event) => {
      const { action, positionMs } = (e as CustomEvent<{ action?: string; positionMs?: number }>).detail ?? {};
      if (action === 'play') player.play();
      else if (action === 'pause' || action === 'stop') player.pause();
      else if (action === 'next') player.next();
      else if (action === 'previous') player.previous();
      else if (action === 'seek' && typeof positionMs === 'number') player.seek(positionMs / 1000);
    };

    const unsubscribe = player.subscribe(send);
    const unsubscribeTime = player.subscribeTime(send);
    window.addEventListener(MUSIC_COMMAND_EVENT, onCommand);
    send();
    return () => {
      unsubscribe();
      unsubscribeTime();
      window.removeEventListener(MUSIC_COMMAND_EVENT, onCommand);
      // Signed out or switched profile: the notification goes away.
      postToApp({ type: 'music', state: 'stopped' });
    };
  }, [player]);
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function SaveToPlaylistDialog({ tracks, onClose, onNew }: { tracks: Track[]; onClose: () => void; onNew: () => void }) {
  const { playlists, reloadPlaylists } = useMusic();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const save = async (p: Playlist) => {
    setBusy(p.id);
    try {
      const res = await api.post<{ added: number; duplicates: number }>(`/api/music/playlists/${p.id}/tracks`, { trackIds: tracks.map((t) => t.id) });
      toast(res.duplicates ? `Saved to ${p.name} (${res.duplicates} already there)` : `Saved to ${p.name}`);
      reloadPlaylists();
      onClose();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(null);
    }
  };

  return (
    <Modal onClose={onClose} label="Save to playlist" className="max-w-md !rounded-xl !bg-[#212121]">
      <div className="p-6">
        <h2 className="mb-1 text-xl font-bold">Save to playlist</h2>
        <p className="mb-4 text-sm text-white/60">{tracks.length === 1 ? tracks[0]!.title : `${tracks.length} songs`}</p>
        <ul className="-mx-2 max-h-[50vh] overflow-y-auto">
          {(playlists ?? []).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void save(p)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded bg-white/10">
                  {p.arts[0] ? <img src={p.arts[0]} alt="" className="size-full object-cover" /> : <span className="text-white/40">♪</span>}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block text-sm text-white/60">{p.trackCount} songs</span>
                </span>
              </button>
            </li>
          ))}
          {playlists?.length === 0 && <li className="px-2 py-3 text-sm text-white/60">No playlists yet.</li>}
        </ul>
        <div className="mt-5 flex justify-between">
          <Button variant="ghost" className="!rounded-full" onClick={onNew}>
            + New playlist
          </Button>
          <Button variant="ghost" className="!rounded-full" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Create a playlist, or edit one when `playlist` is given. */
export function PlaylistDialog({
  tracks = [],
  playlist,
  onClose,
  onSaved,
}: {
  tracks?: Track[];
  playlist?: Playlist;
  onClose: () => void;
  onSaved?: (p: Playlist) => void;
}) {
  const { reloadPlaylists } = useMusic();
  const toast = useToast();
  const [name, setName] = useState(playlist?.name ?? '');
  const [description, setDescription] = useState(playlist?.description ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null };
      const res = playlist
        ? await api.patch<{ playlist: Playlist }>(`/api/music/playlists/${playlist.id}`, body)
        : await api.post<{ playlist: Playlist }>('/api/music/playlists', { ...body, trackIds: tracks.map((t) => t.id) });
      toast(playlist ? 'Playlist updated' : `Created ${res.playlist.name}`);
      reloadPlaylists();
      onSaved?.(res.playlist);
      onClose();
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={playlist ? 'Edit playlist' : 'New playlist'} className="max-w-md !rounded-xl !bg-[#212121]" closeButton={false}>
      <form
        className="space-y-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-xl font-bold">{playlist ? 'Edit playlist' : 'New playlist'}</h2>
        <label className="block">
          <span className="mb-1.5 block text-sm text-white/70">Title</span>
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={150} required />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-white/70">Description</span>
          <textarea className={`${inputClass} min-h-24 resize-y`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="!rounded-full" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" className="!rounded-full" busy={busy} disabled={!name.trim()}>
            {playlist ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
