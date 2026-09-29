import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ACCESS_TYPE_LABELS, PROTOCOL_NAMES } from '../../../shared/constants.ts';
import type {
  AccessType,
  AuthType,
  CatalogModelDto,
  ConnectionDto,
  ConnectionStatus,
  DiscoveredModel,
  ModelParams,
  Protocol,
  ProviderPresetDto,
} from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { confirmDialog, Dialog } from '../components/Dialog.tsx';
import { MenuButton, type MenuNode } from '../components/Menu.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { Badge, Button, cx, Field, Spinner, Switch } from '../components/ui.tsx';
import { formatTokens, relativeTime } from '../lib/format.ts';
import { useConnections, useModels, usePresets } from '../lib/queries.ts';
import { SecretDialog } from './common.tsx';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  verified: 'Verified',
  unverified: 'Not verified yet',
  error: 'Error',
  expired: 'Expired — reconnect',
  needs_credentials: 'Needs a key or token',
};

const AUTH_LABELS: Record<AuthType, string> = {
  api_key: 'API key',
  bearer_token: 'Access token (pasted)',
  token_command: 'Token command (runs a local program)',
  none: 'None (local server)',
};

interface TestResult {
  ok: boolean;
  status: ConnectionStatus;
  detail: string;
  models: DiscoveredModel[];
}

function useRefresh() {
  const queryClient = useQueryClient();
  return (): void => {
    void queryClient.invalidateQueries({ queryKey: ['connections'] });
    void queryClient.invalidateQueries({ queryKey: ['models'] });
  };
}

