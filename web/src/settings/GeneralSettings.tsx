import { useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import type { WeatherSettings } from '../../../shared/types.ts';
import type { Theme } from '../App.tsx';
import { api } from '../api/client.ts';
import { toast, toastError } from '../components/toast.tsx';
import { Button, Segmented, SettingRow, Spinner, Switch } from '../components/ui.tsx';
import { usePreference } from '../lib/prefs.ts';
import { useWeather, useWeatherSettings } from '../lib/queries.ts';
import { shortcut } from '../lib/shortcuts.ts';
import { SettingsGroup } from './common.tsx';

interface Place {
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
}

function WeatherCard() {
  const queryClient = useQueryClient();
  const settings = useWeatherSettings();
  const weather = useWeather();
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);

  const update = async (patch: Partial<WeatherSettings>): Promise<void> => {
    try {
      await api.patch('/api/weather/settings', patch);
      void queryClient.invalidateQueries({ queryKey: ['weatherSettings'] });
      void queryClient.invalidateQueries({ queryKey: ['weather'] });
    } catch (err) {
      toastError(err);
    }
  };

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      setPlaces(await api.get<Place[]>(`/api/weather/geocode?q=${encodeURIComponent(query.trim())}`));
    } catch (err) {
      toastError(err);
    } finally {
      setSearching(false);
    }
  };

  const s = settings.data;
  if (!s) return <Spinner />;
  return (
    <div className="card">
      <SettingRow
        title="Show weather in the top bar"
        hint="Optional. Uses Open-Meteo, which receives your chosen location's coordinates. If weather can't be fetched, nothing made-up is shown."
        control={
          <Switch
            label="Show weather"
            checked={s.enabled}
            disabled={s.latitude === null}
            onChange={(enabled) => void update({ enabled })}
          />
        }
      />
      <div className="setting-row">
        <div className="text">
          <div className="title">Location</div>
          <div className="hint">
            {s.locationName ? (
              <>
                <MapPin size={12} aria-hidden="true" /> {s.locationName}
              </>
            ) : (
              'No location chosen yet.'
            )}
            {weather.data?.status === 'ok' && ` · now ${weather.data.temperature}° ${weather.data.description.toLowerCase()}`}
            {weather.data?.status === 'unavailable' && ` · ${weather.data.reason}`}
          </div>
        </div>
        <div className="control">
          <Segmented
            label="Temperature units"
            size="sm"
            value={s.units}
            onChange={(units) => void update({ units })}
            options={[
              { value: 'fahrenheit', label: '°F' },
              { value: 'celsius', label: '°C' },
            ]}
          />
        </div>
      </div>
      <form
        className="card-actions"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Search for a city" aria-label="Search for a city" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" disabled={searching || query.trim().length < 2}>
          {searching ? <Spinner label="Searching" /> : 'Search'}
        </Button>
      </form>
      {places && (
        <div className="geo-results" role="list">
          {places.length === 0 && <p className="muted">No places found.</p>}
          {places.map((p) => (
            <button
              key={`${p.latitude},${p.longitude}`}
              type="button"
              role="listitem"
              className="menu-item"
              onClick={() => {
                void update({ locationName: `${p.name}${p.detail ? `, ${p.detail}` : ''}`, latitude: p.latitude, longitude: p.longitude, enabled: true });
                setPlaces(null);
                setQuery('');
                toast(`Weather location set to ${p.name}`);
              }}
            >
              <span className="menu-text">
                <span className="menu-title">{p.name}</span>
                <span className="desc">{p.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Send message', 'Enter'],
  ['New line', 'Shift Enter'],
  ['Stop a response', shortcut('.')],
  ['New chat', shortcut('O', true)],
  ['Search chats', shortcut('K')],
  ['Show or hide the sidebar', shortcut('B')],
  ['Show or hide the Study panel', shortcut('J')],
  ['Settings', shortcut(',')],
  ['Close menus, dialogs, and settings', 'Esc'],
];

export function GeneralSettings() {
  const [theme, setTheme] = usePreference<Theme>('ui.theme', 'system');
  return (
    <>
      <h1>General</h1>
      <SettingsGroup title="Appearance">
        <div className="card">
          <SettingRow
            title="Theme"
            hint="System follows your computer's appearance setting."
            control={
              <Segmented<Theme>
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            }
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Weather">
        <WeatherCard />
      </SettingsGroup>
      <SettingsGroup title="Keyboard shortcuts">
        <div className="card">
          <div className="kbd-list">
            {SHORTCUTS.map(([action, keys]) => (
              <FragmentRow key={action} action={action} keys={keys} />
            ))}
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}

function FragmentRow({ action, keys }: { action: string; keys: string }) {
  return (
    <>
      <span>{action}</span>
      <span>
        {keys.split(' ').map((k) => (
          <kbd key={k} style={{ marginLeft: 3 }}>
            {k}
          </kbd>
        ))}
      </span>
    </>
  );
}
