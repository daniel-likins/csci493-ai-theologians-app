import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import type { ProfileDto, ProfileKind, ToolGroup } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { confirmDialog, promptDialog } from '../components/Dialog.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { Button, cx, Field, Spinner } from '../components/ui.tsx';
import { useModels, useProfiles, useWorkspaces } from '../lib/queries.ts';
import { TOOL_GROUP_LABELS } from './common.tsx';

const PERMISSIONS: Record<ProfileKind, string> = {
  general:
    "Sees the theologian's name and description (and current focus, if enabled for that theologian). It can't read personal memory or change anything saved.",
  goals:
    "Answers in this theologian's voice and reads the study notes saved with him. It can suggest memory changes, which follow that theologian's approval or autosave setting. It can't see other theologians.",
  master:
    "Reads saved memory from every theologian, read-only. It has no way to change any theologian's study notes — the app enforces this regardless of these instructions or which model is used.",
};

type Editable = Pick<ProfileDto, 'name' | 'description' | 'instructions' | 'personality' | 'tone' | 'verbosity' | 'responseStructure' | 'preferredModelId' | 'tools'>;

function pick(p: ProfileDto): Editable {
  return {
    name: p.name,
    description: p.description,
    instructions: p.instructions,
    personality: p.personality,
    tone: p.tone,
    verbosity: p.verbosity,
    responseStructure: p.responseStructure,
    preferredModelId: p.preferredModelId,
    tools: p.tools,
  };
}

