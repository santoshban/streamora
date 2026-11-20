import { useState } from 'react';
import { api, errorText } from '../lib/api';
import type { Profile, ProfilePreferences } from '../lib/types';
import { AvatarPicker } from '../pages/ProfileGate';
import { Button, ErrorNote, Field, inputClass, Modal, Toggle } from './ui';

export const LANGUAGES: Array<[string, string]> = [
  ['en', 'English'], ['hi', 'Hindi'], ['te', 'Telugu'], ['ta', 'Tamil'], ['ml', 'Malayalam'], ['kn', 'Kannada'],
  ['bn', 'Bengali'], ['mr', 'Marathi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ru', 'Russian'], ['ar', 'Arabic'],
];

/**
 * Create or edit a profile. Admin-only fields (kids/admin flags) appear when
 * `asAdmin` is set; everyone can edit their own name, avatar, PIN and playback preferences.
 */
export function ProfileEditor({
  profile,
  asAdmin,
  onClose,
  onSaved,
}: {
  profile: Profile | null;
  asAdmin: boolean;
  onClose: () => void;
  onSaved: (p: Profile) => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [avatar, setAvatar] = useState(profile?.avatar ?? 'sky');
  const [isKids, setIsKids] = useState(profile?.isKids ?? false);
  const [isAdmin, setIsAdmin] = useState(profile?.isAdmin ?? false);
  const [pinMode, setPinMode] = useState<'keep' | 'set' | 'remove'>(profile ? 'keep' : 'set');
  const [pin, setPin] = useState('');
  const [prefs, setPrefs] = useState<ProfilePreferences>(profile?.preferences ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pref = <K extends keyof ProfilePreferences>(key: K, value: ProfilePreferences[K]) => setPrefs((p) => ({ ...p, [key]: value }));

  const pinValue = pinMode === 'remove' ? null : pinMode === 'set' && pin ? pin : undefined;
  const pinInvalid = pinMode === 'set' && pin.length > 0 && pin.length < 4;

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { name: name.trim(), avatar };
    if (asAdmin) Object.assign(body, { isKids, isAdmin });
    if (pinValue !== undefined) body.pin = pinValue;
    try {
      let saved: Profile;
      if (profile) {
        saved = (await api.patch<{ profile: Profile }>(`/api/profiles/${profile.id}`, { ...body, preferences: prefs })).profile;
      } else {
        saved = (await api.post<{ profile: Profile }>('/api/profiles', body)).profile;
        if (Object.keys(prefs).length) saved = (await api.patch<{ profile: Profile }>(`/api/profiles/${saved.id}`, { preferences: prefs })).profile;
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const style = prefs.subtitleStyle ?? {};
  return (
    <Modal onClose={onClose} label={profile ? 'Edit profile' : 'Add profile'} className="max-w-xl">
      <form
        className="space-y-6 p-6 sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="text-2xl font-bold">{profile ? 'Edit profile' : 'Add profile'}</h2>
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </Field>
        <AvatarPicker value={avatar} onChange={setAvatar} name={name || '?'} />

        {asAdmin && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md bg-neutral-800/60 px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium">Kids profile</span>
                <span className="block text-xs text-neutral-400">Only family-rated titles (G, PG, TV-Y…)</span>
              </span>
              <Toggle checked={isKids} onChange={(v) => { setIsKids(v); if (v) setIsAdmin(false); }} label="Kids profile" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md bg-neutral-800/60 px-3 py-2.5">
              <span>
                <span className="block text-sm font-medium">Admin</span>
                <span className="block text-xs text-neutral-400">Manage libraries, plugins, profiles</span>
              </span>
              <Toggle checked={isAdmin} onChange={(v) => { setIsAdmin(v); if (v) setIsKids(false); }} label="Admin" />
            </label>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-200">Profile lock</legend>
          {profile && (
            <div className="flex gap-2 text-sm">
              {(['keep', 'set', 'remove'] as const)
                .filter((m) => m !== 'remove' || profile.hasPin)
                .map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPinMode(m)}
                    className={`rounded-full px-3 py-1 ${pinMode === m ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-300'}`}
                  >
                    {m === 'keep' ? (profile.hasPin ? 'Keep PIN' : 'No PIN') : m === 'set' ? (profile.hasPin ? 'Change PIN' : 'Add PIN') : 'Remove PIN'}
                  </button>
                ))}
            </div>
          )}
          {pinMode === 'set' && (
            <input
              className={inputClass}
              placeholder={profile ? 'New PIN (4–8 digits)' : 'PIN (optional, 4–8 digits)'}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              inputMode="numeric"
              type="password"
              autoComplete="new-password"
            />
          )}
        </fieldset>

        <fieldset className="space-y-3 border-t border-white/10 pt-5">
          <legend className="text-sm font-medium text-neutral-200">Playback</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Audio language">
              <select className={inputClass} value={prefs.audioLanguage ?? ''} onChange={(e) => pref('audioLanguage', e.target.value || undefined)}>
                <option value="">Original / default track</option>
                {LANGUAGES.map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="Subtitles">
              <select
                className={inputClass}
                value={prefs.subtitleLanguage ?? ''}
                onChange={(e) => pref('subtitleLanguage', e.target.value || null)}
              >
                <option value="">Off</option>
                {LANGUAGES.map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="Subtitle size">
              <select className={inputClass} value={style.size ?? 'medium'} onChange={(e) => pref('subtitleStyle', { ...style, size: e.target.value as 'medium' })}>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </Field>
            <Field label="Subtitle background">
              <select
                className={inputClass}
                value={style.background ?? 'shadow'}
                onChange={(e) => pref('subtitleStyle', { ...style, background: e.target.value as 'shadow' })}
              >
                <option value="shadow">Drop shadow</option>
                <option value="box">Dark box</option>
                <option value="none">None</option>
              </select>
            </Field>
          </div>
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Autoplay next episode</span>
            <Toggle checked={prefs.autoplayNext !== false} onChange={(v) => pref('autoplayNext', v)} label="Autoplay next episode" />
          </label>
        </fieldset>

        {error && <ErrorNote error={new Error(error)} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="brand" busy={busy} disabled={!name.trim() || pinInvalid}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
