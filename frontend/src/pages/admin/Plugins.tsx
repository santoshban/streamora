import { useState } from 'react';
import { TmdbCredit } from '../../components/Brand';
import { ChevronDownIcon, RefreshIcon } from '../../components/Icons';
import { Badge, Button, ErrorNote, Field, inputBase, inputClass, Spinner, Toggle, useToast } from '../../components/ui';
import { api, errorText } from '../../lib/api';
import { useServerEvents } from '../../lib/events';
import { useAsync } from '../../lib/hooks';
import type { PluginDetails, PluginStatus, PluginSummary, SettingField, SettingValue } from '../../lib/types';

const SECRET_MASK = '••••••••';
const STATUS: Record<PluginStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'solid' }> = {
  active: { label: 'Active', tone: 'green' },
  needs_config: { label: 'Needs setup', tone: 'amber' },
  disabled: { label: 'Disabled', tone: 'solid' },
  error: { label: 'Error', tone: 'red' },
  invalid: { label: 'Invalid', tone: 'red' },
  loading: { label: 'Loading', tone: 'solid' },
};
const CAPABILITY_LABEL: Record<string, string> = {
  metadata: 'Metadata',
  subtitles: 'Subtitles',
  stream_resolver: 'Stream sources',
  post_scan: 'After scan',
};

export function PluginsPage() {
  const toast = useToast();
  const list = useAsync((signal) => api.get<{ pluginsDir: string; hotReload: boolean; plugins: PluginSummary[] }>('/api/admin/plugins', { signal }), []);
  const [rescanning, setRescanning] = useState(false);
  useServerEvents(['plugins.changed', 'plugin.status'], () => list.reload());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Plugins</h1>
          <p className="text-sm text-neutral-400">
            Metadata agents, subtitle providers and other extensions from <code className="text-neutral-300">{list.data?.pluginsDir ?? 'plugins/'}</code>
            {list.data?.hotReload && ' · reloaded automatically when their files change'}.
          </p>
        </div>
        <Button
          busy={rescanning}
          onClick={async () => {
            setRescanning(true);
            try {
              await api.post('/api/admin/plugins/rescan');
              list.reload();
            } catch (err) {
              toast(errorText(err), 'error');
            } finally {
              setRescanning(false);
            }
          }}
        >
          <RefreshIcon size={14} /> Rescan folder
        </Button>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error ? <ErrorNote error={list.error} onRetry={list.reload} /> : null}
      <ul className="space-y-4">
        {list.data?.plugins.map((p) => (
          <PluginCard key={p.folder} plugin={p} onChanged={list.reload} />
        ))}
      </ul>
    </div>
  );
}

