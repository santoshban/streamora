import { useState, type ComponentType, type ReactNode } from 'react';
import { inAndroidApp, postToApp } from '../lib/native';
import { useRouter } from '../lib/router';
import { useSession } from '../state/session';
import { ConnectDeviceDialog } from './ConnectDevice';
import { GearIcon, PencilIcon, PhoneIcon, ServerIcon, UsersIcon } from './Icons';
import { ProfileEditor } from './ProfileEditor';

export interface AccountAction {
  id: 'edit' | 'switch' | 'manage' | 'server' | 'connect';
  label: string;
  Icon: ComponentType<{ size?: number }>;
  onSelect: () => void;
}

/**
 * The profile menu's actions. The movies & TV header and the music top bar
 * both list these, so neither menu misses an option the other has.
 * Render `dialogs` outside any open-on-hover element: pointing at a dialog
 * would otherwise reopen the menu behind it.
 */
export function useAccountActions(): { actions: AccountAction[]; dialogs: ReactNode; signOut: () => void } {
  const { navigate } = useRouter();
  const { profile, switchProfile, signOut, updateProfile } = useSession();
  const [dialog, setDialog] = useState<'edit' | 'connect' | null>(null);
  if (!profile) return { actions: [], dialogs: null, signOut: () => void signOut() };

  const actions: AccountAction[] = [
    { id: 'edit', label: 'Edit profile', Icon: PencilIcon, onSelect: () => setDialog('edit') },
    { id: 'switch', label: 'Switch profile', Icon: UsersIcon, onSelect: switchProfile },
  ];
  if (profile.isAdmin) actions.push({ id: 'manage', label: 'Manage server', Icon: GearIcon, onSelect: () => navigate('/admin/libraries') });
  actions.push(
    inAndroidApp
      ? { id: 'server', label: 'Change server', Icon: ServerIcon, onSelect: () => postToApp({ type: 'changeServer' }) }
      : { id: 'connect', label: 'Connect a device', Icon: PhoneIcon, onSelect: () => setDialog('connect') },
  );

  const dialogs = (
    <>
      {dialog === 'edit' && <ProfileEditor profile={profile} asAdmin={false} onClose={() => setDialog(null)} onSaved={updateProfile} />}
      {dialog === 'connect' && <ConnectDeviceDialog onClose={() => setDialog(null)} />}
    </>
  );
  return { actions, dialogs, signOut: () => void signOut() };
}

/** "Owner", "Kids profile" or "Profile", under the name in both menus. */
export const profileRole = (p: { isKids: boolean; isAdmin: boolean }) => (p.isKids ? 'Kids profile' : p.isAdmin ? 'Owner' : 'Profile');
