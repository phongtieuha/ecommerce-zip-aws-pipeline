/**
 * Thai language text analysis functions
 *
 * Note: These are simplified versions compared to the Python implementation.
 * Python version uses pythainlp for proper Thai tokenization.
 * This TypeScript version uses regex-based approximation.
 */

/**
 * Count bullet points in Thai text
 * Matches lines starting with bullet markers: •, -, –, ▪
 */
export function count_bullets_clean(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.+$/gm;
  const matches = text.match(bulletPattern);
  return matches ? matches.length : 0;
}

/**
 * Count words in Thai text (simplified approximation)
 * Counts Thai character sequences and Latin/numeric words
 *
 * Note: This is a simplified version. Python version uses pythainlp tokenizer
 * which provides more accurate word segmentation for Thai language.
 */
export function count_words(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  // Thai Unicode range: \u0E00-\u0E7F
  const thaiCharPattern = /[\u0E00-\u0E7F]+/g;
  const latinPattern = /[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*/g;

  // Count Thai character sequences (approximation of Thai words)
  const thaiMatches = text.match(thaiCharPattern);
  const thaiCount = thaiMatches ? thaiMatches.length : 0;

  // Count Latin/numeric words
  const latinMatches = text.match(latinPattern);
  const latinCount = latinMatches ? latinMatches.length : 0;

  return thaiCount + latinCount;
}

/**
 * Count words in Thai text after removing bullet points
 */
export function count_words_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.+$/gm;
  const textNoBullet = text.replace(bulletPattern, "");

  return count_words(textNoBullet);
}

/**
 * Count characters in Thai text after removing bullet point lines
 * This matches the count_charactes_no_bullet pattern from vn.ts
 */
export function count_charactes_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;

  const bulletPattern = /^\s*[•\-–▪]\s+.*$/gm;
  const textNoBullets = text.replace(bulletPattern, "");

  return textNoBullets.length;
}
