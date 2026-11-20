import type { Profile } from '../lib/types';

export function Logo({ className = 'text-2xl' }: { className?: string }) {
  return (
    <span className={`font-black tracking-tight select-none ${className}`}>
      <span className="text-brand">STREAM</span>
      <span className="text-white">ORA</span>
    </span>
  );
}

/** Avatar keys stored on profiles → colour treatments. */
export const AVATARS: Record<string, string> = {
  crimson: 'from-red-500 to-rose-800',
  amber: 'from-amber-300 to-orange-600',
  emerald: 'from-emerald-400 to-teal-700',
  sky: 'from-sky-400 to-blue-700',
  violet: 'from-violet-400 to-purple-800',
  rose: 'from-pink-400 to-fuchsia-700',
  lime: 'from-lime-300 to-green-700',
  slate: 'from-slate-400 to-slate-700',
};

export function Avatar({ profile, size = 40, className = '' }: { profile: Pick<Profile, 'name' | 'avatar' | 'isKids'>; size?: number; className?: string }) {
  const gradient = AVATARS[profile.avatar] ?? AVATARS.crimson;
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br font-black text-white ${gradient} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {profile.name.trim().charAt(0).toUpperCase() || '?'}
      {profile.isKids && (
        <span className="absolute right-0 bottom-0 left-0 bg-black/30 text-center font-bold tracking-wide" style={{ fontSize: Math.max(8, size * 0.14) }}>
          KIDS
        </span>
      )}
    </span>
  );
}

/** TMDB's terms ask apps using its API to credit it. */
export function TmdbCredit({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-neutral-500 ${className}`}>
      Metadata and artwork from{' '}
      <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="font-semibold text-[#01b4e4] hover:underline">
        TMDB
      </a>
      . This product uses the TMDB API but is not endorsed or certified by TMDB.
    </p>
  );
}
