import { useState, type ReactNode } from 'react';
import { Avatar, Logo } from '../../components/Brand';
import { ActivityIcon, ArrowLeftIcon, LibraryIcon, PencilIcon, PluginIcon, TrashIcon, UsersIcon, XIcon } from '../../components/Icons';
import { ProfileEditor } from '../../components/ProfileEditor';
import { Badge, Button, ConfirmDialog, ErrorNote, Spinner, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useServerEvents } from '../../lib/events';
import { timeAgo } from '../../lib/format';
import { useAsync, useInterval } from '../../lib/hooks';
import { Link, useRouter } from '../../lib/router';
import type { Library, Profile, ScanStatus, TranscodeSession } from '../../lib/types';
import { useSession } from '../../state/session';
import { LibrariesPage } from './Libraries';
import { PluginsPage } from './Plugins';

const SECTIONS = [
  { path: '/admin/libraries', label: 'Libraries', icon: LibraryIcon, page: LibrariesPage },
  { path: '/admin/plugins', label: 'Plugins', icon: PluginIcon, page: PluginsPage },
  { path: '/admin/activity', label: 'Activity', icon: ActivityIcon, page: ActivityPage },
  { path: '/admin/profiles', label: 'Profiles', icon: UsersIcon, page: ProfilesPage },
];

