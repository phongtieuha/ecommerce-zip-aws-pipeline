import { getValueByPath, resolveCountry, resolveShopeeDomain } from "../helpers.js";
import type { OperationHandler } from "../types.js";

export const handleMapurl: OperationHandler<"mapurl"> = (value, operation, context, runtime) => {
  const mapValue = (input: unknown): string => {
    if (input === null || input === undefined) return "";

    const valueString = String(input);

    // Already a complete URL (e.g. a fallback field that's pre-built, unlike
    // the bare relative path / hash this template is meant to wrap) — pass
    // through unchanged rather than nesting it inside the template.
    if (valueString.startsWith("http")) return valueString;

    const url = operation.template.replace(/\{([^}]+)\}/g, (_, token: string) => {
      const key = token.trim();

      if (key === "value") return valueString;
      if (key === "country") return resolveCountry(input, context);
      if (key === "shopee_domain") {
        // Prefer the already-resolved `region` runtime value (same source the `region`
        // token below uses) over resolveCountry(context), which looks for country/region
        // fields on the row context that aren't reliably present during ZIP streaming.
        const country = runtime?.region
          ? runtime.region.toUpperCase()
          : resolveCountry(input, context);
        return resolveShopeeDomain(country);
      }
      if (key === "region") {
        // Reuses the `region` column's already-resolved value instead of duplicating
        // its source/default resolution here.
        return runtime?.region ? runtime.region.toLowerCase() : "";
      }

      if (context) {
        const fromContext = getValueByPath(context, key);
        if (fromContext === null || fromContext === undefined) return "";
        return String(fromContext);
      }

      return "";
    });

    return url;
  };

  if (Array.isArray(value)) {
    return value.map((item) => mapValue(item)).filter((url) => url !== "");
  }

  return mapValue(value);
};
