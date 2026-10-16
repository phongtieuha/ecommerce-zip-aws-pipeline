export function count_words(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

export function count_words_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string" || !text.trim()) return 0;
  const bulletPattern = /^\s*(?:-+|•|●)\s+.*$/gm;
  const textNoBullet = text.replace(bulletPattern, "");
  return textNoBullet.trim() ? textNoBullet.trim().split(/\s+/).length : 0;
}

export function count_bullets_clean(text: string | null | undefined): number {
  if (!text || typeof text !== "string") return 0;

  const pattern = /^\s*(?:-+|•|●)\s+.+/gm;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function count_charactes_no_bullet(text: string | null | undefined): number {
  if (!text || typeof text !== "string") return 0;

  const pattern = /^\s*(?:-+|•|●)\s+.*$/gm;
  const textNoBullets = text.replace(pattern, "");
  return textNoBullets.length;
}
