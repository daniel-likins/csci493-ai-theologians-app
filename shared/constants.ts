// Runtime constants shared by the server and the web UI.
import type { AccessType, CheckinFrequency, MemoryCategory, MemoryCertainty, Protocol } from './types.ts';

export const MEMORY_CATEGORIES: readonly { id: MemoryCategory; label: string; singular: string; primary: boolean }[] = [
  { id: 'long_term_goal', label: 'Long-term goals', singular: 'long-term goal', primary: true },
  { id: 'current_focus', label: 'Current focus', singular: 'current focus', primary: true },
  { id: 'progress', label: 'Progress', singular: 'progress note', primary: true },
  { id: 'next_step', label: 'Next steps', singular: 'next step', primary: true },
  { id: 'idea', label: 'Ideas', singular: 'idea', primary: false },
  { id: 'feeling', label: 'Feelings', singular: 'feeling', primary: false },
  { id: 'constraint', label: 'Constraints', singular: 'constraint', primary: false },
  { id: 'note', label: 'Notes', singular: 'note', primary: false },
];

export const MEMORY_CATEGORY_IDS: readonly MemoryCategory[] = MEMORY_CATEGORIES.map((c) => c.id);

export const MEMORY_CERTAINTIES: readonly { id: MemoryCertainty; label: string; description: string }[] = [
  { id: 'confirmed', label: 'Confirmed', description: 'You have stated or decided this.' },
  { id: 'tentative', label: 'Tentative', description: 'An idea or plan you are still considering.' },
  { id: 'suggestion', label: 'Assistant suggestion', description: "Proposed by an assistant; you haven't adopted it." },
];

export const MEMORY_CERTAINTY_IDS: readonly MemoryCertainty[] = MEMORY_CERTAINTIES.map((c) => c.id);

export function categoryLabel(id: MemoryCategory): string {
  return MEMORY_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function categorySingular(id: MemoryCategory): string {
  return MEMORY_CATEGORIES.find((c) => c.id === id)?.singular ?? id;
}

export function certaintyLabel(id: MemoryCertainty): string {
  return MEMORY_CERTAINTIES.find((c) => c.id === id)?.label ?? id;
}

export const ACCESS_TYPE_LABELS: Record<AccessType, string> = {
  paid_api: 'Paid API',
  institutional: 'Institutional',
  local: 'Local model',
  other: 'Other endpoint',
};

export const PROTOCOL_NAMES: Record<Protocol, string> = {
  openai_responses: 'OpenAI Responses API',
  openai_chat: 'OpenAI-compatible Chat Completions',
  anthropic_messages: 'Anthropic Messages API',
  gemini_generate_content: 'Gemini generateContent API',
};

export const CHECKIN_INTERVAL_DAYS: Record<Exclude<CheckinFrequency, 'off'>, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
