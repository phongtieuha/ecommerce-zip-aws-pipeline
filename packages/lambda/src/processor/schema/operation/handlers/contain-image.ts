import { containsImageReference } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleContainImage: OperationHandler<"contain_image"> = (value) => {
  return containsImageReference(value);
};
