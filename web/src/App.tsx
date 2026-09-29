import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { errorText } from './api/client.ts';
import { useLiveEvents } from './api/events.ts';
import { DialogHost } from './components/Dialog.tsx';
import { Toaster } from './components/toast.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Button } from './components/ui.tsx';
import { usePreference } from './lib/prefs.ts';
import { useBootstrap } from './lib/queries.ts';
import { navigate, paths, useRoute, type Route } from './lib/router.ts';
import { HomePage } from './pages/HomePage.tsx';
import { MissionPage } from './pages/MissionPage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';

export type Theme = 'system' | 'light' | 'dark';

export interface PanelPrefs {
  open: boolean;
  width: number;
}

export const SIDEBAR_DEFAULT: PanelPrefs = { open: true, width: 264 };
export const GOALS_PANEL_DEFAULT: PanelPrefs & { tab: 'chat' | 'memory' | 'updates' } = { open: true, width: 380, tab: 'chat' };

function useTheme(): void {
  const [theme] = usePreference<Theme>('ui.theme', 'system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);
}

function useGlobalShortcuts(route: Route): void {
  const [sidebar, setSidebar] = usePreference<PanelPrefs>('ui.sidebar', SIDEBAR_DEFAULT);
  const [panel, setPanel] = usePreference('ui.goalsPanel', GOALS_PANEL_DEFAULT);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === ',') {
        event.preventDefault();
        navigate(paths.settings());
      } else if (route.name === 'mission' && key === 'b' && !event.shiftKey) {
        event.preventDefault();
        setSidebar({ ...sidebar, open: !sidebar.open });
      } else if (route.name === 'mission' && key === 'j' && !event.shiftKey) {
        event.preventDefault();
        setPanel({ ...panel, open: !panel.open });
      } else if (route.name === 'mission' && key === 'k' && !event.shiftKey) {
        event.preventDefault();
        window.dispatchEvent(new Event('theologians:search'));
      } else if (route.name === 'mission' && key === 'o' && event.shiftKey) {
        event.preventDefault();
        navigate(paths.mission(route.slug));
        window.dispatchEvent(new Event('theologians:focus-composer'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, sidebar, panel, setSidebar, setPanel]);
}

export function App() {
  const queryClient = useQueryClient();
  const live = useLiveEvents(queryClient);
  const route = useRoute();
  const bootstrap = useBootstrap();
  useTheme();
  useGlobalShortcuts(route);

  if (bootstrap.isPending) return <div className="app-loading" aria-busy="true" aria-label="Loading Theologians" />;
  if (bootstrap.isError) {
    return (
      <div className="app-offline" role="alert">
        <h1>Theologians isn't reachable</h1>
        <p>{errorText(bootstrap.error)}</p>
        <Button variant="primary" onClick={() => void bootstrap.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar route={route} live={live} />
      <main className="app-main">
        {route.name === 'home' && <HomePage />}
        {route.name === 'mission' && <MissionPage key={route.slug} slug={route.slug} conversationId={route.conversationId} />}
        {route.name === 'settings' && <SettingsPage section={route.section} />}
      </main>
      <DialogHost />
      <Toaster />
    </div>
  );
}
