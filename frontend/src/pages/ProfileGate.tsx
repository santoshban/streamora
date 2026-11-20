import { useEffect, useRef, useState } from 'react';
import { Avatar, AVATARS, Logo } from '../components/Brand';
import { LockIcon } from '../components/Icons';
import { Button, ErrorNote, Field, inputClass, Modal, Spinner } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import type { Profile } from '../lib/types';
import { useSession } from '../state/session';

/** 10vw, clamped to 84–200px, tracking window resizes. */
function useAvatarSize() {
  const measure = () => Math.round(Math.min(200, Math.max(84, window.innerWidth * 0.1)));
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const onResize = () => setSize(measure());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** "Who's watching?" */
export function ProfileGate() {
  const { signedIn } = useSession();
  const profiles = useAsync((signal) => api.get<{ profiles: Profile[] }>('/api/profiles', { signal }), []);
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (p: Profile) => {
    setError(null);
    if (p.hasPin) {
      setPinFor(p);
      return;
    }
    setBusy(p.id);
    try {
      const res = await api.post<{ profile: Profile }>(`/api/profiles/${p.id}/session`, {});
      signedIn(res.profile);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  // Netflix sizes the gate with the viewport: 10vw avatars (84–200px), 3.5vw heading.
  const avatarSize = useAvatarSize();

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="gutter-x flex h-(--nav-h) items-center animate-fade-in">
        <Logo className="text-[1.6rem] min-[950px]:text-[1.9rem]" />
      </header>
      <main
        className={`flex flex-1 flex-col items-center justify-center px-6 pb-[8vh] transition-[scale,opacity] duration-500 ease-standard ${
          busy !== null ? 'scale-[1.04] opacity-60' : ''
        } animate-[pop_0.55s_var(--ease-out-expo)_backwards]`}
      >
        <h1 className="mb-[clamp(1.5rem,2.5vw,2.5rem)] text-[clamp(1.75rem,3.5vw,3.5rem)] font-medium">Who&rsquo;s watching?</h1>
        {profiles.loading && <Spinner className="text-soft" />}
        {profiles.error ? <ErrorNote error={profiles.error} onRetry={profiles.reload} /> : null}
        <ul className="flex max-w-[80vw] flex-wrap justify-center gap-[clamp(1rem,2vw,2rem)]">
          {profiles.data?.profiles.map((p, i) => (
            <li key={p.id} className="animate-fade-up" style={{ animationDelay: `${120 + i * 70}ms` }}>
              <button type="button" onClick={() => void choose(p)} className="group flex flex-col items-center outline-none" disabled={busy !== null} style={{ width: avatarSize }}>
                <span
                  className="relative block overflow-hidden rounded-[4px] outline-[0.3em] outline-transparent transition-[outline-color,transform] duration-200 group-hover:outline-ink group-focus-visible:outline-ink outline-solid"
                >
                  <Avatar profile={p} size={avatarSize} className="rounded-none!" />
                  {busy === p.id && (
                    <span className="absolute inset-0 grid place-items-center bg-black/50">
                      <Spinner />
                    </span>
                  )}
                </span>
                <span className="mt-[0.6em] flex min-h-[1.8em] items-center gap-1.5 text-[clamp(0.95rem,1.3vw,1.3rem)] text-muted transition-colors duration-200 group-hover:text-ink group-focus-visible:text-ink">
                  {p.name}
                  {p.hasPin && <LockIcon size={14} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="mt-6 text-sm text-red-300 animate-fade-in">{error}</p>}
      </main>
      {pinFor && <PinPrompt profile={pinFor} onClose={() => setPinFor(null)} onSignedIn={signedIn} />}
    </div>
  );
}

function PinPrompt({ profile, onClose, onSignedIn }: { profile: Profile; onClose: () => void; onSignedIn: (p: Profile) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ profile: Profile }>(`/api/profiles/${profile.id}/session`, { pin: value });
      onSignedIn(res.profile);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Incorrect PIN. Try again.' : errorText(err));
      setPin('');
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <Modal onClose={onClose} label={`PIN for ${profile.name}`} className="max-w-sm">
      <form
        className="flex flex-col items-center gap-5 p-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (pin.length >= 4) void submit(pin);
        }}
      >
        <Avatar profile={profile} size={72} />
        <h2 className="text-center text-lg font-semibold">Enter your PIN to access {profile.name}&rsquo;s profile</h2>
        <input
          ref={input}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          className="w-48 rounded-md border-2 border-neutral-600 bg-transparent py-3 text-center text-3xl tracking-[0.5em] focus:border-white focus:outline-none"
          type="password"
          disabled={busy}
        />
        {error && <p className="text-sm text-red-300">{error}</p>}
        <Button type="submit" variant="brand" busy={busy} disabled={pin.length < 4} className="w-48">
          Continue
        </Button>
      </form>
    </Modal>
  );
}

/** First run: create the owner (admin) profile, then add a library. */
export function Setup() {
  const { signedIn } = useSession();
  const { navigate } = useRouter();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('crimson');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,_#3a0d10,_#141414_60%)] px-6 py-12">
      <form
        className="w-full max-w-md space-y-6 rounded-xl bg-black/60 p-8 ring-1 ring-white/10 backdrop-blur"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const res = await api.post<{ profile: Profile }>('/api/profiles', { name: name.trim(), avatar, ...(pin ? { pin } : {}) });
            signedIn(res.profile);
            navigate('/admin/libraries?setup=1', { replace: true });
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <div className="space-y-2 text-center">
          <Logo className="text-4xl" />
          <p className="text-neutral-300">Welcome! Create your profile to get started. It becomes the admin profile.</p>
        </div>
        <Field label="Your name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
        </Field>
        <AvatarPicker value={avatar} onChange={setAvatar} name={name || '?'} />
        <Field label="PIN (optional)" hint="4–8 digits. Recommended for the admin profile.">
          <input
            className={inputClass}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            inputMode="numeric"
            type="password"
            autoComplete="new-password"
          />
        </Field>
        {error ? <ErrorNote error={new Error(errorText(error))} /> : null}
        <Button type="submit" variant="brand" size="lg" className="w-full" busy={busy} disabled={!name.trim() || (pin.length > 0 && pin.length < 4)}>
          Create profile
        </Button>
      </form>
    </div>
  );
}

export function AvatarPicker({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-neutral-200">Avatar</legend>
      <div className="flex flex-wrap gap-2">
        {Object.keys(AVATARS).map((key) => (
          <button
            key={key}
            type="button"
            aria-label={key}
            aria-pressed={value === key}
            onClick={() => onChange(key)}
            className={`rounded-md transition ${value === key ? 'ring-2 ring-white ring-offset-2 ring-offset-neutral-900' : 'opacity-70 hover:opacity-100'}`}
          >
            <Avatar profile={{ name, avatar: key, isKids: false }} size={44} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
