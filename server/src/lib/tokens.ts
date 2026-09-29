const CJK_GLOBAL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Conservative token estimate used for context budgeting. Providers tokenize differently, so this
 * deliberately over-estimates (≈3.5 chars/token for Latin text, ≈1 token per CJK character).
 * Always labeled as an estimate wherever it is shown.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_GLOBAL)?.length ?? 0;
  return Math.ceil((text.length - cjk) / 3.5 + cjk * 1.1) + 4;
}

/** Rough per-image cost used only for budgeting. */
export const IMAGE_TOKEN_ESTIMATE = 1600;
/** Rough per-page cost for natively attached PDFs. */
export const PDF_PAGE_TOKEN_ESTIMATE = 1500;
