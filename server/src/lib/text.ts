const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
    'me my of on or our so than that the their them then there these they this to too was we were what ' +
    'when where which who why will with would you your about just like want need should also some any ' +
    'please tell think know get make really very much more most'
  ).split(' '),
);

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of meaningful word sets, 0..1. */
export function similarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** A short conversation title derived from the first user message (no model call). */
export function titleFromText(text: string, max = 56): string {
  const firstLine = text.replace(/```[\s\S]*?```/g, ' ').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const clean = firstLine.replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export function truncate(text: string, maxChars: number, marker = '…[truncated]'): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** Keep the head and tail of long output, which is where the useful parts of logs usually are. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 40) / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n…[${omitted} characters omitted]…\n${text.slice(-half)}`;
}

/**
 * Build a safe FTS5 MATCH expression from free text: meaningful terms, each quoted, OR-ed.
 * Returns null when nothing searchable remains.
 */
export function ftsQuery(text: string, maxTerms = 12): string | null {
  const terms = [...tokenSet(text)].filter((w) => w.length >= 3 && !containsCjk(w)).slice(0, maxTerms);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** As-you-type FTS5 query: every word must match as a prefix (implicit AND). */
export function ftsPrefixQuery(text: string, maxTerms = 8): string | null {
  const terms = normalizeText(text)
    .split(' ')
    .filter((w) => w.length > 0 && !containsCjk(w))
    .slice(0, maxTerms);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}
