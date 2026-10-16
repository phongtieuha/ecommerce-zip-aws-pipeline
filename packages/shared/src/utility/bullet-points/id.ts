import {
  count_bullets_clean as count_bullets_clean_vn,
  count_charactes_no_bullet as count_charactes_no_bullet_vn,
  count_words as count_words_vn,
  count_words_no_bullet as count_words_no_bullet_vn,
} from "./vn";

export function count_words(text: string | null | undefined): number {
  return count_words_vn(text);
}

export function count_words_no_bullet(text: string | null | undefined): number {
  return count_words_no_bullet_vn(text);
}

export function count_bullets_clean(text: string | null | undefined): number {
  return count_bullets_clean_vn(text);
}

export function count_charactes_no_bullet(text: string | null | undefined): number {
  return count_charactes_no_bullet_vn(text);
}
