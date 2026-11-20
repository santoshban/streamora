import { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../lib/hooks';
import { Link, useRouter } from '../lib/router';
import { useSession } from '../state/session';
import { Avatar, Logo } from './Brand';
import { ChevronDownIcon, GearIcon, LogOutIcon, PencilIcon, SearchIcon, UsersIcon, XIcon } from './Icons';
import { ProfileEditor } from './ProfileEditor';

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/shows', label: 'TV Shows' },
  { to: '/movies', label: 'Movies' },
  { to: '/my-list', label: 'My List' },
];

export function Nav() {
  const { path, query, navigate } = useRouter();
  const { profile, switchProfile, signOut, updateProfile } = useSession();
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [browseMenu, setBrowseMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const menuRef = useDismiss(menu, () => setMenu(false));
  const browseRef = useDismiss(browseMenu, () => setBrowseMenu(false));

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!profile) return null;
  const current = LINKS.find((l) => l.to === path)?.label ?? 'Browse';

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled ? 'bg-surface/95 shadow-lg backdrop-blur' : 'bg-gradient-to-b from-black/80 to-transparent'
      }`}
    >
      <nav className="flex h-16 items-center gap-4 px-4 sm:px-12 lg:gap-8">
        <Link to="/" aria-label="Streamora home">
          <Logo className="text-xl sm:text-2xl" />
        </Link>
        <ul className="hidden items-center gap-5 text-sm md:flex">
          {LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to} className={`transition hover:text-neutral-300 ${path === l.to ? 'font-semibold text-white' : 'text-neutral-300'}`}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div ref={browseRef} className="relative md:hidden">
          <button type="button" onClick={() => setBrowseMenu((v) => !v)} className="flex items-center gap-1 text-sm font-semibold">
            {current} <ChevronDownIcon size={16} />
          </button>
          {browseMenu && (
            <ul className="absolute top-8 left-0 w-44 rounded-md bg-black/95 py-2 text-sm ring-1 ring-white/10">
              {LINKS.map((l) => (
                <li key={l.to}>
                  <Link to={l.to} onClick={() => setBrowseMenu(false)} className="block px-4 py-2 hover:bg-white/10">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3 sm:gap-5">
          <SearchBox
            initial={path === '/search' ? (query.get('q') ?? '') : ''}
            onSearch={(q) => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/', { replace: path === '/search' })}
          />
          <div ref={menuRef} className="relative">
            <button type="button" onClick={() => setMenu((v) => !v)} className="flex items-center gap-1.5" aria-label="Account menu" aria-expanded={menu}>
              <Avatar profile={profile} size={32} />
              <ChevronDownIcon size={14} className={`hidden transition sm:block ${menu ? 'rotate-180' : ''}`} />
            </button>
            {menu && (
              <div className="absolute top-11 right-0 w-56 rounded-md bg-black/95 py-2 text-sm shadow-2xl ring-1 ring-white/10">
                <p className="truncate px-4 pt-1 pb-2 text-xs text-neutral-400">Signed in as {profile.name}</p>
                <MenuButton icon={<PencilIcon size={16} />} onClick={() => { setMenu(false); setEditing(true); }}>
                  Edit profile
                </MenuButton>
                <MenuButton icon={<UsersIcon size={16} />} onClick={() => { setMenu(false); switchProfile(); }}>
                  Switch profile
                </MenuButton>
                {profile.isAdmin && (
                  <MenuButton icon={<GearIcon size={16} />} onClick={() => { setMenu(false); navigate('/admin/libraries'); }}>
                    Admin
                  </MenuButton>
                )}
                <div className="my-2 border-t border-white/10" />
                <MenuButton icon={<LogOutIcon size={16} />} onClick={() => { setMenu(false); void signOut(); }}>
                  Sign out
                </MenuButton>
              </div>
            )}
          </div>
        </div>
      </nav>
      {editing && <ProfileEditor profile={profile} asAdmin={false} onClose={() => setEditing(false)} onSaved={updateProfile} />}
    </header>
  );
}

function MenuButton({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-4 py-2 text-left text-neutral-200 hover:bg-white/10">
      {icon}
      {children}
    </button>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [open, setOpen] = useState(initial !== '');
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setValue(initial);
    if (initial) setOpen(true);
  }, [initial]);

  const change = (q: string) => {
    setValue(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(q.trim()), 300);
  };

  return (
    <div className={`flex items-center gap-2 rounded-sm transition-all ${open ? 'border border-white/80 bg-black/70 px-2' : ''}`}>
      <button
        type="button"
        aria-label="Search"
        onClick={() => {
          setOpen(true);
          setTimeout(() => input.current?.focus(), 0);
        }}
      >
        <SearchIcon size={20} />
      </button>
      {open && (
        <>
          <input
            ref={input}
            value={value}
            onChange={(e) => change(e.target.value)}
            onBlur={() => {
              if (!value) setOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                change('');
                setOpen(false);
              }
            }}
            placeholder="Titles, people, genres"
            className="h-8 w-36 bg-transparent text-sm outline-none placeholder:text-neutral-400 sm:w-56"
            aria-label="Search titles"
          />
          {value && (
            <button type="button" aria-label="Clear search" onClick={() => change('')}>
              <XIcon size={16} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
