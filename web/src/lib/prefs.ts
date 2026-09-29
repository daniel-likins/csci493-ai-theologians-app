import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { BootstrapDto } from '../../../shared/types.ts';
import { api } from '../api/client.ts';
import { useBootstrap } from './queries.ts';

/**
 * A preference stored by the local service, so every open view (desktop and browser) shares it.
 * Updates apply locally at once and are saved in the background.
 */
export function usePreference<T>(key: string, fallback: T): [T, (value: T) => void] {
  const queryClient = useQueryClient();
  const { data } = useBootstrap();
  const stored = data?.preferences[key] as T | undefined;
  const value = stored === undefined || stored === null ? fallback : stored;
  const set = useCallback(
    (next: T) => {
      queryClient.setQueryData<BootstrapDto>(['bootstrap'], (current) =>
        current ? { ...current, preferences: { ...current.preferences, [key]: next } } : current,
      );
      void api.put(`/api/preferences/${encodeURIComponent(key)}`, { value: next }).catch(() => undefined);
    },
    [key, queryClient],
  );
  return [value, set];
}
