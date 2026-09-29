import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'mission'; slug: string; conversationId: string | null }
  | { name: 'settings'; section: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'm' && parts[1]) {
    return { name: 'mission', slug: parts[1], conversationId: parts[2] === 'c' && parts[3] ? parts[3] : null };
  }
  if (parts[0] === 'settings') return { name: 'settings', section: parts[1] ?? 'general' };
  return { name: 'home' };
}

const EVENT = 'theologians:navigate';

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === window.location.pathname) return;
  if (!to.startsWith('/settings')) sessionStorage.setItem('theologians.lastPath', to);
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(EVENT, callback);
  };
}

let cachedPath = '';
let cachedRoute: Route = { name: 'home' };

function snapshot(): Route {
  const path = window.location.pathname;
  if (path !== cachedPath) {
    cachedPath = path;
    cachedRoute = parseRoute(path);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const paths = {
  home: () => '/',
  mission: (slug: string) => `/m/${encodeURIComponent(slug)}`,
  conversation: (slug: string, id: string) => `/m/${encodeURIComponent(slug)}/c/${encodeURIComponent(id)}`,
  settings: (section = 'general') => `/settings/${section}`,
};

export function lastNonSettingsPath(): string {
  try {
    return sessionStorage.getItem('theologians.lastPath') ?? '/';
  } catch {
    return '/';
  }
}
