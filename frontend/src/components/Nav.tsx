import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { useAsync, useDismiss, useMediaQuery, useScrollState } from '../lib/hooks';
import { HOVER_QUERY } from '../lib/motion';
import { inAndroidApp, postToApp } from '../lib/native';
import { Link, useRouter } from '../lib/router';
import type { Card } from '../lib/types';
import { useSession } from '../state/session';
import { Avatar, Logo } from './Brand';
import { ConnectDeviceDialog } from './ConnectDevice';
import { BellIcon, GearIcon, LogOutIcon, PencilIcon, PhoneIcon, SearchIcon, ServerIcon, UsersIcon, XIcon } from './Icons';
import { ProfileEditor } from './ProfileEditor';
import { useOpenTitle } from './titleActions';

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/shows', label: 'Shows' },
  { to: '/movies', label: 'Movies' },
  { to: '/my-list', label: 'My List' },
];

/** Netflix's header: transparent over a top gradient, solid #141414 once the page
 *  scrolls. Phones get a row of category chips that tucks away while scrolling down. */
export function Nav() {
  const { path, query, navigate } = useRouter();
  const { profile, updateProfile } = useSession();
  const { scrolled, down } = useScrollState(0);
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const chipsHidden = scrolled && down;

  if (!profile) return null;

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      {/* Solid, like Netflix's current header: the billboard is a box below it, not behind it. */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 -z-10 bg-[linear-gradient(180deg,#1b1b1b,#141414)] transition-shadow duration-500 ${scrolled ? 'shadow-[0_2px_12px_rgb(0_0_0/0.6)]' : ''}`}
      />
      <nav className="gutter-x flex h-(--nav-h) items-center">
        <Link to="/" aria-label="Streamora home" className="shrink-0 transition-opacity hover:opacity-90">
          <Logo className="text-[1.35rem] min-[950px]:text-[1.6rem]" />
        </Link>
        <NavLinks path={path} />

        <div className="ml-auto flex items-center gap-[clamp(1rem,1.7vw,2rem)]">
          <SearchBox
            initial={path === '/search' ? (query.get('q') ?? '') : ''}
            onSearch={(q) => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/', { replace: path === '/search' })}
          />
          <Notifications />
          <AccountMenu onEdit={() => setEditing(true)} onConnect={() => setConnecting(true)} />
        </div>
      </nav>

      {/* Phones/tablets: category chips. Collapsing the grid row shrinks the header too. */}
      <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-standard min-[950px]:hidden ${chipsHidden ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
        <div className="min-h-0 overflow-hidden">
          <ul className="gutter-x no-scrollbar flex h-(--chips-h) items-center gap-2 overflow-x-auto pb-2 text-sm">
            {path !== '/' && (
              <li className="animate-[pop_0.25s_var(--ease-out-expo)_backwards]">
                <Link to="/" aria-label="Back to Home" className="grid size-8 place-items-center rounded-full border border-white/40 transition-colors hover:bg-white/10">
                  <XIcon size={16} />
                </Link>
              </li>
            )}
            {LINKS.slice(1).map((l) => {
              const active = path === l.to;
              return (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-full border px-3.5 py-1.5 font-medium whitespace-nowrap transition-colors duration-300 ${
                      active ? 'border-white/80 bg-white/20 text-white' : 'border-white/40 text-ink hover:bg-white/10'
                    }`}
                  >
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {editing && <ProfileEditor profile={profile} asAdmin={false} onClose={() => setEditing(false)} onSaved={updateProfile} />}
      {connecting && <ConnectDeviceDialog onClose={() => setConnecting(false)} />}
    </header>
  );
}

const ACTIVE_PILL = 'bg-white/[0.16]';

/** Desktop links as pills; the active pill slides to the new page. */
function NavLinks({ path }: { path: string }) {
  const list = useRef<HTMLUListElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const item = list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement;
      setPill(item ? { left: item.offsetLeft, width: item.offsetWidth } : null);
    };
    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [path]);

  return (
    // Netflix's header: ~16px links in 40px-tall pills; the current page sits on a grey
    // pill in bold white, the others brighten onto a fainter pill on hover.
    <ul ref={list} className="relative ml-[clamp(1rem,1.3vw,1.6rem)] hidden items-center gap-1.5 text-[clamp(14px,0.85vw,16px)] min-[950px]:flex">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 rounded-full ${ACTIVE_PILL} transition-[left,width,opacity] duration-[450ms] ease-standard ${pill ? 'opacity-100' : 'opacity-0'}`}
        style={pill ?? undefined}
      />
      {LINKS.map((l) => {
        const active = path === l.to;
        return (
          <li key={l.to} className="relative">
            <Link
              to={l.to}
              aria-current={active ? 'page' : undefined}
              className={`relative block rounded-full px-[1em] py-[0.5em] leading-6 whitespace-nowrap transition-[background-color,color] duration-200 ${
                active ? `font-bold text-white ${pill ? '' : ACTIVE_PILL}` : 'font-medium text-[#e5e5e5] hover:bg-white/[0.09] hover:text-white'
              }`}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Opens on hover (mouse) after a beat, or on click; closes a moment after the pointer leaves. */
function useHoverMenu() {
  const hover = useMediaQuery(HOVER_QUERY);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useDismiss(open, () => setOpen(false));
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const bind = {
    ref,
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse' || !hover) return;
      clearTimeout(closeTimer.current);
      setOpen(true);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse' || !hover) return;
      closeTimer.current = setTimeout(() => setOpen(false), 300);
    },
  };
  return { open, setOpen, bind };
}

const NEW_DAYS = 30;

function arrivedAgo(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
}

/** Netflix's bell: recent arrivals, with an unread count until the menu is opened. */
function Notifications() {
  const { profile } = useSession();
  const openTitle = useOpenTitle();
  const { open, setOpen, bind } = useHoverMenu();
  const items = useAsync((signal) => api.get<{ items: Card[] }>('/api/catalog/browse?sort=added&limit=10', { signal }), []);
  useServerEvents(['scan.completed'], () => items.reload());
  const seenKey = `streamora.notificationsSeen.${profile?.id ?? 0}`;
  const [seenAt, setSeenAt] = useState(() => Number(localStorage.getItem(seenKey) ?? 0));

  const cutoff = Date.now() - NEW_DAYS * 86_400_000;
  const arrivals = (items.data?.items ?? []).filter((c) => Date.parse(c.addedAt) >= cutoff);
  const unread = arrivals.filter((c) => Date.parse(c.addedAt) > seenAt).length;

  // Opening the menu marks everything in it as seen.
  useEffect(() => {
    if (!open || unread === 0) return;
    const timer = setTimeout(() => {
      const now = Date.now();
      localStorage.setItem(seenKey, String(now));
      setSeenAt(now);
    }, 800);
    return () => clearTimeout(timer);
  }, [open, unread, seenKey]);

  return (
    <div {...bind} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'} aria-expanded={open} className="relative grid size-8 place-items-center transition-transform duration-200 hover:scale-110">
        <BellIcon size={24} className={unread ? 'origin-top animate-[bell-ring_1.2s_ease-in-out_0.8s_backwards]' : ''} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-1 text-[11px] leading-none font-bold text-white shadow animate-[pop_0.3s_var(--ease-out-expo)_backwards]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-[calc(100%+12px)] right-0 w-[min(24rem,90vw)] border border-white/15 border-t-2 border-t-ink bg-black/95 text-[13px] shadow-2xl animate-menu">
          <span aria-hidden="true" className="absolute -top-[10px] right-[9px] size-0 border-x-[8px] border-b-[8px] border-x-transparent border-b-ink" />
          {arrivals.length === 0 ? (
            <p className="px-4 py-6 text-center text-muted">No new arrivals.</p>
          ) : (
            <ul className="no-scrollbar max-h-[60vh] overflow-y-auto">
              {arrivals.map((c) => (
                <li key={c.id} className="border-b border-white/10 last:border-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      setOpen(false);
                      openTitle(c.id, e.currentTarget.querySelector('img') ?? e.currentTarget);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-white/[0.06]"
                  >
                    <span className="aspect-video w-28 shrink-0 overflow-hidden rounded-[3px] bg-raised">
                      {(c.thumb ?? c.backdrop) && <img src={(c.thumb ?? c.backdrop)!} alt="" loading="lazy" className="size-full object-cover" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-ink">New Arrival</span>
                      <span className="block truncate text-[14px] font-semibold text-white">{c.title}</span>
                      <span className="block text-[12px] text-muted">{arrivedAgo(c.addedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Avatar + caret; opens on hover (mouse) or click, with Netflix's arrowed dark menu. */
function AccountMenu({ onEdit, onConnect }: { onEdit: () => void; onConnect: () => void }) {
  const { navigate } = useRouter();
  const { profile, switchProfile, signOut } = useSession();
  const hover = useMediaQuery(HOVER_QUERY);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ref = useDismiss(open, () => setOpen(false));
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!profile) return null;

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div
      ref={ref}
      className="relative"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse' || !hover) return;
        clearTimeout(closeTimer.current);
        setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse' || !hover) return;
        closeTimer.current = setTimeout(() => setOpen(false), 300);
      }}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2.5 py-2" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open}>
        <Avatar profile={profile} size={32} className="rounded-[4px]" />
        <span
          aria-hidden="true"
          className={`hidden size-0 border-x-[5px] border-t-[5px] border-x-transparent border-t-white transition-transform duration-[367ms] ease-caret sm:block ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div role="menu" className="absolute top-[calc(100%+10px)] right-0 w-60 border border-white/15 bg-black/95 text-[13px] shadow-2xl animate-menu">
          <span aria-hidden="true" className="absolute -top-[9px] right-[22px] size-0 border-x-[8px] border-b-[8px] border-x-transparent border-b-ink" />
          <div className="flex items-center gap-3 border-b border-white/10 px-3.5 py-3">
            <Avatar profile={profile} size={32} className="rounded-[4px]" />
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{profile.name}</p>
              <p className="text-xs text-muted">{profile.isKids ? 'Kids profile' : profile.isAdmin ? 'Owner' : 'Profile'}</p>
            </div>
          </div>
          <div className="py-2">
            <MenuItem icon={<PencilIcon size={18} />} onClick={run(onEdit)}>
              Edit profile
            </MenuItem>
            <MenuItem icon={<UsersIcon size={18} />} onClick={run(switchProfile)}>
              Switch profile
            </MenuItem>
            {profile.isAdmin && (
              <MenuItem icon={<GearIcon size={18} />} onClick={run(() => navigate('/admin/libraries'))}>
                Manage server
              </MenuItem>
            )}
            {inAndroidApp ? (
              <MenuItem icon={<ServerIcon size={18} />} onClick={run(() => postToApp({ type: 'changeServer' }))}>
                Change server
              </MenuItem>
            ) : (
              <MenuItem icon={<PhoneIcon size={18} />} onClick={run(onConnect)}>
                Connect a device
              </MenuItem>
            )}
          </div>
          <button type="button" role="menuitem" onClick={run(() => void signOut())} className="flex w-full items-center justify-center gap-2 border-t border-white/15 py-3.5 text-ink hover:underline">
            <LogOutIcon size={15} /> Sign out of Streamora
          </button>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="group/item flex w-full items-center gap-3 px-3.5 py-2 text-left text-ink">
      <span className="text-muted transition-colors group-hover/item:text-white">{icon}</span>
      <span className="group-hover/item:underline">{children}</span>
    </button>
  );
}

/** Icon that slides open into a bordered search field (Netflix's `searchBox`). */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [open, setOpen] = useState(initial !== '');
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setValue(initial);
    if (initial) setOpen(true);
  }, [initial]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (q: string) => {
    setValue(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(q.trim()), 300);
  };

  return (
    <div
      className={`flex h-[34px] items-center overflow-hidden border transition-[width,background-color,border-color] duration-300 ease-standard ${
        open ? 'w-[min(17rem,calc(100vw-11rem))] border-white bg-black/75' : 'w-7 border-transparent bg-transparent'
      }`}
    >
      <button
        type="button"
        aria-label="Search"
        className="grid h-full w-7 shrink-0 place-items-center pl-0.5"
        onClick={() => {
          setOpen(true);
          input.current?.focus();
        }}
      >
        <SearchIcon size={24} />
      </button>
      <input
        ref={input}
        value={value}
        tabIndex={open ? 0 : -1}
        onFocus={() => setOpen(true)}
        onChange={(e) => change(e.target.value)}
        onBlur={() => {
          if (!value) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            change('');
            setOpen(false);
            input.current?.blur();
          }
        }}
        placeholder="Titles, people, genres"
        className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm text-white outline-none placeholder:text-soft"
        aria-label="Search titles"
      />
      {value && (
        <button type="button" aria-label="Clear search" className="grid h-full w-8 shrink-0 place-items-center animate-fade-in" onClick={() => change('')}>
          <XIcon size={16} />
        </button>
      )}
    </div>
  );
}
