import type { WeatherDto, WeatherSettings } from '../../../shared/types.ts';
import type { PreferencesService } from '../domain/preferences.ts';
import type { EventBus } from '../events/bus.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';

const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

const DEFAULTS: WeatherSettings = { enabled: false, locationName: null, latitude: null, longitude: null, units: 'fahrenheit' };
const FRESH_MS = 20 * 60_000;
const STALE_LIMIT_MS = 3 * 3_600_000;

/** Optional weather from Open-Meteo. Never blocks the app and never shows made-up values. */
export class WeatherService {
  readonly #prefs: PreferencesService;
  readonly #bus: EventBus;
  readonly #fetch: typeof fetch;
  #cache: { key: string; data: Extract<WeatherDto, { status: 'ok' }>; at: number } | null = null;
  #inflight: Promise<WeatherDto> | null = null;

  constructor(deps: { prefs: PreferencesService; bus: EventBus; fetchImpl: typeof fetch }) {
    this.#prefs = deps.prefs;
    this.#bus = deps.bus;
    this.#fetch = deps.fetchImpl;
  }

  settings(): WeatherSettings {
    return { ...DEFAULTS, ...this.#prefs.get<Partial<WeatherSettings>>('weather.settings', {}) };
  }

  update(patch: Partial<WeatherSettings>): WeatherSettings {
    const next = { ...this.settings(), ...patch };
    if (next.latitude !== null && (typeof next.latitude !== 'number' || next.latitude < -90 || next.latitude > 90)) throw badRequest('Invalid latitude.');
    if (next.longitude !== null && (typeof next.longitude !== 'number' || next.longitude < -180 || next.longitude > 180)) throw badRequest('Invalid longitude.');
    if (next.units !== 'celsius' && next.units !== 'fahrenheit') throw badRequest('Units must be celsius or fahrenheit.');
    if (next.enabled && (next.latitude === null || next.longitude === null)) throw badRequest('Choose a location before turning weather on.');
    next.locationName = next.locationName ? String(next.locationName).slice(0, 120) : null;
    this.#prefs.set('weather.settings', next);
    this.#cache = null;
    this.#bus.publish({ type: 'settings.changed', area: 'weather' });
    return next;
  }

  async geocode(query: string): Promise<{ name: string; detail: string; latitude: number; longitude: number }[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    try {
      const response = await this.#fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(String(response.status));
      const json = (await response.json()) as { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] };
      return (json.results ?? []).map((r) => ({
        name: r.name,
        detail: [r.admin1, r.country].filter(Boolean).join(', '),
        latitude: r.latitude,
        longitude: r.longitude,
      }));
    } catch {
      throw new AppError('weather_unavailable', "Couldn't search locations right now. Check your internet connection.", 502);
    }
  }

  async current(): Promise<WeatherDto> {
    const s = this.settings();
    if (!s.enabled || s.latitude === null || s.longitude === null) return { status: 'disabled' };
    const key = `${s.latitude},${s.longitude},${s.units}`;
    if (this.#cache && this.#cache.key === key && Date.now() - this.#cache.at < FRESH_MS) return this.#cache.data;
    this.#inflight ??= this.#fetchCurrent(s, key).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #fetchCurrent(s: WeatherSettings, key: string): Promise<WeatherDto> {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.latitude}&longitude=${s.longitude}&current=temperature_2m,weather_code&temperature_unit=${s.units}&timezone=auto`;
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(String(response.status));
      const json = (await response.json()) as { current?: { temperature_2m?: number; weather_code?: number; time?: string } };
      const current = json.current;
      if (!current || typeof current.temperature_2m !== 'number') throw new Error('no data');
      const data: Extract<WeatherDto, { status: 'ok' }> = {
        status: 'ok',
        temperature: Math.round(current.temperature_2m),
        units: s.units,
        description: WMO[current.weather_code ?? -1] ?? 'Current conditions',
        locationName: s.locationName ?? 'Your location',
        observedAt: current.time ?? nowIso(),
        fetchedAt: nowIso(),
        stale: false,
      };
      this.#cache = { key, data, at: Date.now() };
      return data;
    } catch {
      if (this.#cache && this.#cache.key === key && Date.now() - this.#cache.at < STALE_LIMIT_MS) {
        return { ...this.#cache.data, stale: true };
      }
      return { status: 'unavailable', reason: "Weather isn't available right now." };
    }
  }
}
