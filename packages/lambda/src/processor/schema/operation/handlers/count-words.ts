import { count_words as count_words_id } from "@filepipeline/shared/utility/bullet-points/id";
import { count_words as count_words_vn } from "@filepipeline/shared/utility/bullet-points/vn";
import { count_words as count_words_th } from "@filepipeline/shared/utility/bullet-points/th";
import { count_words as count_words_ph } from "@filepipeline/shared/utility/bullet-points/ph";
import { resolveCountry } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCountWords: OperationHandler<"count_words"> = (value, _operation, context) => {
  if (typeof value !== "string") return undefined;

  const country = resolveCountry(undefined, context);
  if (country === "vn") return count_words_vn(value);
  if (country === "id") return count_words_id(value);
  if (country === "th") return count_words_th(value);
  if (country === "ph") return count_words_ph(value);
  return count_words_vn(value);
};
