import { useEffect, useState } from 'react';
import { ArrowLeftIcon, FilmIcon, FolderIcon, PencilIcon, RefreshIcon, TrashIcon, TvIcon, XIcon } from '../../components/Icons';
import { Badge, Button, ConfirmDialog, ErrorNote, Field, inputClass, Modal, Spinner, Toggle, useToast } from '../../components/ui';
import { api, errorText, qs } from '../../lib/api';
import { useServerEvents } from '../../lib/events';
import { formatBytes, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { useRouter } from '../../lib/router';
import type { FolderListing, Library, LibraryType, PluginSummary, ScanProgress, ScanStatus } from '../../lib/types';

/** A file ffprobe could not read; the catalog hides it until it changes on disk. */
interface UnplayableFile {
  id: number;
  libraryId: number;
  path: string;
  sizeBytes: number;
  error: string | null;
  title: string | null;
}

const TYPE_LABEL: Record<LibraryType, string> = { movies: 'Movies', shows: 'TV Shows', anime: 'Anime' };
const PHASE_LABEL: Record<ScanProgress['phase'], string> = {
  discovering: 'Looking for files',
  probing: 'Reading media info',
  saving: 'Updating library',
  cleanup: 'Cleaning up',
  metadata: 'Fetching metadata',
  subtitles: 'Finding subtitles',
};
const METADATA_LANGUAGES = ['en-US', 'en-GB', 'en-IN', 'hi-IN', 'te-IN', 'ta-IN', 'ml-IN', 'kn-IN', 'bn-IN', 'mr-IN', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN'];

export function LibrariesPage() {
  const { query, setQuery } = useRouter();
  const toast = useToast();
  const libs = useAsync((signal) => api.get<{ libraries: Library[] }>('/api/libraries', { signal }), []);
  const scans = useAsync((signal) => api.get<{ scans: ScanStatus[] }>('/api/scans', { signal }), []);
  const unplayable = useAsync((signal) => api.get<{ files: UnplayableFile[] }>('/api/libraries/unplayable', { signal }), []);
  const [editing, setEditing] = useState<Library | 'new' | null>(query.get('setup') ? 'new' : null);
  const [deleting, setDeleting] = useState<Library | null>(null);

  useServerEvents(['scan.progress', 'scan.completed', 'library.changed'], (type, data) => {
    if (type === 'scan.progress') {
      const { libraryId, ...progress } = data as unknown as ScanProgress & { libraryId: number };
      scans.setData((d) => ({
        scans: (d?.scans ?? []).map((s) => (s.libraryId === libraryId ? { ...s, state: 'running', progress } : s)),
      }));
    } else {
      scans.reload();
      libs.reload();
      unplayable.reload();
    }
  });

  const statusOf = (id: number) => scans.data?.scans.find((s) => s.libraryId === id);
  const scan = async (lib: Library, refreshMetadata = false) => {
    try {
      await api.post(`/api/libraries/${lib.id}/scan`, { refreshMetadata });
      toast(refreshMetadata ? `Refreshing metadata for ${lib.name}` : `Scanning ${lib.name}`);
      scans.reload();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Libraries</h1>
          <p className="text-sm text-neutral-400">Folders Streamora scans for movies and shows. Changes are picked up automatically when watching is on.</p>
        </div>
        <Button variant="brand" onClick={() => setEditing('new')}>
          Add library
        </Button>
      </div>
      {libs.loading && !libs.data && <Spinner />}
      {libs.error ? <ErrorNote error={libs.error} onRetry={libs.reload} /> : null}
      {libs.data?.libraries.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-700 p-10 text-center text-neutral-400">
          No libraries yet. Add one pointing at the folder with your movies or shows.
        </div>
      )}
      <ul className="space-y-4">
        {libs.data?.libraries.map((lib) => {
          const status = statusOf(lib.id);
          const running = status?.state === 'running';
          const progress = status?.progress;
          const last = status?.last;
          return (
            <li key={lib.id} className="rounded-lg bg-neutral-900 p-5 ring-1 ring-white/10">
              <div className="flex flex-wrap items-start gap-4">
                <div className="grid size-12 place-items-center rounded-md bg-neutral-800 text-neutral-300">
                  {lib.type === 'movies' ? <FilmIcon size={24} /> : <TvIcon size={24} />}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{lib.name}</h2>
                    <Badge tone="solid">{TYPE_LABEL[lib.type]}</Badge>
                    <Badge>{lib.language}</Badge>
                    {status?.watching ? <Badge tone="green">Watching</Badge> : <Badge>Not watching</Badge>}
                  </div>
                  {lib.paths.map((p) => (
                    <p key={p} className="truncate font-mono text-xs text-neutral-400">
                      {p}
                    </p>
                  ))}
                  <p className="text-sm text-neutral-400">
                    {lib.type === 'movies' ? `${lib.counts.movies} movies` : `${lib.counts.shows} shows`} · scanned {timeAgo(lib.lastScannedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {running ? (
                    <Button size="sm" variant="ghost" onClick={() => void api.del(`/api/libraries/${lib.id}/scan`).then(scans.reload)}>
                      <XIcon size={14} /> Cancel
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => void scan(lib)}>
                        <RefreshIcon size={14} /> Scan
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void scan(lib, true)} title="Re-run metadata agents for every title">
                        Refresh metadata
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(lib)} aria-label={`Edit ${lib.name}`}>
                    <PencilIcon size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(lib)} aria-label={`Delete ${lib.name}`}>
                    <TrashIcon size={14} />
                  </Button>
                </div>
              </div>

              {running && (
                <div className="mt-4 space-y-1.5">
                  <div className="flex justify-between text-xs text-neutral-300">
                    <span>
                      {progress ? PHASE_LABEL[progress.phase] : 'Starting'}
                      {status?.kind === 'partial' && ' (changes)'}
                    </span>
                    {progress && progress.total > 0 && (
                      <span className="tabular-nums">
                        {progress.processed} / {progress.total}
                      </span>
                    )}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className={`h-full bg-brand transition-all ${!progress?.total ? 'w-1/3 animate-pulse' : ''}`}
                      style={progress?.total ? { width: `${(progress.processed / progress.total) * 100}%` } : undefined}
                    />
                  </div>
                  {progress?.current && <p className="truncate text-xs text-neutral-500">{progress.current}</p>}
                </div>
              )}
              {!running && status?.state === 'queued' && <p className="mt-3 text-sm text-neutral-400">Scan queued…</p>}
              {!running && last && <LastScan last={last} />}
              <UnplayableList files={unplayable.data?.files.filter((f) => f.libraryId === lib.id) ?? []} />
            </li>
          );
        })}
      </ul>
      {editing && (
        <LibraryDialog
          library={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
            if (query.get('setup')) setQuery({ setup: null }, { replace: true });
          }}
          onSaved={() => {
            libs.reload();
            scans.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="The library and its watch history are removed from Streamora. Your files are not touched."
          confirmLabel="Delete library"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/api/libraries/${deleting.id}`);
            libs.reload();
          }}
        />
      )}
    </div>
  );
}

/** Files that are on disk but can't be played, so they're missing from the catalog. */
function UnplayableList({ files }: { files: UnplayableFile[] }) {
  if (files.length === 0) return null;
  return (
    <details className="group/bad mt-4 rounded-md bg-amber-500/5 ring-1 ring-amber-500/20">
      <summary className="flex items-center gap-2 px-3 py-2 text-sm text-amber-300 select-none">
        <span className="transition-transform group-open/bad:rotate-90">›</span>
        {files.length === 1 ? '1 file can’t be played and is hidden' : `${files.length} files can’t be played and are hidden`}
      </summary>
      <ul className="space-y-2.5 px-3 pb-2 text-xs">
        {files.map((f) => (
          <li key={f.id}>
            <p className="truncate font-mono text-neutral-300" title={f.path}>
              {f.path.split(/[\\/]/).pop()}
            </p>
            <p className="text-neutral-500">
              {f.title && `${f.title} · `}
              {formatBytes(f.sizeBytes)}
              {f.error && ` · ${f.error}`}
            </p>
          </li>
        ))}
      </ul>
      <p className="px-3 pb-3 text-xs text-neutral-500">
        Usually a damaged file, or a download that hasn’t finished (the file exists but holds no video yet). Streamora reads it again as soon as the file changes on disk.
      </p>
    </details>
  );
}

function LastScan({ last }: { last: NonNullable<ScanStatus['last']> }) {
  const [open, setOpen] = useState(false);
  const problems = (last.unidentified?.length ?? 0) + (last.errors?.length ?? 0);
  return (
    <div className="mt-3 text-sm text-neutral-400">
      {last.cancelled ? (
        <span>Last scan was cancelled.</span>
      ) : last.error ? (
        <span className="text-red-300">Last scan failed: {last.error}</span>
      ) : (
        <span>
          Last {last.kind === 'partial' ? 'update' : 'scan'} {timeAgo(last.finishedAt)}: {last.added ?? 0} added, {last.updated ?? 0} updated, {last.removed ?? 0}{' '}
          removed
          {last.files?.missing ? `, ${last.files.missing} files missing` : ''}.
        </span>
      )}
      {problems > 0 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="ml-2 text-amber-300 hover:underline">
          {problems} issue{problems === 1 ? '' : 's'}
        </button>
      )}
      {open && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded bg-black/40 p-3 font-mono text-xs">
          {last.unidentified?.map((u) => (
            <li key={u} className="text-amber-200">
              Could not identify: {u}
            </li>
          ))}
          {last.errors?.map((e) => (
            <li key={e} className="text-red-300">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryDialog({ library, onClose, onSaved }: { library: Library | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(library?.name ?? '');
  const [type, setType] = useState<LibraryType>(library?.type ?? 'movies');
  const [paths, setPaths] = useState<string[]>(library?.paths ?? []);
  const [language, setLanguage] = useState(library?.language ?? 'en-US');
  const [watch, setWatch] = useState(library?.watch ?? true);
  const [agents, setAgents] = useState<string[] | null>(library?.agents ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugins = useAsync((signal) => api.get<{ plugins: PluginSummary[] }>('/api/admin/plugins', { signal }), []);
  const metadataPlugins = plugins.data?.plugins.filter((p) => p.capabilities.includes('metadata')) ?? [];

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), paths, language, watch, agents };
    try {
      if (library) await api.patch(`/api/libraries/${library.id}`, body);
      else await api.post('/api/libraries', { ...body, type });
      toast(library ? 'Library updated' : 'Library added — scanning now');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={library ? 'Edit library' : 'Add library'} className="max-w-2xl">
      <form
        className="space-y-5 p-6 sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="text-2xl font-bold">{library ? `Edit ${library.name}` : 'Add library'}</h2>
        {!library && (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-neutral-200">Type</legend>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(TYPE_LABEL) as LibraryType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setType(t);
                    if (!name || Object.values(TYPE_LABEL).includes(name)) setName(TYPE_LABEL[t]);
                  }}
                  className={`flex items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold ring-1 ${type === t ? 'bg-white text-black ring-white' : 'bg-neutral-800 ring-white/10 hover:bg-neutral-700'}`}
                >
                  {t === 'movies' ? <FilmIcon size={18} /> : <TvIcon size={18} />}
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPE_LABEL[type]} required maxLength={80} />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-200">Folders</legend>
          {paths.length === 0 && <p className="text-sm text-neutral-500">No folders yet.</p>}
          <ul className="space-y-1.5">
            {paths.map((p) => (
              <li key={p} className="flex items-center gap-2 rounded-md bg-neutral-800 px-3 py-2">
                <FolderIcon size={16} className="shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{p}</span>
                <button type="button" aria-label={`Remove ${p}`} onClick={() => setPaths(paths.filter((x) => x !== p))} className="text-neutral-400 hover:text-white">
                  <XIcon size={16} />
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" onClick={() => setPicking(true)}>
            <FolderIcon size={14} /> Add folder
          </Button>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Metadata language" hint="Titles, synopses and artwork are fetched in this language when available.">
            <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {[...new Set([language, ...METADATA_LANGUAGES])].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-start justify-between gap-3 rounded-md bg-neutral-800/60 p-3">
            <span>
              <span className="block text-sm font-medium">Watch for changes</span>
              <span className="block text-xs text-neutral-400">New, renamed and deleted files show up within seconds.</span>
            </span>
            <Toggle checked={watch} onChange={setWatch} label="Watch for changes" />
          </label>
        </div>

        {metadataPlugins.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-neutral-200">Metadata agents</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={agents === null} onChange={(e) => setAgents(e.target.checked ? null : metadataPlugins.map((p) => p.id))} />
              Use every enabled agent (in priority order)
            </label>
            {agents !== null && (
              <ul className="space-y-1 pl-6">
                {metadataPlugins.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={agents.includes(p.id)}
                        onChange={(e) => setAgents(e.target.checked ? [...agents, p.id] : agents.filter((a) => a !== p.id))}
                      />
                      {p.name} {p.status !== 'active' && <Badge tone="amber">{p.status.replace('_', ' ')}</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}

        {error && <ErrorNote error={new Error(error)} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="brand" busy={busy} disabled={!name.trim() || paths.length === 0}>
            {library ? 'Save' : 'Add library'}
          </Button>
        </div>
      </form>
      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(p) => {
            if (!paths.includes(p)) setPaths([...paths, p]);
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

/** Browse the server's folders (`GET /api/admin/fs`) or type a path. */
export function FolderPicker({ onClose, onPick, initial }: { onClose: () => void; onPick: (path: string) => void; initial?: string }) {
  const [current, setCurrent] = useState<string | null>(initial ?? null);
  const [typed, setTyped] = useState(initial ?? '');
  const listing = useAsync((signal) => api.get<FolderListing>(`/api/admin/fs${qs({ path: current })}`, { signal }), [current]);
  useEffect(() => setTyped(current ?? ''), [current]);
  const data = listing.data;

  const crumbs: Array<{ label: string; path: string }> = [];
  if (data?.path) {
    // `D:\Media\Movies` → `D:\`, `D:\Media`, `D:\Media\Movies` · `/mnt/media` → `/mnt`, `/mnt/media`
    const windows = data.separator === '\\';
    let acc = '';
    for (const part of data.path.split(/[\\/]/).filter(Boolean)) {
      acc = windows ? (acc ? `${acc.replace(/\\$/, '')}\\${part}` : `${part}\\`) : `${acc}/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }

  return (
    <Modal onClose={onClose} label="Choose a folder" className="max-w-xl">
      <div className="space-y-4 p-6">
        <h2 className="text-xl font-bold">Choose a folder</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) setCurrent(typed.trim());
          }}
        >
          <input className={`${inputClass} font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a path, e.g. D:\Media\Movies" aria-label="Folder path" />
          <Button type="submit">Go</Button>
        </form>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="text-neutral-300 hover:underline" onClick={() => setCurrent(null)}>
            {data?.separator === '\\' ? 'This PC' : 'Roots'}
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="flex items-center gap-1">
              <span className="text-neutral-600">/</span>
              <button type="button" className="text-neutral-300 hover:underline" onClick={() => setCurrent(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <div className="h-80 overflow-y-auto rounded-md bg-black/40 ring-1 ring-white/10">
          {listing.loading && (
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
          )}
          {listing.error ? (
            <div className="p-4">
              <ErrorNote error={listing.error} />
            </div>
          ) : null}
          {data && !listing.loading && (
            <ul>
              {data.parent !== null && data.path && (
                <li>
                  <button type="button" onClick={() => setCurrent(data.parent)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-neutral-400 hover:bg-white/5">
                    <ArrowLeftIcon size={16} /> Up
                  </button>
                </li>
              )}
              {data.entries.map((e) => (
                <li key={e.path}>
                  <button type="button" onClick={() => setCurrent(e.path)} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-white/5">
                    <FolderIcon size={16} className="shrink-0 text-amber-300/80" />
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
              {data.entries.length === 0 && <li className="px-4 py-6 text-center text-sm text-neutral-500">No sub-folders</li>}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-neutral-400">
            {data?.path ? (data.videoCount ? `${data.videoCount} video file${data.videoCount === 1 ? '' : 's'} directly in this folder` : 'Pick the folder that contains your titles.') : 'Choose a drive or folder.'}
          </p>
          <Button variant="brand" disabled={!data?.path} onClick={() => data?.path && onPick(data.path)}>
            Select this folder
          </Button>
        </div>
      </div>
    </Modal>
  );
}
