import { count_bullets_clean as count_bullets_clean_id } from "@filepipeline/shared/utility/bullet-points/id";
import { count_bullets_clean as count_bullets_clean_vn } from "@filepipeline/shared/utility/bullet-points/vn";
import { count_bullets_clean as count_bullets_clean_th } from "@filepipeline/shared/utility/bullet-points/th";
import { count_bullets_clean as count_bullets_clean_ph } from "@filepipeline/shared/utility/bullet-points/ph";
import { resolveCountry } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleCountBulletsClean: OperationHandler<"count_bullets_clean"> = (
  value,
  _operation,
  context,
) => {
  if (typeof value !== "string") return undefined;

  const country = resolveCountry(undefined, context);
  if (country === "vn") return count_bullets_clean_vn(value);
  if (country === "id") return count_bullets_clean_id(value);
  if (country === "th") return count_bullets_clean_th(value);
  if (country === "ph") return count_bullets_clean_ph(value);
  return count_bullets_clean_vn(value);
};
