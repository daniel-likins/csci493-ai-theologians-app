import { api, isDesktopShell } from '../api/client.ts';
import { confirmDialog } from '../components/Dialog.tsx';
import { toast, toastError } from '../components/toast.tsx';
import { Button, SettingRow, Spinner } from '../components/ui.tsx';
import { formatDateTime } from '../lib/format.ts';
import { useSystemInfo } from '../lib/queries.ts';
import { SettingsGroup } from './common.tsx';

export function AboutSettings() {
  const info = useSystemInfo();
  const i = info.data;
  const url = i ? `http://127.0.0.1:${i.port}` : '';
  return (
    <>
      <h1>About & service</h1>
      {!i ? (
        <Spinner />
      ) : (
        <>
          <SettingsGroup title="How Theologians runs">
            <div className="card">
              <p style={{ lineHeight: 1.6 }}>
                Theologians is a small service running only on this computer at <span className="path">{url}</span>. The desktop app on macOS and any browser tabs are windows onto that same service and the same data — nothing is duplicated, and changes in one window appear in
                the others.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: 'var(--text-2)', fontSize: 13 }}>
                <li>Opening the desktop app starts the service if it isn't already running.</li>
                <li>“Open in browser” opens the same app in your default browser.</li>
                <li>
                  {i.idleShutdownMinutes
                    ? `With no windows open, the service stops on its own after ${i.idleShutdownMinutes} minutes.`
                    : 'This service was started from a terminal and runs until you stop it (Ctrl+C or the button below).'}
                </li>
                <li>Everything is saved as you go, so closing windows, quitting, or restarting never loses saved work. A reply still being written when the service stops keeps its text and is marked interrupted.</li>
                <li>The service accepts connections only from this computer, and only from Theologians' own pages.</li>
              </ul>
              <div className="card-actions">
                {!isDesktopShell && <span className="muted">You're viewing Theologians in a browser.</span>}
                <Button size="sm" onClick={() => void api.post('/api/system/open-browser').catch(toastError)}>
                  Open in browser
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    void (async () => {
                      const ok = await confirmDialog({
                        title: 'Stop the Theologians service?',
                        message: 'Open windows will disconnect until you open Theologians again. Saved work is not affected.',
                        confirmLabel: 'Stop service',
                        danger: true,
                      });
                      if (!ok) return;
                      await api.post('/api/system/shutdown').catch(toastError);
                      toast('The service is stopping.');
                    })()
                  }
                >
                  Stop service
                </Button>
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup title="Details">
            <div className="card">
              <SettingRow title="Version" control={<span className="path">{i.version}</span>} />
              <SettingRow title="Data version" control={<span className="path">{i.schemaVersion}</span>} />
              <SettingRow title="Running since" control={<span>{formatDateTime(i.startedAt)}</span>} />
              <SettingRow title="Open windows and tabs" control={<span>{i.openViews}</span>} />
              <SettingRow title="Credentials stored in" control={<span>{i.secretStore}</span>} />
              <SettingRow title="Database" hint={<span className="path">{i.dbFile}</span>} control={null} />
              {i.mode !== 'production' && <SettingRow title="Mode" control={<span className="path">{i.mode}</span>} />}
            </div>
          </SettingsGroup>
        </>
      )}
    </>
  );
}