export function AdminLayout() {
  const { path } = useRouter();
  const { profile } = useSession();
  if (!profile?.isAdmin) {
    return (
      <div className="mx-auto mt-40 max-w-md text-center text-neutral-300">
        <p>Only admin profiles can open the admin area.</p>
        <Link to="/" className="mt-4 inline-block text-brand hover:underline">
          Back to browsing
        </Link>
      </div>
    );
  }
  const section = SECTIONS.find((s) => path.startsWith(s.path)) ?? SECTIONS[0]!;
  const Page = section.page;

  return (
    <div className="min-h-screen bg-neutral-950">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-white/10 bg-neutral-950/95 px-4 backdrop-blur sm:px-8">
        <Link to="/" className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white">
          <ArrowLeftIcon size={18} /> <span className="hidden sm:inline">Back to browsing</span>
        </Link>
        <Logo className="text-xl" />
        <span className="text-sm font-semibold text-neutral-500">Admin</span>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8 md:flex-row md:py-10">
        <nav className="md:w-48 md:shrink-0" aria-label="Admin sections">
          <ul className="no-scrollbar flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((s) => (
              <li key={s.path}>
                <Link
                  to={s.path}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap transition ${
                    s === section ? 'bg-white/10 font-semibold text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <s.icon size={18} /> {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1">
          <Page />
        </main>
      </div>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActivityPage() {
  const toast = useToast();
  const transcodes = useAsync(
    (signal) => api.get<{ encoder: string | null; tonemap: boolean; limit: number; sessions: TranscodeSession[] }>('/api/admin/transcodes', { signal }),
    [],
  );
  const scans = useAsync((signal) => api.get<{ scans: ScanStatus[] }>('/api/scans', { signal }), []);
  const libs = useAsync((signal) => api.get<{ libraries: Library[] }>('/api/libraries', { signal }), []);
  useInterval(transcodes.reload, 5000);
  useServerEvents(['scan.progress', 'scan.completed'], () => scans.reload());
  const libName = (id: number) => libs.data?.libraries.find((l) => l.id === id)?.name ?? `Library ${id}`;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold">Activity</h1>
        <p className="text-sm text-neutral-400">What the server is doing right now.</p>
      </div>

      <Section title="Streaming">
        {transcodes.data && (
          <p className="text-sm text-neutral-400">
            Video encoder: <span className="font-mono text-neutral-200">{transcodes.data.encoder ?? 'ffmpeg not found'}</span>
            {transcodes.data.tonemap && ' · HDR tone mapping available'} · up to {transcodes.data.limit} transcodes at once
          </p>
        )}
        {transcodes.error ? <ErrorNote error={transcodes.error} /> : null}
        {transcodes.data?.sessions.length === 0 && <p className="rounded-md bg-neutral-900 p-4 text-sm text-neutral-500">Nobody is streaming a converted file.</p>}
        <ul className="space-y-2">
          {transcodes.data?.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-900 p-4 ring-1 ring-white/10">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{s.title ?? `File ${s.fileId}`}</p>
                <p className="text-xs text-neutral-400">
                  {s.mode === 'transcode' ? `Transcoding (${s.encoder})` : 'Remuxing (video copied)'} · segment {Math.max(0, s.position) + 1} of {s.segments} ·{' '}
                  {s.running ? 'encoding' : 'idle'} · last request {timeAgo(s.lastAccess)}
                </p>
              </div>
              <Badge tone={s.mode === 'transcode' ? 'amber' : 'green'}>{s.mode}</Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await api.del(`/api/admin/transcodes/${s.id}`).catch((err: unknown) => toast(errorText(err), 'error'));
                  transcodes.reload();
                }}
              >
                <XIcon size={14} /> Stop
              </Button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Library scans">
        {scans.loading && !scans.data && <Spinner />}
        <ul className="space-y-2">
          {scans.data?.scans.map((s) => (
            <li key={s.libraryId} className="flex flex-wrap items-center gap-3 rounded-md bg-neutral-900 p-4 ring-1 ring-white/10">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{libName(s.libraryId)}</p>
                <p className="text-xs text-neutral-400">
                  {s.state === 'running' && s.progress
                    ? `${s.progress.phase} · ${s.progress.processed}/${s.progress.total}`
                    : s.last
                      ? `Last ${s.last.kind} scan ${timeAgo(s.last.finishedAt)}${s.last.error ? ` — failed: ${s.last.error}` : ''}`
                      : 'Not scanned since the server started'}
                </p>
              </div>
              <Badge tone={s.state === 'running' ? 'amber' : s.state === 'queued' ? 'solid' : 'green'}>{s.state}</Badge>
              {s.watching && <Badge>watching</Badge>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ProfilesPage() {
  const { profile: me, updateProfile } = useSession();
  const profiles = useAsync((signal) => api.get<{ profiles: Profile[] }>('/api/profiles', { signal }), []);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [loadingEdit, setLoadingEdit] = useState<number | null>(null);
  const toast = useToast();

  // The public list has no preferences: load the full profile before editing.
  const edit = async (p: Profile) => {
    setLoadingEdit(p.id);
    try {
      setEditing((await api.get<{ profile: Profile }>(`/api/profiles/${p.id}`)).profile);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setLoadingEdit(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Profiles</h1>
          <p className="text-sm text-neutral-400">Everyone gets their own Continue Watching, My List and playback preferences.</p>
        </div>
        <Button variant="brand" onClick={() => setEditing('new')}>
          Add profile
        </Button>
      </div>
      {profiles.error ? <ErrorNote error={profiles.error} onRetry={profiles.reload} /> : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {profiles.data?.profiles.map((p) => (
          <li key={p.id} className="flex items-center gap-4 rounded-lg bg-neutral-900 p-4 ring-1 ring-white/10">
            <Avatar profile={p} size={56} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">
                {p.name} {p.id === me?.id && <span className="text-sm font-normal text-neutral-500">(you)</span>}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {p.isAdmin && <Badge tone="brand">Admin</Badge>}
                {p.isKids && <Badge tone="green">Kids</Badge>}
                {p.hasPin && <Badge>PIN</Badge>}
              </div>
            </div>
            <Button size="sm" variant="ghost" busy={loadingEdit === p.id} onClick={() => void edit(p)} aria-label={`Edit ${p.name}`}>
              <PencilIcon size={14} />
            </Button>
            {p.id !== me?.id && (
              <Button size="sm" variant="ghost" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}>
                <TrashIcon size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <ProfileEditor
          profile={editing === 'new' ? null : editing}
          asAdmin
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            profiles.reload();
            if (p.id === me?.id) updateProfile(p);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Their watch history, progress and My List are deleted too."
          confirmLabel="Delete profile"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/api/profiles/${deleting.id}`);
            profiles.reload();
          }}
        />
      )}
    </div>
  );
}
