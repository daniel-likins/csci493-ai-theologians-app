import { Spinner } from '../components/ui.tsx';
import { formatDateTime, formatTokens } from '../lib/format.ts';
import { useUsage } from '../lib/queries.ts';
import { SettingsGroup } from './common.tsx';

const PURPOSES: Record<string, string> = {
  chat: 'Chat replies',
  summary: 'Summaries of long chats',
  memory_suggestions: 'Memory suggestions',
  checkin: 'Check-ins',
  connection_test: 'Connection tests',
  web_search: 'Web searches',
};

export function UsageSettings() {
  const usage = useUsage();
  const data = usage.data;
  return (
    <>
      <h1>Usage</h1>
      <p className="settings-lead">
        Every model call and web search Theologians makes for you. Models are called when you send a message, when a long chat needs a summary to fit, when you test a connection, and for memory suggestions (limited). Nothing runs on a timer
        in the background. Token counts come from the provider when it reports them; otherwise they are estimates, marked ≈.
      </p>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <SettingsGroup title="Last 30 days">
            <div className="card">
              {data.rows.length === 0 ? (
                <p className="muted">No usage yet.</p>
              ) : (
                <table className="simple">
                  <thead>
                    <tr>
                      <th>Purpose</th>
                      <th className="num">Calls</th>
                      <th className="num">Input tokens</th>
                      <th className="num">Output tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.purpose}>
                        <td>{PURPOSES[r.purpose] ?? r.purpose}</td>
                        <td className="num">{r.calls}</td>
                        <td className="num">
                          {r.estimated ? '≈' : ''}
                          {formatTokens(r.inputTokens)}
                        </td>
                        <td className="num">
                          {r.estimated ? '≈' : ''}
                          {formatTokens(r.outputTokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </SettingsGroup>
          <SettingsGroup title="Recent activity">
            <div className="card">
              {data.recent.length === 0 ? (
                <p className="muted">Nothing yet.</p>
              ) : (
                <table className="simple">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Purpose</th>
                      <th>Model</th>
                      <th className="num">Tokens in / out</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r, i) => (
                      <tr key={i} title={r.detail ?? undefined}>
                        <td>{formatDateTime(r.createdAt)}</td>
                        <td>{PURPOSES[r.purpose] ?? r.purpose}</td>
                        <td>{r.modelLabel ?? '—'}</td>
                        <td className="num">
                          {r.estimated ? '≈' : ''}
                          {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
                        </td>
                        <td>{r.status === 'ok' ? 'OK' : r.status === 'cancelled' ? 'Stopped' : 'Error'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </SettingsGroup>
        </>
      )}
    </>
  );
}
