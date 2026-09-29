import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ToolSettingsDto, WebSearchProvider } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { toast, toastError } from '../components/toast.tsx';
import { Badge, Button, cx, Segmented, SettingRow, Spinner, Switch } from '../components/ui.tsx';
import { useToolSettings } from '../lib/queries.ts';
import { SecretDialog, SettingsGroup } from './common.tsx';

export function ToolsSettings() {
  const queryClient = useQueryClient();
  const settings = useToolSettings();
  const [keyDialog, setKeyDialog] = useState<WebSearchProvider | null>(null);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [timeout, setTimeoutValue] = useState<string | null>(null);

  const apply = (data: ToolSettingsDto): void => {
    queryClient.setQueryData(['toolSettings'], data);
    void queryClient.invalidateQueries({ queryKey: ['conversation'] });
  };
  const update = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      apply(await api.patch<ToolSettingsDto>('/api/tools/settings', patch));
    } catch (err) {
      toastError(err);
    }
  };

  const s = settings.data;
  if (!s) return <Spinner />;
  const provider = s.webSearchProvider;

  return (
    <>
      <h1>Tools & pertheologians</h1>
      <p className="settings-lead">Tools only run when a chat turns them on, the assistant is allowed to use them, and the selected model supports tool calling. Web pages, files, and tool output are treated as data — never as instructions.</p>

      <SettingsGroup title="Web search">
        <div className="card">
          <SettingRow
            title="Search provider"
            hint="Theologians calls the search API itself, so links shown as Sources are real results — not links a model made up."
            control={
              <Segmented<'tavily' | 'brave'>
                label="Search provider"
                size="sm"
                value={provider ?? 'tavily'}
                onChange={(v) => void update({ webSearchProvider: v })}
                options={[
                  { value: 'tavily', label: 'Tavily' },
                  { value: 'brave', label: 'Brave' },
                ]}
              />
            }
          />
          <div className="hint muted" style={{ fontSize: 12.5 }}>
            {(provider ?? 'tavily') === 'tavily'
              ? 'Tavily: 1,000 free searches a month without a card; get a key at tavily.com.'
              : 'Brave Search API: paid, with a monthly $5 credit (card required); get a key at brave.com/search/api.'}
          </div>
          <SettingRow
            title="API key"
            hint={s.webSearchHasKey && provider ? 'Saved in your operating system’s credential store.' : 'No key saved for this provider.'}
            control={
              <>
                <Button size="sm" onClick={() => setKeyDialog(provider ?? 'tavily')}>
                  {s.webSearchHasKey ? 'Replace key' : 'Add key'}
                </Button>
                {s.webSearchHasKey && provider && (
                  <Button size="sm" variant="ghost" onClick={() => void api.delete<ToolSettingsDto>(`/api/tools/web-search/key?provider=${provider}`).then(apply).catch(toastError)}>
                    Remove
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!s.webSearchHasKey || testing}
                  onClick={async () => {
                    setTesting(true);
                    try {
                      setTest(await api.post('/api/tools/web-search/test'));
                    } catch (err) {
                      toastError(err);
                    } finally {
                      setTesting(false);
                    }
                  }}
                >
                  {testing ? <Spinner label="Testing" /> : 'Test'}
                </Button>
              </>
            }
          />
          {test && <div className={cx('result-box', test.ok ? 'ok' : 'bad')}>{test.detail}</div>}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Files and commands">
        <div className="card">
          <SettingRow
            title="Sandbox"
            hint="Commands use the native sandbox on macOS or Linux: writes are limited to the working folder and private credentials are blocked. Windows keeps commands disabled."
            control={s.sandboxAvailable ? <Badge tone="success">Available</Badge> : <Badge tone="danger">Unavailable — commands disabled</Badge>}
          />
          <SettingRow
            title="Every command and file edit asks first"
            hint="You see the exact command, or a diff of the file change, and approve it before anything runs or is written."
            control={<Badge>Always on</Badge>}
          />
          <SettingRow
            title="Allow network access for commands"
            hint="Off by default. Turn on if you want commands like package installs to reach the internet."
            control={<Switch label="Allow network access for commands" checked={s.commandNetwork} onChange={(v) => void update({ commandNetwork: v })} />}
          />
          <SettingRow
            title="Command time limit"
            hint="Commands are stopped after this many seconds (5–600)."
            control={
              <input
                className="input"
                style={{ width: 90 }}
                inputMode="numeric"
                aria-label="Command time limit in seconds"
                value={timeout ?? String(s.commandTimeoutSeconds)}
                onChange={(e) => setTimeoutValue(e.target.value.replace(/\D/g, ''))}
                onBlur={() => {
                  if (timeout === null) return;
                  const value = Math.max(5, Math.min(600, Number(timeout) || 60));
                  setTimeoutValue(null);
                  void update({ commandTimeoutSeconds: value });
                }}
              />
            }
          />
          <SettingRow
            title="Reading outside the working folder"
            hint="Private locations (Theologians' data and SSH, cloud, and OS credentials) are never readable, whatever this is set to."
            control={
              <Segmented<'ask' | 'deny'>
                label="Reading outside the working folder"
                size="sm"
                value={s.outsideFolderAccess}
                onChange={(v) => void update({ outsideFolderAccess: v })}
                options={[
                  { value: 'ask', label: 'Ask each time' },
                  { value: 'deny', label: 'Never' },
                ]}
              />
            }
          />
        </div>
      </SettingsGroup>

      {keyDialog && (
        <SecretDialog
          title={`${keyDialog === 'tavily' ? 'Tavily' : 'Brave Search'} API key`}
          label="API key"
          onClose={() => setKeyDialog(null)}
          onSave={async (key) => {
            apply(await api.put<ToolSettingsDto>('/api/tools/web-search/key', { provider: keyDialog, key }));
            await update({ webSearchProvider: keyDialog });
            toast('Search key saved. Press Test to check it.');
          }}
        />
      )}
    </>
  );
}
