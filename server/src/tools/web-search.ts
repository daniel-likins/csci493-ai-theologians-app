import type { SourceRef, WebSearchProvider } from '../../../shared/types.ts';
import type { PreferencesService } from '../domain/preferences.ts';
import type { UsageService } from '../domain/usage.ts';
import { AppError } from '../lib/errors.ts';
import type { SecretStore } from '../secrets/secret-store.ts';

const ACCOUNTS: Record<WebSearchProvider, string> = { tavily: 'search:tavily', brave: 'search:brave' };
const PROVIDER_NAMES: Record<WebSearchProvider, string> = { tavily: 'Tavily', brave: 'Brave Search' };

function clean(text: unknown, max: number): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validUrl(url: unknown): string | null {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Real web search through a user-configured search API. Results come from the search service, so the
 * URLs shown as Sources are ones that were actually retrieved, not links a model wrote.
 */
export class WebSearchService {
  readonly #prefs: PreferencesService;
  readonly #secrets: SecretStore;
  readonly #usage: UsageService;
  readonly #fetch: typeof fetch;
  readonly #hasKey = new Map<WebSearchProvider, boolean>();

  constructor(deps: { prefs: PreferencesService; secrets: SecretStore; usage: UsageService; fetchImpl: typeof fetch }) {
    this.#prefs = deps.prefs;
    this.#secrets = deps.secrets;
    this.#usage = deps.usage;
    this.#fetch = deps.fetchImpl;
  }

  provider(): WebSearchProvider | null {
    const value = this.#prefs.get<string | null>('tools.webSearchProvider', null);
    return value === 'tavily' || value === 'brave' ? value : null;
  }

  setProvider(provider: WebSearchProvider | null): void {
    this.#prefs.set('tools.webSearchProvider', provider);
  }

  async hasKey(provider = this.provider()): Promise<boolean> {
    if (!provider) return false;
    const cached = this.#hasKey.get(provider);
    if (cached !== undefined) return cached;
    let has = false;
    try {
      has = (await this.#secrets.get(ACCOUNTS[provider])) !== null;
    } catch {
      has = false;
    }
    this.#hasKey.set(provider, has);
    return has;
  }

  async isReady(): Promise<boolean> {
    return this.hasKey();
  }

  async setKey(provider: WebSearchProvider, key: string): Promise<void> {
    await this.#secrets.set(ACCOUNTS[provider], key.trim());
    this.#hasKey.set(provider, true);
    if (!this.provider()) this.setProvider(provider);
  }

  async clearKey(provider: WebSearchProvider): Promise<void> {
    await this.#secrets.delete(ACCOUNTS[provider]);
    this.#hasKey.set(provider, false);
  }

  async search(query: string, maxResults = 5, signal: AbortSignal = new AbortController().signal): Promise<SourceRef[]> {
    const provider = this.provider();
    const key = provider ? await this.#secrets.get(ACCOUNTS[provider]) : null;
    if (!provider || !key) {
      throw new AppError('search_not_configured', "Web search isn't set up. Add a Tavily or Brave Search API key in Settings → Tools.", 400);
    }
    const name = PROVIDER_NAMES[provider];
    const count = Math.max(1, Math.min(10, Math.round(maxResults)));
    const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let response: Response;
    try {
      response =
        provider === 'tavily'
          ? await this.#fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
              body: JSON.stringify({ query, max_results: count, search_depth: 'basic', include_answer: false, include_raw_content: false }),
              signal: combined,
            })
          : await this.#fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
              headers: { accept: 'application/json', 'x-subscription-token': key },
              signal: combined,
            });
    } catch {
      if (signal.aborted) throw new AppError('cancelled', 'Search cancelled.', 499);
      this.#usage.record({ purpose: 'web_search', status: 'error', detail: `${name}: network error` });
      throw new AppError('search_failed', `Couldn't reach ${name}. Check your internet connection.`, 502);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.#usage.record({ purpose: 'web_search', status: 'error', detail: `${name}: HTTP ${response.status}` });
      const reason =
        response.status === 401 || response.status === 403
          ? `${name} rejected the API key. Check it in Settings → Tools.`
          : response.status === 429 || response.status === 432 || response.status === 433
            ? `${name} says the search limit or plan quota was reached.`
            : `${name} returned an error (${response.status}).`;
      throw new AppError('search_failed', `${reason}${body && response.status >= 500 ? '' : ''}`, 502);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const raw =
      provider === 'tavily'
        ? ((json.results as { title?: string; url?: string; content?: string }[] | undefined) ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }))
        : (((json.web as { results?: { title?: string; url?: string; description?: string }[] } | undefined)?.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
          })));
    const results: SourceRef[] = [];
    for (const r of raw) {
      const url = validUrl(r.url);
      if (!url) continue;
      results.push({ title: clean(r.title, 200) || url, url, snippet: clean(r.snippet, 500), provider: name });
      if (results.length >= count) break;
    }
    this.#usage.record({ purpose: 'web_search', status: 'ok', detail: `${name}: ${results.length} result(s)` });
    return results;
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const results = await this.search('Open-Meteo weather API', 1);
      return { ok: true, detail: `Search works — ${this.provider() === 'tavily' ? 'Tavily' : 'Brave'} returned ${results.length} result(s).` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
