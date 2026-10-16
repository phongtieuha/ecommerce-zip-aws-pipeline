/**
 * Philippines language text analysis functions
 * Focuses on English/Latin word counting
 */

/**
 * Count bullet points in Philippines text
 * Matches lines starting with bullet markers: •, -, –, ▪
 */
export function count_bullets_clean(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.+$/gm;
  const matches = text.match(bulletPattern);
  return matches ? matches.length : 0;
}

/**
 * Count words in Philippines text
 * Counts English/Latin words including hyphenated/slashed variations
 */
export function count_words(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const wordPattern = /\b[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*\b/g;
  const matches = text.match(wordPattern);
  return matches ? matches.length : 0;
}

/**
 * Count words in Philippines text after removing bullet points
 */
export function count_words_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.+$/gm;
  const textNoBullet = text.replace(bulletPattern, "");

  return count_words(textNoBullet);
}

/**
 * Count characters in Philippines text after removing bullet point lines
 * This matches the count_charactes_no_bullet pattern from vn.ts
 */
export function count_charactes_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.*$/gm;
  const textNoBullets = text.replace(bulletPattern, "");

  return textNoBullets.length;
}
