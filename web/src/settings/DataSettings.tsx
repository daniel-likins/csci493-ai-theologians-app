import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { ImportPreviewDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { confirmDialog, Dialog } from '../components/Dialog.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { Button, SettingRow, Spinner, Switch } from '../components/ui.tsx';
import { formatBytes, formatDateTime, relativeTime } from '../lib/format.ts';
import { useBackups, useSystemInfo } from '../lib/queries.ts';
import { SettingsGroup } from './common.tsx';

const REASONS: Record<string, string> = {
  automatic: 'Automatic',
  manual: 'Manual',
  before_restore: 'Before restore',
  before_import: 'Before import',
  before_migration: 'Before upgrade',
};

const TABLE_LABELS: Record<string, string> = {
  conversations: 'Conversations',
  messages: 'Messages',
  folders: 'Folders',
  memory_items: 'Memory items',
  memory_changes: 'Memory history',
  memory_proposals: 'Memory suggestions',
  attachments: 'Attachments',
  assistant_profiles: 'Assistant settings',
  provider_connections: 'Model connections',
  models: 'Models',
  workspaces: 'Theologians',
  preferences: 'Preferences',
};

function reveal(target: string): void {
  void api.post('/api/system/reveal', { target }).catch(toastError);
}

export function DataSettings() {
  const queryClient = useQueryClient();
  const backups = useBackups();
  const info = useSystemInfo();
  const [busy, setBusy] = useState<string | null>(null);
  const [exported, setExported] = useState<{ path: string; sizeBytes: number } | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    try {
      return await action();
    } catch (err) {
      toastError(err);
      return undefined;
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
    }
  };

  const s = backups.data?.settings;

  const apply = async (mode: 'merge' | 'replace'): Promise<void> => {
    if (!preview) return;
    if (mode === 'replace') {
      const ok = await confirmDialog({
        title: 'Replace all current data?',
        message: 'Everything in Theologians will be replaced with the contents of this export. A safety backup of your current data is made first, so you can restore it if needed. Saved API keys are not touched.',
        confirmLabel: 'Replace everything',
        danger: true,
      });
      if (!ok) return;
    }
    const result = await run('import', () => api.post<{ imported: Record<string, number>; skipped: Record<string, number> }>(`/api/import/${preview.token}/apply`, { mode }));
    if (result) {
      setPreview(null);
      const skipped = Object.values(result.skipped).reduce((a, b) => a + b, 0);
      toast(`Import finished.${skipped ? ` ${skipped} existing record(s) were kept unchanged.` : ''}`);
      void queryClient.invalidateQueries();
    }
  };

  return (
    <>
      <h1>Data & backups</h1>
      <p className="settings-lead">Everything Theologians saves lives in one folder on this computer. Credentials are kept separately in secure OS storage and are never included in backups or exports.</p>

      <SettingsGroup title="Where your data lives">
        <div className="card">
          <SettingRow title="Data folder" hint={<span className="path">{info.data?.dataDir ?? '…'}</span>} control={info.data && <Button size="sm" onClick={() => reveal(info.data!.dataDir)}>Show in file manager</Button>} />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Backups">
        {!s ? (
          <Spinner />
        ) : (
          <div className="card">
            <div className="callout warning">
              <strong>Backups on the same disk don't protect against losing that disk.</strong> They help with mistakes and damaged files. To be safe from a lost or failed computer, choose a backup folder on an external drive or in a folder that syncs to cloud storage.
              {s.isDefaultDirectory && ' Backups currently go to the default folder on this computer.'}
            </div>
            <SettingRow
              title="Backup folder"
              hint={<span className="path">{s.directory}</span>}
              control={
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      void run('folder', async () => {
                        const result = await api.post<{ path: string | null }>('/api/system/choose-folder', { prompt: 'Choose a folder for Theologians backups' });
                        if (result.path) await api.patch('/api/backups/settings', { directory: result.path });
                      })
                    }
                  >
                    Change…
                  </Button>
                  {!s.isDefaultDirectory && (
                    <Button size="sm" variant="ghost" onClick={() => void run('folder', () => api.patch('/api/backups/settings', { directory: null }))}>
                      Use default
                    </Button>
                  )}
                </>
              }
            />
            <SettingRow
              title="Automatic backups"
              hint={`About once a day while Theologians is running. ${s.retention}`}
              control={<Switch label="Automatic backups" checked={s.automatic} onChange={(v) => void run('auto', () => api.patch('/api/backups/settings', { automatic: v }))} />}
            />
            <SettingRow
              title="Last backup"
              hint={s.lastBackupError ? <span style={{ color: 'var(--danger)' }}>{s.lastBackupError}</span> : s.lastBackupAt ? `${formatDateTime(s.lastBackupAt)} (${relativeTime(s.lastBackupAt)})` : 'No backups yet.'}
              control={
                <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void run('backup', () => api.post('/api/backups')).then((r) => r && toast('Backup created'))}>
                  {busy === 'backup' ? <Spinner label="Backing up" /> : 'Back up now'}
                </Button>
              }
            />
            {(backups.data?.backups.length ?? 0) > 0 && (
              <table className="simple">
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Type</th>
                    <th className="num">Database</th>
                    <th className="num">Files</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {backups.data!.backups.map((b) => (
                    <tr key={b.id}>
                      <td>{formatDateTime(b.createdAt)}</td>
                      <td>{REASONS[b.reason] ?? b.reason}</td>
                      <td className="num">{formatBytes(b.sizeBytes)}</td>
                      <td className="num">{b.attachmentCount}</td>
                      <td className="num">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() =>
                            void (async () => {
                              const ok = await confirmDialog({
                                title: 'Restore this backup?',
                                message: `Your current data will be replaced by the backup from ${formatDateTime(b.createdAt)}. A safety backup of the current data is made first.`,
                                confirmLabel: 'Restore',
                                danger: true,
                              });
                              if (!ok) return;
                              const result = await run('restore', () => api.post<{ missingAttachments: number }>(`/api/backups/${b.id}/restore`));
                              if (result) {
                                toast(result.missingAttachments ? `Restored, but ${result.missingAttachments} attachment file(s) were missing.` : 'Backup restored');
                                void queryClient.invalidateQueries();
                              }
                            })()
                          }
                        >
                          Restore
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="card-actions">
              <Button size="sm" variant="ghost" onClick={() => reveal(s.directory)}>
                Show backups in file manager
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Export and import">
        <div className="card">
          <SettingRow
            title="Export everything"
            hint="A .zip with conversations, folders, memories and their history, assistant settings, preferences, and attachments. Never includes API keys or tokens."
            control={
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run('export', () => api.post<{ path: string; sizeBytes: number }>('/api/export')).then((r) => {
                    if (r) setExported(r);
                  })
                }
              >
                {busy === 'export' ? <Spinner label="Exporting" /> : 'Export…'}
              </Button>
            }
          />
          {exported && (
            <div className="result-box ok">
              Saved {formatBytes(exported.sizeBytes)} to <span className="path">{exported.path}</span>{' '}
              <button type="button" className="link-button" onClick={() => reveal(exported.path)}>
                Show in file manager
              </button>
            </div>
          )}
          <SettingRow
            title="Import an export"
            hint="You'll see what's inside before anything changes. Merge adds what's missing and never overwrites; Replace makes Theologians match the export. A safety backup is made first either way."
            control={
              <>
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('preview', async () => {
                      const chosen = await api.post<{ path: string | null }>('/api/system/choose-file', { prompt: 'Choose a Theologians export (.zip)' });
                      if (chosen.path) setPreview(await api.post<ImportPreviewDto>('/api/import/preview-path', { filePath: chosen.path }));
                    })
                  }
                >
                  Choose file…
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                  Upload…
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip,application/zip"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void run('preview', async () => setPreview(await api.upload<ImportPreviewDto>('/api/import/preview', file, 'application/zip')));
                  }}
                />
              </>
            }
          />
        </div>
      </SettingsGroup>

      {preview && (
        <Dialog
          open
          size="lg"
          title="Review import"
          onClose={() => {
            void api.delete(`/api/import/${preview.token}`).catch(() => undefined);
            setPreview(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  void api.delete(`/api/import/${preview.token}`).catch(() => undefined);
                  setPreview(null);
                }}
              >
                Cancel
              </Button>
              <Button disabled={busy !== null} onClick={() => void apply('merge')}>
                Merge (keep existing)
              </Button>
              <Button variant="danger-solid" disabled={busy !== null} onClick={() => void apply('replace')}>
                Replace everything…
              </Button>
            </>
          }
        >
          <p style={{ marginBottom: 12 }}>
            Export from {formatDateTime(preview.createdAt)} (Theologians {preview.appVersion}, data version {preview.schemaVersion}).
          </p>
          <table className="simple">
            <thead>
              <tr>
                <th>Contents</th>
                <th className="num">In export</th>
                <th className="num">Already here</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.counts)
                .filter(([table]) => TABLE_LABELS[table])
                .map(([table, count]) => (
                  <tr key={table}>
                    <td>{TABLE_LABELS[table]}</td>
                    <td className="num">{count}</td>
                    <td className="num">{preview.conflicts[table] ?? 0}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {preview.warnings.map((w) => (
            <p key={w} className="callout warning" style={{ marginTop: 10 }}>
              {w}
            </p>
          ))}
        </Dialog>
      )}
    </>
  );
}