// ── Model dialog ─────────────────────────────────────────────────────────────
function ModelDialog({
  connectionId,
  model,
  initial,
  onClose,
}: {
  connectionId: string;
  model?: CatalogModelDto;
  initial?: DiscoveredModel;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const suggestedContext = model?.contextWindow ?? initial?.contextWindow ?? 32_000;
  const suggestedOutput = model?.maxOutputTokens ?? Math.min(initial?.maxOutputTokens ?? 4096, Math.floor(suggestedContext / 2));
  const [form, setForm] = useState({
    apiModelId: model?.apiModelId ?? initial?.apiModelId ?? '',
    displayName: model?.displayName ?? initial?.displayName ?? '',
    contextWindow: String(suggestedContext),
    maxOutputTokens: String(suggestedOutput),
    supportsTools: model?.supportsTools ?? false,
    supportsImages: model?.supportsImages ?? false,
    supportsPdfs: model?.supportsPdfs ?? false,
    temperature: model?.params.temperature !== undefined ? String(model.params.temperature) : '',
    reasoningEffort: model?.params.reasoningEffort ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void => setForm({ ...form, [key]: value });

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    const params: ModelParams = {};
    if (form.temperature.trim() !== '') params.temperature = Number(form.temperature);
    if (form.reasoningEffort) params.reasoningEffort = form.reasoningEffort as ModelParams['reasoningEffort'];
    const body = {
      apiModelId: form.apiModelId.trim(),
      displayName: form.displayName.trim() || form.apiModelId.trim(),
      contextWindow: Number(form.contextWindow),
      maxOutputTokens: Number(form.maxOutputTokens),
      supportsTools: form.supportsTools,
      supportsImages: form.supportsImages,
      supportsPdfs: form.supportsPdfs,
      params,
    };
    try {
      if (model) await api.patch(`/api/models/${model.id}`, body);
      else await api.post(`/api/connections/${connectionId}/models`, body);
      refresh();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      title={model ? `Edit ${model.displayName}` : 'Add a model'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="model-form" disabled={busy || !form.apiModelId.trim()}>
            {model ? 'Save' : 'Add model'}
          </Button>
        </>
      }
    >
      <form id="model-form" className="settings-group" onSubmit={(e) => void submit(e)}>
        <div className="field-grid">
          <Field label="Model ID" htmlFor="m-id" hint="Exactly as the provider names it in its API.">
            <input id="m-id" className="input mono" data-autofocus value={form.apiModelId} onChange={(e) => set('apiModelId', e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Display name" htmlFor="m-name">
            <input id="m-name" className="input" value={form.displayName} placeholder={form.apiModelId} onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="Context window (tokens)" htmlFor="m-ctx" hint="From the provider's model documentation.">
            <input id="m-ctx" className="input" inputMode="numeric" value={form.contextWindow} onChange={(e) => set('contextWindow', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Max output (tokens)" htmlFor="m-out" hint="Upper limit for one reply.">
            <input id="m-out" className="input" inputMode="numeric" value={form.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
        <div className="field">
          <label>Capabilities</label>
          <div className="hint">Turn on only what this model really supports. Theologians won't send tools, images, or PDFs to a model that isn't marked for them.</div>
          <div className="check-grid">
            <label className="checkbox-row">
              <input type="checkbox" checked={form.supportsTools} onChange={(e) => set('supportsTools', e.target.checked)} /> Tool calling (search, files, memory suggestions)
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.supportsImages} onChange={(e) => set('supportsImages', e.target.checked)} /> Image input
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.supportsPdfs} onChange={(e) => set('supportsPdfs', e.target.checked)} /> Native PDF input
            </label>
          </div>
        </div>
        <details>
          <summary className="muted">Advanced parameters</summary>
          <div className="field-grid" style={{ marginTop: 10 }}>
            <Field label="Temperature (optional)" htmlFor="m-temp" hint="Leave empty to use the provider's default.">
              <input id="m-temp" className="input" inputMode="decimal" value={form.temperature} onChange={(e) => set('temperature', e.target.value)} />
            </Field>
            <Field label="Reasoning effort (optional)" htmlFor="m-effort" hint="Only for reasoning models that accept it.">
              <select id="m-effort" className="select" value={form.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value)}>
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
        </details>
      </form>
    </Dialog>
  );
}

// ── Connection dialog ────────────────────────────────────────────────────────
interface ConnectionForm {
  preset: string;
  name: string;
  baseUrl: string;
  protocol: Protocol;
  accessType: AccessType;
  authType: AuthType;
  secret: string;
  tokenCommand: string;
  extraHeaders: string;
}

function formFromPreset(preset: ProviderPresetDto): ConnectionForm {
  return {
    preset: preset.key,
    name: preset.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    accessType: preset.accessType,
    authType: preset.authType,
    secret: '',
    tokenCommand: (preset.tokenCommand ?? []).join('\n'),
    extraHeaders: '',
  };
}

function formFromConnection(c: ConnectionDto): ConnectionForm {
  return {
    preset: c.preset,
    name: c.name,
    baseUrl: c.baseUrl,
    protocol: c.protocol,
    accessType: c.accessType,
    authType: c.authType,
    secret: '',
    tokenCommand: (c.tokenCommand ?? []).join('\n'),
    extraHeaders: Object.entries(c.extraHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  };
}

function ConnectionDialog({ presets, connection, onClose, onSaved }: { presets: ProviderPresetDto[]; connection?: ConnectionDto; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState<ConnectionForm | null>(connection ? formFromConnection(connection) : null);
  const [busy, setBusy] = useState(false);
  const preset = presets.find((p) => p.key === form?.preset);
  const set = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]): void => setForm((f) => (f ? { ...f, [key]: value } : f));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    const extraHeaders: Record<string, string> = {};
    for (const line of form.extraHeaders.split('\n')) {
      const index = line.indexOf(':');
      if (index > 0) extraHeaders[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    const body = {
      name: form.name,
      preset: form.preset,
      protocol: form.protocol,
      accessType: form.accessType,
      baseUrl: form.baseUrl,
      authType: form.authType,
      tokenCommand: form.authType === 'token_command' ? form.tokenCommand.split('\n').map((l) => l.trim()).filter(Boolean) : null,
      extraHeaders,
    };
    try {
      if (connection) {
        await api.patch(`/api/connections/${connection.id}`, body);
        onSaved(connection.id);
      } else {
        const created = await api.post<ConnectionDto>('/api/connections', { ...body, secret: form.secret || undefined });
        onSaved(created.id);
      }
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!form) {
    return (
      <Dialog open size="lg" title="Add a connection" onClose={onClose}>
        <p style={{ marginBottom: 12 }}>Choose where your models run. You can change details on the next step.</p>
        <div className="preset-grid">
          {presets.map((p) => (
            <button key={p.key} type="button" className="preset" onClick={() => setForm(formFromPreset(p))}>
              <span className="name">
                {p.name}
                <Badge>{ACCESS_TYPE_LABELS[p.accessType]}</Badge>
              </span>
              <span className="summary">{p.summary}</span>
            </button>
          ))}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      size="lg"
      title={connection ? `Edit ${connection.name}` : `Add ${preset?.name ?? 'connection'}`}
      onClose={onClose}
      footer={
        <>
          {!connection && (
            <Button variant="ghost" onClick={() => setForm(null)}>
              Back
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" disabled={busy || !form.name.trim() || !form.baseUrl.trim()}>
            {connection ? 'Save' : 'Save and test'}
          </Button>
        </>
      }
    >
      <form id="connection-form" className="settings-group" onSubmit={(e) => void submit(e)}>
        {preset && (
          <div className="callout">
            {preset.authNotes}
            {preset.modelNotes && <p style={{ marginTop: 8 }}>{preset.modelNotes}</p>}
            {preset.docsUrl && (
              <p style={{ marginTop: 8 }}>
                <a href={preset.docsUrl} target="_blank" rel="noopener noreferrer">
                  Provider documentation <ExternalLink size={12} aria-hidden="true" />
                </a>
              </p>
            )}
          </div>
        )}
        <div className="field-grid">
          <Field label="Name" htmlFor="c-name">
            <input id="c-name" className="input" data-autofocus value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Authentication" htmlFor="c-auth">
            <select id="c-auth" className="select" value={form.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
              {(Object.keys(AUTH_LABELS) as AuthType[]).map((a) => (
                <option key={a} value={a}>
                  {AUTH_LABELS[a]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Base URL" htmlFor="c-url" hint="https is required for anything that isn't on this computer or your local network.">
          <input id="c-url" className="input mono" value={form.baseUrl} spellCheck={false} onChange={(e) => set('baseUrl', e.target.value)} />
        </Field>
        {!connection && (form.authType === 'api_key' || form.authType === 'bearer_token') && (
          <Field label={preset?.secretLabel ?? (form.authType === 'api_key' ? 'API key' : 'Access token')} htmlFor="c-secret" hint="Saved in your operating system’s credential store. You can also add it later.">
            <input id="c-secret" className="input" type="password" autoComplete="off" spellCheck={false} value={form.secret} onChange={(e) => set('secret', e.target.value)} />
          </Field>
        )}
        {form.authType === 'token_command' && (
          <Field
            label="Token command — one argument per line"
            htmlFor="c-cmd"
            hint={
              <>
                Runs without a shell whenever a fresh token is needed. Use full paths. For ALCF: use the Python executable with <code>globus_sdk</code> installed (locate it with <code>where python</code> on Windows or <code>which python3</code> on macOS/Linux), then the full path to{' '}
                <code>inference_auth_token.py</code>, then <code>get_access_token</code>. Sign in once in a terminal with <code>authenticate</code> first.
              </>
            }
          >
            <textarea id="c-cmd" className="textarea mono" rows={3} value={form.tokenCommand} spellCheck={false} onChange={(e) => set('tokenCommand', e.target.value)} />
          </Field>
        )}
        <details>
          <summary className="muted">Protocol and advanced options</summary>
          <div className="settings-group" style={{ marginTop: 10 }}>
            <div className="field-grid">
              <Field label="Protocol" htmlFor="c-proto">
                <select id="c-proto" className="select" value={form.protocol} onChange={(e) => set('protocol', e.target.value as Protocol)}>
                  {(Object.keys(PROTOCOL_NAMES) as Protocol[]).map((p) => (
                    <option key={p} value={p}>
                      {PROTOCOL_NAMES[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Kind of access" htmlFor="c-access">
                <select id="c-access" className="select" value={form.accessType} onChange={(e) => set('accessType', e.target.value as AccessType)}>
                  {(Object.keys(ACCESS_TYPE_LABELS) as AccessType[]).map((a) => (
                    <option key={a} value={a}>
                      {ACCESS_TYPE_LABELS[a]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Extra request headers (optional)" htmlFor="c-headers" hint="One “Name: value” per line. Not for credentials — use the key or token field.">
              <textarea id="c-headers" className="textarea mono" rows={2} value={form.extraHeaders} spellCheck={false} onChange={(e) => set('extraHeaders', e.target.value)} />
            </Field>
          </div>
        </details>
      </form>
    </Dialog>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────
function ModelRow({ model, onEdit }: { model: CatalogModelDto; onEdit: () => void }) {
  const refresh = useRefresh();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string; text: string | null } | null>(null);
  const nodes: MenuNode[] = [
    { id: 'edit', label: 'Edit', icon: <Pencil size={15} />, onSelect: onEdit },
    {
      id: 'delete',
      label: 'Remove model',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () =>
        void (async () => {
          if (!(await confirmDialog({ title: `Remove ${model.displayName}?`, message: 'Past responses keep their labels. Chats that selected this model will need a new one.', confirmLabel: 'Remove', danger: true }))) return;
          await api.delete(`/api/models/${model.id}`).catch(toastError);
          refresh();
        })(),
    },
  ];
  return (
    <div className="model-row">
      <div className="model-main">
        <div className="model-name">{model.displayName}</div>
        <div className="caps">
          <span className="path">{model.apiModelId}</span>
          <Badge>{formatTokens(model.contextWindow)} context</Badge>
          <Badge>{formatTokens(model.maxOutputTokens)} out</Badge>
          {model.supportsTools && <Badge tone="accent">Tools</Badge>}
          {model.supportsImages && <Badge tone="accent">Images</Badge>}
          {model.supportsPdfs && <Badge tone="accent">PDFs</Badge>}
        </div>
        {result && (
          <div className={cx('result-box', result.ok ? 'ok' : 'bad')}>
            {result.ok ? `${result.detail} The model replied: “${(result.text ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').slice(0, 160)}”` : result.detail}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={testing}
        onClick={async () => {
          setTesting(true);
          try {
            setResult(await api.post(`/api/models/${model.id}/test`));
            refresh();
          } catch (err) {
            toastError(err);
          } finally {
            setTesting(false);
          }
        }}
      >
        {testing ? <Spinner label="Testing" /> : 'Send test message'}
      </Button>
      <Switch label={`Use ${model.displayName}`} checked={model.enabled} onChange={(enabled) => void api.patch(`/api/models/${model.id}`, { enabled }).then(refresh).catch(toastError)} />
      <MenuButton label={`Actions for ${model.displayName}`} nodes={nodes} className="icon-btn sm">
        <MoreHorizontal size={15} />
      </MenuButton>
    </div>
  );
}

function ConnectionCard({ connection, models, preset, test, onTest, onEdit }: { connection: ConnectionDto; models: CatalogModelDto[]; preset?: ProviderPresetDto; test: TestResult | null; onTest: () => Promise<void>; onEdit: () => void }) {
  const refresh = useRefresh();
  const [testing, setTesting] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [modelDialog, setModelDialog] = useState<{ model?: CatalogModelDto; initial?: DiscoveredModel } | null>(null);
  const [filter, setFilter] = useState('');
  const usesSecret = connection.authType === 'api_key' || connection.authType === 'bearer_token';

  const nodes: MenuNode[] = [
    { id: 'edit', label: 'Edit connection', icon: <Pencil size={15} />, onSelect: onEdit },
    ...(usesSecret ? [{ id: 'key', label: connection.hasSecret ? 'Replace key or token' : 'Add key or token', icon: <KeyRound size={15} />, onSelect: () => setSecretOpen(true) }] : []),
    ...(usesSecret && connection.hasSecret
      ? [{ id: 'clear', label: 'Remove saved key', icon: <KeyRound size={15} />, onSelect: () => void api.delete(`/api/connections/${connection.id}/secret`).then(refresh).catch(toastError) }]
      : []),
    { type: 'separator', id: 'sep' },
    {
      id: 'delete',
      label: 'Delete connection',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () =>
        void (async () => {
          const ok = await confirmDialog({
            title: `Delete ${connection.name}?`,
            message: 'Its models and saved key are removed. Past responses keep their labels.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          await api.delete(`/api/connections/${connection.id}`).catch(toastError);
          refresh();
        })(),
    },
  ];

  const discovered = (test?.models ?? []).filter((m) => !filter || m.apiModelId.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="card">
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <div className="card-title">
            {connection.name}
            <Badge>{ACCESS_TYPE_LABELS[connection.accessType]}</Badge>
          </div>
          <div className="card-sub">
            {PROTOCOL_NAMES[connection.protocol]} · <span className="path">{connection.baseUrl}</span>
          </div>
        </div>
        <div className="card-actions">
          <Button
            size="sm"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              await onTest();
              setTesting(false);
            }}
          >
            {testing ? <Spinner label="Testing" /> : 'Test connection'}
          </Button>
          <MenuButton label={`Actions for ${connection.name}`} nodes={nodes} className="icon-btn" placement="bottom-end">
            <MoreHorizontal size={16} />
          </MenuButton>
        </div>
      </div>

      <div className="status-line">
        <span className={cx('status-dot', connection.status)} aria-hidden="true" />
        <div>
          <strong>{STATUS_LABELS[connection.status]}</strong>
          {connection.statusDetail ? ` — ${connection.statusDetail}` : ''}
          {connection.lastTestedAt && <span className="muted"> · checked {relativeTime(connection.lastTestedAt)}</span>}
        </div>
      </div>

      {usesSecret && (
        <div className="status-line">
          <KeyRound size={13} aria-hidden="true" />
          <span>
            {connection.hasSecret ? 'Key saved in your operating system’s credential store.' : 'No key saved yet.'}{' '}
            <button type="button" className="link-button" onClick={() => setSecretOpen(true)}>
              {connection.hasSecret ? 'Replace' : 'Add key'}
            </button>
          </span>
        </div>
      )}
      {connection.authType === 'token_command' && connection.tokenCommand && (
        <div className="status-line">
          <KeyRound size={13} aria-hidden="true" />
          <span>
            Token from: <span className="path">{connection.tokenCommand.join(' ')}</span>
          </span>
        </div>
      )}
      {connection.status === 'expired' && connection.preset === 'alcf' && (
        <div className="callout warning">
          To reconnect ALCF: in a terminal run <code>python inference_auth_token.py authenticate --force</code> (if asked, log out at app.globus.org/logout first), then press <strong>Test connection</strong>.
        </div>
      )}

      {test && (
        <div className={cx('result-box', test.ok ? 'ok' : 'bad')}>
          {test.detail}
          {test.models.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <input className="input" placeholder="Filter available models" aria-label="Filter available models" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="model-list" style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto' }}>
                {discovered.slice(0, 80).map((m) => (
                  <div key={m.apiModelId} className="model-row">
                    <div className="model-main">
                      <span className="path">{m.apiModelId}</span>
                      {m.contextWindow && <span className="muted">{formatTokens(m.contextWindow)} context</span>}
                    </div>
                    <Button size="sm" disabled={m.alreadyAdded} onClick={() => setModelDialog({ initial: m })}>
                      {m.alreadyAdded ? 'Added' : 'Add'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="card-head" style={{ alignItems: 'center' }}>
          <h3 className="updates-heading" style={{ margin: 0 }}>
            Models
          </h3>
          <Button size="sm" variant="ghost" onClick={() => setModelDialog({})}>
            <Plus size={14} /> Add model ID
          </Button>
        </div>
        {models.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>
            No models yet. Test the connection to list what's available, or add a model ID manually.
          </p>
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <ModelRow key={m.id} model={m} onEdit={() => setModelDialog({ model: m })} />
            ))}
          </div>
        )}
      </div>

      {secretOpen && (
        <SecretDialog
          title={`${connection.hasSecret ? 'Replace' : 'Add'} ${preset?.secretLabel ?? 'key or token'}`}
          label={preset?.secretLabel ?? 'Key or token'}
          onClose={() => setSecretOpen(false)}
          onSave={async (secret) => {
            await api.put(`/api/connections/${connection.id}/secret`, { secret });
            refresh();
            toast('Saved securely. Test the connection to verify it.');
          }}
        />
      )}
      {modelDialog && <ModelDialog connectionId={connection.id} model={modelDialog.model} initial={modelDialog.initial} onClose={() => setModelDialog(null)} />}
    </div>
  );
}

export function ModelsSettings() {
  const connections = useConnections();
  const models = useModels();
  const presets = usePresets();
  const refresh = useRefresh();
  const [dialog, setDialog] = useState<{ connection?: ConnectionDto } | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const runTest = async (id: string): Promise<void> => {
    try {
      const result = await api.post<TestResult>(`/api/connections/${id}/test`);
      setTests((t) => ({ ...t, [id]: result }));
      refresh();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <h1>Models</h1>
      <p className="settings-lead">Connect the model providers you use. Keys and tokens live in your operating system’s credential store, never in Theologians' database or exports.</p>
      <div className="callout">
        <strong>Local-first, plainly.</strong> Your chats, memories, and files are stored on this computer. When you use a cloud model (OpenAI, Anthropic, Gemini, ALCF), the context for that reply — recent messages, a summary of older ones, relevant memory, attachment text, and tool results — is sent to that provider. Local models keep it on this computer.
      </div>
      <div className="callout warning">
        <strong>About subscriptions.</strong> ChatGPT Plus/Pro, Claude Pro/Max, and Google AI Pro subscriptions can't be used by other apps — each provider only permits API keys for apps like this one. Use a paid API key, your ALCF access, or a local model.
      </div>
      <section className="settings-group" aria-label="Connections">
        <div className="card-head">
          <h2>Connections</h2>
          <Button variant="primary" size="sm" onClick={() => setDialog({})}>
            <Plus size={14} /> Add connection
          </Button>
        </div>
        {connections.isPending && <Spinner />}
        {connections.data?.length === 0 && (
          <div className="card">
            <p className="muted">No connections yet. Add one to start chatting.</p>
          </div>
        )}
        {connections.data?.map((c) => (
          <ConnectionCard
            key={c.id}
            connection={c}
            models={(models.data ?? []).filter((m) => m.connectionId === c.id)}
            preset={presets.data?.find((p) => p.key === c.preset)}
            test={tests[c.id] ?? null}
            onTest={() => runTest(c.id)}
            onEdit={() => setDialog({ connection: c })}
          />
        ))}
      </section>
      {dialog && (
        <ConnectionDialog
          presets={presets.data ?? []}
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            refresh();
            if (!dialog.connection) void runTest(id);
          }}
        />
      )}
    </>
  );
}
