import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Button, ErrorNote, Modal, Spinner, useToast } from './ui';

interface ServerAddresses {
  /** `local`: other devices can't connect at all. */
  listening: 'local' | 'network';
  addresses: Array<{ url: string; kind: 'lan' | 'vpn' | 'custom' }>;
}

const RELEASES_URL = 'https://github.com/santoshban/streamora/releases/latest';
const AWAY_HELP_URL = 'https://github.com/santoshban/streamora#watching-away-from-home';
const inDesktopApp = /\bElectron\//.test(navigator.userAgent);

/**
 * The Clipboard API only exists on https and localhost (phones on the LAN use
 * http) and can refuse without focus, so the old way is the fallback.
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall back below
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Copy failed');
}

/** "Connect a device": the addresses phones and tablets can use to reach this server. */
export function ConnectDeviceDialog({ onClose }: { onClose: () => void }) {
  const state = useAsync((signal) => api.get<ServerAddresses>('/api/server/addresses', { signal }), []);
  const data = state.data;
  const of = (kind: 'lan' | 'vpn' | 'custom') => data?.addresses.filter((a) => a.kind === kind).map((a) => a.url) ?? [];

  return (
    <Modal onClose={onClose} label="Connect a device" className="max-w-xl">
      <div className="space-y-6 p-6 sm:p-8">
        <div>
          <h2 className="pr-8 text-2xl font-bold">Watch on your phone or tablet</h2>
          <p className="mt-2 text-sm text-soft">
            Install the{' '}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="font-semibold text-white underline-offset-2 hover:underline">
              Streamora app for Android
            </a>
            : it finds this computer on your Wi-Fi by itself.
            {data?.listening === 'network' && ' You can also type an address below into the app, or open it in any phone or tablet’s web browser.'}
          </p>
        </div>

        {state.loading && !data && (
          <div className="grid place-items-center py-6">
            <Spinner className="text-brand" />
          </div>
        )}
        {state.error ? <ErrorNote error={state.error} onRetry={state.reload} /> : null}

        {data?.listening === 'local' && <SharingOff />}

        {data?.listening === 'network' && (
          <>
            <AddressGroup title="On your home Wi-Fi" urls={of('lan')}>
              <p className="text-sm text-soft">This computer isn&rsquo;t connected to a network right now.</p>
            </AddressGroup>
            <AddressGroup title="Away from home" urls={[...of('vpn'), ...of('custom')]}>
              <p className="text-sm text-soft">
                Set up Tailscale, a free private VPN, on this computer and your phone, and an address for use anywhere appears here.{' '}
                <a href={AWAY_HELP_URL} target="_blank" rel="noreferrer" className="font-semibold text-white underline-offset-2 hover:underline">
                  How to watch away from home
                </a>
              </p>
            </AddressGroup>
          </>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AddressGroup({ title, urls, children }: { title: string; urls: string[]; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">{title}</h3>
      {urls.length === 0 ? children : urls.map((url) => <AddressRow key={url} url={url} />)}
    </section>
  );
}

function AddressRow({ url }: { url: string }) {
  const toast = useToast();
  const [scheme, rest] = url.includes('://') ? url.split('://', 2) : ['http', url];
  return (
    <div className="flex items-center gap-3 rounded-md bg-neutral-800/60 py-2 pr-2 pl-4 ring-1 ring-white/10">
      {/* Wraps after "http://" rather than truncating: the port at the end is the part people miss. */}
      <code className="min-w-0 flex-1 text-base font-semibold wrap-anywhere text-white select-all sm:text-lg">
        {scheme}://
        <wbr />
        {rest}
      </code>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void copyText(url).then(
            () => toast('Address copied'),
            () => toast('Couldn’t copy. Select the address and copy it yourself.', 'error'),
          )
        }
      >
        Copy
      </Button>
    </div>
  );
}

function SharingOff() {
  return (
    <div className="space-y-2 rounded-md bg-amber-500/10 p-4 text-sm ring-1 ring-amber-400/30">
      <p className="font-semibold text-amber-200">Other devices can&rsquo;t connect yet</p>
      {inDesktopApp ? (
        <p className="text-soft">
          Right-click the Streamora icon in the notification area (click <span className="font-semibold text-white">^</span> on the taskbar if you don&rsquo;t see it) and
          turn on <span className="font-semibold text-white">Let other devices on my network connect</span>. If Windows asks about the firewall, allow Streamora on private
          networks. Then open this again.
        </p>
      ) : (
        <p className="text-soft">
          The server only accepts connections from this computer. Set <code className="text-white">HOST=0.0.0.0</code> in <code className="text-white">.env</code> and restart it.
        </p>
      )}
    </div>
  );
}
