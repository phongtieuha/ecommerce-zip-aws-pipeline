import type { OperationHandler } from "../types.js";

export const handleJsonStringify: OperationHandler<"json_stringify"> = (value) => {
  if (value === null || value === undefined) return undefined;
  return JSON.stringify(value);
};