function ProfileEditor({ profile }: { profile: ProfileDto }) {
  const queryClient = useQueryClient();
  const models = useModels();
  const [form, setForm] = useState<Editable>(() => pick(profile));
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(profile));
  const set = <K extends keyof Editable>(key: K, value: Editable[K]): void => setForm({ ...form, [key]: value });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['profiles'] });
    void queryClient.invalidateQueries({ queryKey: ['conversation'] });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const updated = await api.patch<ProfileDto>(`/api/profiles/${profile.id}`, form);
      setForm(pick(updated));
      refresh();
      toast('Saved. Changes apply to future replies; past messages stay as they were.');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const text = (key: 'instructions' | 'personality' | 'tone' | 'verbosity' | 'responseStructure', label: string, rows: number, hint?: string) => (
    <Field label={label} htmlFor={`${profile.id}-${key}`} hint={hint}>
      <textarea id={`${profile.id}-${key}`} className="textarea" rows={rows} value={form[key]} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );

  return (
    <div className="settings-group" style={{ paddingTop: 4 }}>
      <div className="field-grid">
        <Field label="Name" htmlFor={`${profile.id}-name`}>
          <input id={`${profile.id}-name`} className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Model" htmlFor={`${profile.id}-model`} hint={profile.kind === 'general' ? 'Used when this assistant is picked in a chat.' : 'Used for this assistant everywhere, including memory suggestions.'}>
          <select id={`${profile.id}-model`} className="select" value={form.preferredModelId ?? ''} onChange={(e) => set('preferredModelId', e.target.value || null)}>
            <option value="">Not set</option>
            {(models.data ?? [])
              .filter((m) => m.enabled || m.id === form.preferredModelId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} — {m.connectionName}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <Field label="Short description" htmlFor={`${profile.id}-desc`}>
        <input id={`${profile.id}-desc`} className="input" value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      {text('instructions', 'Instructions', 8, profile.kind === 'general' ? undefined : '{mission} (the theologian’s name), {description}, and {missions} (all three names) are filled in automatically.')}
      <div className="field-grid">
        {text('personality', 'Personality', 3)}
        {text('tone', 'Tone', 3)}
        {text('verbosity', 'Length and detail', 3)}
        {text('responseStructure', 'Response structure', 3)}
      </div>
      <div className="field">
        <label>Tools this assistant may use</label>
        <div className="check-grid">
          {profile.allowedTools.map((group) => (
            <label key={group} className="checkbox-row" title={TOOL_GROUP_LABELS[group]?.description}>
              <input
                type="checkbox"
                checked={form.tools.includes(group)}
                onChange={(e) => set('tools', e.target.checked ? [...form.tools, group] : form.tools.filter((t: ToolGroup) => t !== group))}
              />
              <span>
                {TOOL_GROUP_LABELS[group]?.label ?? group}
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  {TOOL_GROUP_LABELS[group]?.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="callout teal">
        <strong>Data access (set by the app):</strong> {PERMISSIONS[profile.kind]}
      </div>
      <div className="card-actions">
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          Save changes
        </Button>
        {dirty && <Button onClick={() => setForm(pick(profile))}>Discard</Button>}
        <span className="spacer" />
        {profile.canReset && (
          <Button
            variant="ghost"
            onClick={() =>
              void (async () => {
                if (!(await confirmDialog({ title: `Reset ${profile.name} to default?`, message: 'Instructions, personality, tone, length, structure, and tools return to their defaults. The chosen model is kept. Past messages are not changed.', confirmLabel: 'Reset' }))) return;
                try {
                  const updated = await api.post<ProfileDto>(`/api/profiles/${profile.id}/reset`);
                  setForm(pick(updated));
                  refresh();
                } catch (err) {
                  toastError(err);
                }
              })()
            }
          >
            Reset to default
          </Button>
        )}
        {!profile.defaultKey && (
          <Button
            variant="danger"
            onClick={() =>
              void (async () => {
                if (!(await confirmDialog({ title: `Delete ${profile.name}?`, message: 'Past responses keep their labels.', confirmLabel: 'Delete', danger: true }))) return;
                await api.delete(`/api/profiles/${profile.id}`).catch(toastError);
                refresh();
              })()
            }
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function ProfileCard({ profile, subtitle }: { profile: ProfileDto; subtitle: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button type="button" className="card-head link-like" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', color: 'inherit', width: '100%' }}>
        <div style={{ minWidth: 0 }}>
          <div className="card-title">{profile.name}</div>
          <div className="card-sub">{subtitle}</div>
        </div>
        <ChevronRight size={16} className={cx('chev', open && 'open')} aria-hidden="true" />
      </button>
      {open && <ProfileEditor key={profile.id} profile={profile} />}
    </div>
  );
}

export function AssistantsSettings() {
  const queryClient = useQueryClient();
  const profiles = useProfiles();
  const models = useModels();
  const workspaces = useWorkspaces();
  const modelName = (id: string | null): string => (id ? (models.data?.find((m) => m.id === id)?.displayName ?? 'missing model') : 'no model set');
  const list = profiles.data ?? [];
  const wsName = (id: string | null): string => workspaces.data?.workspaces.find((w) => w.id === id)?.name ?? '';

  return (
    <>
      <h1>Assistants</h1>
      <p className="settings-lead">Adjust how each assistant thinks and writes. Edits apply to future replies and never rewrite past messages or memory. What each assistant may access is fixed by the app.</p>
      {profiles.isPending && <Spinner />}
      <section className="settings-group" aria-label="General assistants">
        <div className="card-head">
          <h2>General assistants</h2>
          <Button
            size="sm"
            onClick={() =>
              void (async () => {
                const name = await promptDialog({ title: 'New assistant', label: 'Name', confirmLabel: 'Create' });
                if (!name) return;
                try {
                  await api.post('/api/profiles', { name });
                  void queryClient.invalidateQueries({ queryKey: ['profiles'] });
                } catch (err) {
                  toastError(err);
                }
              })()
            }
          >
            <Plus size={14} /> New assistant
          </Button>
        </div>
        {list
          .filter((p) => p.kind === 'general')
          .map((p) => (
            <ProfileCard key={p.id} profile={p} subtitle={`${p.description || 'General assistant'} · ${modelName(p.preferredModelId)}`} />
          ))}
      </section>
      <section className="settings-group" aria-label="Theologians">
        <h2>Theologians</h2>
        {list
          .filter((p) => p.kind === 'goals')
          .map((p) => (
            <ProfileCard key={p.id} profile={p} subtitle={`${wsName(p.workspaceId)} theologian · ${modelName(p.preferredModelId)}`} />
          ))}
      </section>
      <section className="settings-group" aria-label="Round Table">
        <h2>Home</h2>
        {list
          .filter((p) => p.kind === 'master')
          .map((p) => (
            <ProfileCard key={p.id} profile={p} subtitle={`Advisory only · ${modelName(p.preferredModelId)}`} />
          ))}
      </section>
    </>
  );
}
