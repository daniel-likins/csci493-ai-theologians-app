import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CheckinFrequency, GeneralContext, HistoryAccess, WorkspaceDto, WorkspaceSettingsDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { toast, toastError } from '../components/toast.tsx';
import { Button, Field, Segmented, SettingRow, Spinner, Switch } from '../components/ui.tsx';
import { useProfiles, useModels, useWorkspaceSettings, useWorkspaces } from '../lib/queries.ts';

function MissionCard({ workspace }: { workspace: WorkspaceDto }) {
  const queryClient = useQueryClient();
  const settings = useWorkspaceSettings(workspace.id);
  const profiles = useProfiles();
  const models = useModels();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description);
  const goals = profiles.data?.find((p) => p.kind === 'goals' && p.workspaceId === workspace.id);
  const goalsModel = models.data?.find((m) => m.id === goals?.preferredModelId);

  const update = async (patch: Partial<WorkspaceSettingsDto>): Promise<void> => {
    try {
      await api.patch(`/api/workspaces/${workspace.id}/settings`, patch);
      void queryClient.invalidateQueries({ queryKey: ['workspaceSettings', workspace.id] });
      void queryClient.invalidateQueries({ queryKey: ['memory', workspace.id] });
    } catch (err) {
      toastError(err);
    }
  };

  const s = settings.data;
  return (
    <section className="card" aria-label={`${workspace.name} settings`}>
      <div className="card-title">{workspace.name}</div>
      <div className="field-grid">
        <Field label="Name" htmlFor={`${workspace.id}-name`}>
          <input id={`${workspace.id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor={`${workspace.id}-desc`} hint="General assistants see this short description.">
          <input id={`${workspace.id}-desc`} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      {(name !== workspace.name || description !== workspace.description) && (
        <div className="card-actions">
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              void api
                .patch(`/api/workspaces/${workspace.id}`, { name, description })
                .then(() => {
                  void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
                  toast('Theologian updated');
                })
                .catch(toastError)
            }
          >
            Save name and description
          </Button>
        </div>
      )}
      {!s ? (
        <Spinner />
      ) : (
        <>
          <SettingRow
            title="Suggest memory updates"
            hint={`After ${workspace.name} conversations, ${goals?.name ?? 'the Goals assistant'}${goalsModel ? ` (${goalsModel.displayName})` : ' — no model set yet —'} reviews new messages and suggests changes. Limited to once every 30 minutes per chat and 12 times a day. Chats that used a different provider are only reviewed when you ask.`}
            control={<Switch label="Suggest memory updates" checked={s.memorySuggestions} onChange={(v) => void update({ memorySuggestions: v })} />}
          />
          <SettingRow
            title="Autosave important updates"
            hint="Off by default. When on, important additions and edits save without asking and appear in history with undo. Removals, and anything marked confirmed without your own words to back it, still ask."
            control={<Switch label="Autosave important memory updates" checked={s.memoryAutosave} onChange={(v) => void update({ memoryAutosave: v })} />}
          />
          <SettingRow
            title="Study access to past chats"
            hint="Whether the theologian may search this theologian's earlier conversations when it would help."
            control={
              <Segmented<HistoryAccess>
                label="Study access to past chats"
                size="sm"
                value={s.historyAccess}
                onChange={(v) => void update({ historyAccess: v })}
                options={[
                  { value: 'search', label: 'Search when useful' },
                  { value: 'none', label: 'Memory only' },
                ]}
              />
            }
          />
          <SettingRow
            title="What general assistants see"
            hint="Ordinary chats get a little theologian context, never your personal memory."
            control={
              <select className="select" style={{ width: 230 }} value={s.generalContext} aria-label="What general assistants see" onChange={(e) => void update({ generalContext: e.target.value as GeneralContext })}>
                <option value="description_and_focus">Description and current focus</option>
                <option value="description">Description only</option>
                <option value="none">Nothing</option>
              </select>
            }
          />
          <SettingRow
            title="Gentle check-ins"
            hint="A quiet prompt in the Study panel to reflect. In the app only — no notifications, no streaks."
            control={
              <select className="select" style={{ width: 170 }} value={s.checkinFrequency} aria-label="Check-in frequency" onChange={(e) => void update({ checkinFrequency: e.target.value as CheckinFrequency })}>
                <option value="off">Off</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every two weeks</option>
                <option value="monthly">Monthly</option>
              </select>
            }
          />
          <SettingRow
            title="Working folder"
            hint={s.workingFolder ? <span className="path">{s.workingFolder}</span> : 'File tools and commands in this theologian only work inside a folder you choose.'}
            control={
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    void api
                      .post<{ path: string | null }>('/api/system/choose-folder', { prompt: `Choose a working folder for ${workspace.name}` })
                      .then((r) => (r.path ? update({ workingFolder: r.path }) : undefined))
                      .catch(toastError)
                  }
                >
                  {s.workingFolder ? 'Change…' : 'Choose…'}
                </Button>
                {s.workingFolder && (
                  <Button size="sm" variant="ghost" onClick={() => void update({ workingFolder: null })}>
                    Clear
                  </Button>
                )}
              </>
            }
          />
        </>
      )}
    </section>
  );
}

export function MissionsSettings() {
  const workspaces = useWorkspaces();
  return (
    <>
      <h1>Theologians</h1>
      <p className="settings-lead">How each theologian handles memory, context, check-ins, and files. Theologians are stored as data, so more sections and workspaces can be added later without changing the app.</p>
      {workspaces.isPending && <Spinner />}
      {workspaces.data?.workspaces.map((w) => <MissionCard key={w.id} workspace={w} />)}
    </>
  );
}
