import { count_words_no_bullet as count_words_no_bullet_id } from "@filepipeline/shared/utility/bullet-points/id";
import { count_words_no_bullet as count_words_no_bullet_vn } from "@filepipeline/shared/utility/bullet-points/vn";
import { count_words_no_bullet as count_words_no_bullet_th } from "@filepipeline/shared/utility/bullet-points/th";
import { count_words_no_bullet as count_words_no_bullet_ph } from "@filepipeline/shared/utility/bullet-points/ph";
import { resolveCountry } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCountWordsNoBullet: OperationHandler<"count_words_no_bullet"> = (
  value,
  _operation,
  context,
) => {
  if (typeof value !== "string") return undefined;

  const country = resolveCountry(undefined, context);
  if (country === "vn") return count_words_no_bullet_vn(value);
  if (country === "id") return count_words_no_bullet_id(value);
  if (country === "th") return count_words_no_bullet_th(value);
  if (country === "ph") return count_words_no_bullet_ph(value);
  return count_words_no_bullet_vn(value);
};
