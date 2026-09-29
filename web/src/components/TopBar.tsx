import { ChevronDown, CloudOff, ExternalLink, House, PanelLeft, PanelRight, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GOALS_PANEL_DEFAULT, SIDEBAR_DEFAULT, type PanelPrefs } from '../App.tsx';
import { api, isDesktopShell } from '../api/client.ts';
import type { LiveState } from '../api/events.ts';
import { formatClock, formatLongDate } from '../lib/format.ts';
import { usePreference } from '../lib/prefs.ts';
import { useWeather, useWorkspaces } from '../lib/queries.ts';
import { navigate, paths, type Route } from '../lib/router.ts';
import { shortcut } from '../lib/shortcuts.ts';
import { MenuButton, type MenuNode } from './Menu.tsx';
import { toastError } from './toast.tsx';
import { IconButton } from './ui.tsx';

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = (): void => setNow(new Date());
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time className="clock" dateTime={now.toISOString()}>
      <span>{formatClock(now)}</span>
      <span className="clock-sep" aria-hidden="true">
        ·
      </span>
      <span>{formatLongDate(now)}</span>
    </time>
  );
}

function Weather() {
  const { data } = useWeather();
  if (!data || data.status === 'disabled') return null;
  if (data.status === 'unavailable') {
    return (
      <span className="weather muted" title={data.reason} aria-label={data.reason}>
        <CloudOff size={14} aria-hidden="true" />
      </span>
    );
  }
  const unit = data.units === 'celsius' ? 'C' : 'F';
  const updated = new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const title = `${data.locationName}: ${data.description}, ${data.temperature}°${unit}. Updated ${updated}${data.stale ? ' — may be out of date' : ''}. Weather from Open-Meteo.`;
  return (
    <span className="weather" title={title} aria-label={title}>
      <span>
        {data.temperature}°{unit}
      </span>
      <span className="weather-desc">{data.description}</span>
    </span>
  );
}

export function TopBar({ route, live }: { route: Route; live: LiveState }) {
  const workspaces = useWorkspaces();
  const [sidebar, setSidebar] = usePreference<PanelPrefs>('ui.sidebar', SIDEBAR_DEFAULT);
  const [panel, setPanel] = usePreference('ui.goalsPanel', GOALS_PANEL_DEFAULT);
  const missions = workspaces.data?.workspaces ?? [];
  const mission = route.name === 'mission' ? missions.find((w) => w.slug === route.slug) : undefined;

  const switcherNodes: MenuNode[] = [
    ...missions.map((w) => ({
      id: w.id,
      label: w.name,
      description: w.description,
      checked: w.id === mission?.id,
      onSelect: () => navigate(paths.mission(w.slug)),
    })),
    { type: 'separator' as const, id: 'sep' },
    { id: 'home', label: 'Home', icon: <House size={15} />, onSelect: () => navigate(paths.home()) },
  ];

  return (
    <header className="topbar">
      <div className="topbar-left">
        {route.name === 'mission' ? (
          <>
            <IconButton label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'} shortcut={shortcut('B')} onClick={() => setSidebar({ ...sidebar, open: !sidebar.open })}>
              <PanelLeft size={18} />
            </IconButton>
            <MenuButton label="Switch theologian" nodes={switcherNodes} className="mission-switcher" menuClassName="switcher-menu">
              <span>{mission?.name ?? 'Theologian'}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </MenuButton>
          </>
        ) : route.name === 'home' ? (
          <span className="wordmark">Theologians</span>
        ) : (
          <button type="button" className="wordmark wordmark-link" onClick={() => navigate(paths.home())}>
            Theologians
          </button>
        )}
      </div>
      <div className="topbar-right">
        {live !== 'open' && (
          <span className="live-status" role="status">
            {live === 'connecting' ? 'Connecting…' : 'Reconnecting to the local service…'}
          </span>
        )}
        <Weather />
        <Clock />
        {isDesktopShell && (
          <IconButton
            label="Open in browser"
            onClick={() => void api.post('/api/system/open-browser').catch(toastError)}
          >
            <ExternalLink size={16} />
          </IconButton>
        )}
        {route.name === 'mission' && mission?.hasGoals && (
          <IconButton
            label={panel.open ? 'Hide study notes' : 'Show study notes'}
            shortcut={shortcut('J')}
            pressed={panel.open}
            onClick={() => setPanel({ ...panel, open: !panel.open })}
          >
            <PanelRight size={18} />
          </IconButton>
        )}
        <IconButton label="Settings" shortcut={shortcut(',')} onClick={() => navigate(paths.settings())}>
          <Settings size={17} />
        </IconButton>
      </div>
    </header>
  );
}