function PluginCard({ plugin, onChanged }: { plugin: PluginSummary; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(plugin.status === 'needs_config');
  const [priority, setPriority] = useState(String(plugin.priority));
  const [testing, setTesting] = useState(false);
  const status = STATUS[plugin.status];
  const valid = plugin.status !== 'invalid';

  const patch = async (body: { enabled?: boolean; priority?: number }) => {
    try {
      await api.patch(`/api/admin/plugins/${plugin.id}`, body);
      onChanged();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <li className="rounded-lg bg-neutral-900 ring-1 ring-white/10">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{plugin.name}</h2>
            {plugin.version && <span className="text-sm text-neutral-500">v{plugin.version}</span>}
            <Badge tone={status.tone}>{status.label}</Badge>
            {plugin.capabilities.map((c) => (
              <Badge key={c}>{CAPABILITY_LABEL[c] ?? c}</Badge>
            ))}
          </div>
          {plugin.description && <p className="text-sm text-neutral-400">{plugin.description}</p>}
          {plugin.status === 'needs_config' && plugin.missingSettings.length > 0 && (
            <p className="text-sm text-amber-300">Fill in: {plugin.missingSettings.join(', ')}</p>
          )}
          {plugin.error && <p className="text-sm whitespace-pre-line text-red-300">{plugin.error}</p>}
          {[...plugin.errors, ...plugin.warnings].map((m) => (
            <p key={m} className="text-xs text-amber-200/80">
              {m}
            </p>
          ))}
          {plugin.id === 'tmdb-metadata' && <TmdbCredit className="pt-1" />}
        </div>
        {valid && (
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-400" title="Lower runs first">
              Priority
              <input
                className={`${inputBase} w-16 py-1 text-center`}
                value={priority}
                inputMode="numeric"
                onChange={(e) => setPriority(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onBlur={() => {
                  if (priority !== String(plugin.priority) && priority !== '') void patch({ priority: Number(priority) });
                }}
              />
            </label>
            <Toggle checked={plugin.enabled} onChange={(v) => void patch({ enabled: v })} label={`Enable ${plugin.name}`} />
          </div>
        )}
      </div>
      {valid && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/5 px-5 py-3">
          {plugin.hasSettings && (
            <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <ChevronDownIcon size={14} className={`transition ${open ? 'rotate-180' : ''}`} /> Settings
            </Button>
          )}
          {plugin.hasHealthCheck && plugin.status === 'active' && (
            <Button
              size="sm"
              variant="ghost"
              busy={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const { result } = await api.post<{ result: { ok: boolean; message?: string } }>(`/api/admin/plugins/${plugin.id}/test`);
                  toast(`${result.ok ? '✓' : '✗'} ${result.message ?? (result.ok ? 'Working' : 'Failed')}`, result.ok ? 'info' : 'error');
                } catch (err) {
                  toast(errorText(err), 'error');
                } finally {
                  setTesting(false);
                }
              }}
            >
              Test
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.post(`/api/admin/plugins/${plugin.id}/reload`).catch((err: unknown) => toast(errorText(err), 'error'));
              onChanged();
            }}
          >
            Reload
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const { cleared } = await api.del<{ cleared: number }>(`/api/admin/plugins/${plugin.id}/cache`);
                toast(`Cleared ${cleared} cached entr${cleared === 1 ? 'y' : 'ies'}`);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          >
            Clear cache
          </Button>
          {plugin.permissions?.network?.length ? (
            <span className="ml-auto text-xs text-neutral-500">Network: {plugin.permissions.network.join(', ')}</span>
          ) : null}
        </div>
      )}
      {open && plugin.hasSettings && <SettingsForm id={plugin.id} onSaved={onChanged} />}
    </li>
  );
}

function SettingsForm({ id, onSaved }: { id: string; onSaved: () => void }) {
  const toast = useToast();
  const details = useAsync((signal) => api.get<{ plugin: PluginDetails }>(`/api/admin/plugins/${id}`, { signal }), [id]);
  const [draft, setDraft] = useState<Record<string, SettingValue | null>>({});
  const [busy, setBusy] = useState(false);

  if (details.loading && !details.data) return <Spinner className="m-5" />;
  if (details.error) return <div className="p-5"><ErrorNote error={details.error} /></div>;
  const { schema, values, sources } = details.data!.plugin.settings;
  const value = (key: string) => (key in draft ? draft[key] : values[key]);
  const set = (key: string, v: SettingValue | null) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <form
      className="space-y-4 border-t border-white/5 p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.put(`/api/admin/plugins/${id}/settings`, { values: draft });
          toast('Settings saved');
          setDraft({});
          details.reload();
          onSaved();
        } catch (err) {
          toast(errorText(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        {schema.map((field) => (
          <SettingInput key={field.key} field={field} value={value(field.key)} source={sources[field.key]} onChange={(v) => set(field.key, v)} />
        ))}
      </div>
      <div className="flex justify-end gap-2">
        {Object.keys(draft).length > 0 && (
          <Button variant="ghost" onClick={() => setDraft({})}>
            Discard
          </Button>
        )}
        <Button type="submit" variant="brand" busy={busy} disabled={Object.keys(draft).length === 0}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

function SettingInput({
  field,
  value,
  source,
  onChange,
}: {
  field: SettingField;
  value: SettingValue | null | undefined;
  source?: string;
  onChange: (v: SettingValue | null) => void;
}) {
  const hint = (
    <>
      {field.description}
      {source === 'env' && field.env && <span className="block text-sky-300/80">Using the {field.env} environment variable.</span>}
    </>
  );
  const label = `${field.label}${field.required ? ' *' : ''}`;

  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex items-start justify-between gap-3 rounded-md bg-neutral-800/50 p-3">
          <span>
            <span className="block text-sm font-medium">{label}</span>
            <span className="block text-xs text-neutral-400">{hint}</span>
          </span>
          <Toggle checked={value === true} onChange={(v) => onChange(v)} label={field.label} />
        </label>
      );
    case 'select':
      return (
        <Field label={label} hint={hint}>
          <select className={inputClass} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'number':
      return (
        <Field label={label} hint={hint}>
          <input
            className={inputClass}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      );
    case 'list':
      return (
        <Field label={label} hint={<>{hint} One per line.</>}>
          <textarea
            className={`${inputClass} min-h-20 font-mono`}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          />
        </Field>
      );
    case 'headers':
      return (
        <Field label={label} hint={<>{hint} One `Name: value` per line.</>}>
          <textarea
            className={`${inputClass} min-h-20 font-mono`}
            value={value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}
            onChange={(e) =>
              onChange(
                Object.fromEntries(
                  e.target.value
                    .split('\n')
                    .map((l) => l.split(':'))
                    .filter((p) => p.length >= 2 && p[0]!.trim())
                    .map(([k, ...v]) => [k!.trim(), v.join(':').trim()]),
                ),
              )
            }
          />
        </Field>
      );
    case 'secret':
      return (
        <Field label={label} hint={hint}>
          <input
            className={inputClass}
            type="password"
            autoComplete="off"
            placeholder={value === SECRET_MASK ? 'Saved — type to replace' : (field.placeholder ?? '')}
            value={value === SECRET_MASK ? '' : String(value ?? '')}
            onChange={(e) => onChange(e.target.value === '' ? SECRET_MASK : e.target.value)}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={hint}>
          <input
            className={inputClass}
            type={field.type === 'url' ? 'url' : 'text'}
            placeholder={field.placeholder}
            pattern={field.type === 'string' ? field.pattern : undefined}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
  }
}
