import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, UNAUTHORIZED_EVENT } from '../lib/api';
import type { Health, Profile } from '../lib/types';

type Status = 'loading' | 'offline' | 'setup' | 'gate' | 'ready';

interface SessionValue {
  status: Status;
  profile: Profile | null;
  health: Health | null;
  /** Called after a profile session was started (sign in or first-run setup). */
  signedIn(profile: Profile): void;
  signOut(): Promise<void>;
  /** Back to "Who's watching?" without deleting the cookie of the next sign-in. */
  switchProfile(): void;
  refresh(): Promise<void>;
  updateProfile(profile: Profile): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await api.get<Health>('/api/health');
      setHealth(h);
      if (h.setupRequired) {
        setProfile(null);
        setStatus('setup');
        return;
      }
      const { profile: p } = await api.get<{ profile: Profile }>('/api/session');
      setProfile(p);
      setStatus('ready');
    } catch (err) {
      setProfile(null);
      setStatus(err instanceof ApiError && err.status === 401 ? 'gate' : 'offline');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      setProfile(null);
      setStatus('gate');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      profile,
      health,
      signedIn(p) {
        setProfile(p);
        setStatus('ready');
      },
      async signOut() {
        await api.del('/api/session').catch(() => undefined);
        setProfile(null);
        setStatus('gate');
      },
      switchProfile() {
        setProfile(null);
        setStatus('gate');
      },
      refresh,
      updateProfile(p) {
        setProfile((current) => (current && current.id === p.id ? { ...current, ...p } : current));
      },
    }),
    [status, profile, health, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
