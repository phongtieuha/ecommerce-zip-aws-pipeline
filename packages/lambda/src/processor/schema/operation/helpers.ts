import countryToCurrency from "country-to-currency";

export function normalizeLocalizedNumericText(value: string): string {
  let cleaned = value.replace(/^(rp|idr|thb|sgd|rm|usd|vnd|php|myr)\s*/i, "");
  cleaned = cleaned.replace(/[฿$€£¥₫₱]/g, "");
  cleaned = cleaned.replace(/[^0-9,.-]/g, "");
  cleaned = cleaned.replace(/\s+/g, "");

  if (!cleaned) return cleaned;

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    cleaned = cleaned.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") {
      cleaned = cleaned.replace(",", ".");
    }
    return cleaned;
  }

  if (commaCount > 0) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(cleaned)) {
      return cleaned.replace(/,/g, "");
    }
    if (commaCount === 1 && /^-?\d+,\d+$/.test(cleaned)) {
      return cleaned.replace(",", ".");
    }
    return cleaned.replace(/,/g, "");
  }

  if (dotCount > 0) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) {
      return cleaned.replace(/\./g, "");
    }
    if (dotCount === 1 && /^-?\d+\.\d{3}$/.test(cleaned)) {
      return cleaned.replace(".", "");
    }
  }

  return cleaned;
}

export function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

export function normalizeProductDescriptionValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }

    const jsonCandidate = trimmed;
    if (
      (jsonCandidate.startsWith("{") && jsonCandidate.endsWith("}")) ||
      (jsonCandidate.startsWith("[") && jsonCandidate.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(jsonCandidate);
        return normalizeProductDescriptionValue(parsed);
      } catch {
        // fall through to string normalization
      }
    }

    const withoutTags = stripHtmlTags(trimmed);
    const normalized = withoutTags.replace(/\s+/g, " ").trim();
    return normalized;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeProductDescriptionValue(item))
      .filter((text) => text.length > 0)
      .join(" ");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const prioritizedKeys = ["text", "t", "content", "description", "sub", "li_sub", "value"];

    const collected: string[] = [];
    for (const key of prioritizedKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const extracted = normalizeProductDescriptionValue(obj[key]);
        if (extracted.length > 0) {
          collected.push(extracted);
        }
      }
    }

    if (collected.length > 0) {
      return collected.join(" ");
    }

    const fallback = Object.values(obj)
      .map((item) => normalizeProductDescriptionValue(item))
      .filter((text) => text.length > 0)
      .join(" ");

    return fallback;
  }

  return String(value).trim();
}

export function normalizeTextToken(value: string): string {
  const withoutTags = stripHtmlTags(value);
  return withoutTags.replace(/\s+/g, " ").trim();
}

export function extractFromSquareBrackets(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = normalizeProductDescriptionValue(value);
  if (!text) {
    return "";
  }

  const bracketMatch = text.match(/【([^】]+)】|\[([^\]]+)\]/);
  const extracted = bracketMatch?.[1] || bracketMatch?.[2] || "";
  return extracted.trim();
}

export function extractTextFieldsOnly(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return extractTextFieldsOnly(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }

    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextFieldsOnly(item));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const collected: string[] = [];

    for (const [key, child] of Object.entries(obj)) {
      if (key === "text") {
        if (typeof child === "string") {
          const normalized = normalizeTextToken(child);
          if (normalized) {
            collected.push(normalized);
          }
        } else {
          collected.push(...extractTextFieldsOnly(child));
        }
        continue;
      }

      collected.push(...extractTextFieldsOnly(child));
    }

    return collected;
  }

  return [];
}

function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  let remaining = path;

  while (remaining) {
    current = tryParseJsonString(current);

    const bracketMatch = remaining.match(/^\[(\d+)\]/);
    if (bracketMatch) {
      const index = Number.parseInt(bracketMatch[1], 10);
      if (!Array.isArray(current)) return undefined;
      current = current[index];
      remaining = remaining.slice(bracketMatch[0].length);
      if (remaining.startsWith(".")) remaining = remaining.slice(1);
      continue;
    }

    const dotIndex = remaining.indexOf(".");
    const nextBracketIndex = remaining.indexOf("[");
    let nextKey: string;
    let nextRemaining: string;

    if (dotIndex === -1 && nextBracketIndex === -1) {
      nextKey = remaining;
      nextRemaining = "";
    } else if (dotIndex === -1) {
      nextKey = remaining.slice(0, nextBracketIndex);
      nextRemaining = remaining.slice(nextBracketIndex);
    } else if (nextBracketIndex === -1) {
      nextKey = remaining.slice(0, dotIndex);
      nextRemaining = remaining.slice(dotIndex + 1);
    } else {
      const minIndex = Math.min(dotIndex, nextBracketIndex);
      nextKey = remaining.slice(0, minIndex);
      nextRemaining = remaining.slice(minIndex + (minIndex === dotIndex ? 1 : 0));
    }

    if (nextKey === "length") {
      if (Array.isArray(current)) {
        current = current.length;
      } else if (typeof current === "string") {
        current = current.length;
      } else if (current && typeof current === "object") {
        current = Object.keys(current).length;
      } else {
        return undefined;
      }
      remaining = nextRemaining;
      continue;
    }

    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[nextKey];
    remaining = nextRemaining;
  }

  return current;
}

function extractCountryCode(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;

  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;

  const keyPathCountry = normalized.match(/^([a-z]{2})\/[^/]+\/\d{4}\/\d{2}\/\d{2}\//);
  if (keyPathCountry) return keyPathCountry[1];

  if (
    normalized.startsWith("s3://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://")
  ) {
    try {
      const parsed = new URL(normalized);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) {
        return segments[0];
      }
    } catch {
      // Continue with other extraction strategies
    }
  }

  const hashCountry = normalized.match(/^([a-z]{2})-/);
  if (hashCountry) return hashCountry[1];

  const directCountry = normalized.match(/^[a-z]{2}$/);
  if (directCountry) return normalized;

  const localeCountry = normalized.match(/^[a-z]{2}[-_][a-z]{2}$/);
  if (localeCountry) {
    const parts = normalized.split(/[-_]/);
    return parts[1];
  }

  const hostCountry = normalized.match(/^([a-z]{2})\./);
  if (hostCountry) return hostCountry[1];

  return undefined;
}

export function resolveCountry(value: unknown, context?: Record<string, unknown>): string {
  if (context) {
    const candidatePaths = [
      "cube_metadata.country",
      "cube_metadata.s3_key",
      "s3Key",
      "s3_key",
      "country",
      "country_code",
      "countryCode",
      "region",
      "locale",
      "item_card_displayed_asset.image",
      "item_card_displayed_asset.images[0]",
      "transparent_background_image",
    ];

    for (const candidatePath of candidatePaths) {
      const candidateValue = getValueByPath(context, candidatePath);
      const country = extractCountryCode(candidateValue);
      if (country) return country;
    }
  }

  return extractCountryCode(value) ?? "";
}

export function containsImageReference(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (Array.isArray(value)) {
    return value.some((item) => containsImageReference(item));
  }

  const text =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  if (!text.trim()) return false;

  if (/data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
    return true;
  }

  if (/<img\b[^>]*\bsrc\s*=\s*["'][^"']+["']/i.test(text)) {
    return true;
  }

  if (
    /(^|[^\w])(?:https?:\/\/|\/\/)?[^\s"'<>]+\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)(?:\?[^\s"'<>#]*)?(?:#[^\s"'<>]*)?(?=$|[^\w])/i.test(
      text,
    )
  ) {
    return true;
  }

  const urls = text.match(/(?:https?:\/\/|\/\/)[^\s"'<>]+/gi) || [];
  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    if (!url) continue;

    if (
      /(?:\?|&)(?:format|fmt|fm|ext|type|mime)=?(?:image%2f)?(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)\b/i.test(
        url,
      )
    ) {
      return true;
    }

    if (/image%2f(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)\b/i.test(url)) {
      return true;
    }

    if (
      /(^|\.)img\d*\.|(^|\.)images\d*\.|\/img(?:\/|\b)|\/images(?:\/|\b)|\/image(?:\/|\b)|\/photos?(?:\/|\b)/i.test(
        url,
      )
    ) {
      return true;
    }
  }

  return false;
}

function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

export function extractImageReferences(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string) => {
    const normalized = decodeUnicodeEscapes(candidate.trim());
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    found.push(normalized);
  };

  const visit = (input: unknown) => {
    if (input === null || input === undefined) return;

    if (Array.isArray(input)) {
      for (const item of input) {
        visit(item);
      }
      return;
    }

    if (typeof input === "object") {
      for (const child of Object.values(input as Record<string, unknown>)) {
        visit(child);
      }
      return;
    }

    const raw = String(input);
    const text = raw.trim();
    if (!text) return;

    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      try {
        visit(JSON.parse(text));
      } catch {
        // Ignore JSON parse errors and continue with raw-text extraction.
      }
    }

    const imgSrcRegex = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    for (const match of text.matchAll(imgSrcRegex)) {
      if (match[1]) {
        add(match[1]);
      }
    }

    const imagePathRegex =
      /(?:https?:\/\/|\/\/|\/)[^\s"'<>]+\.(?:jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)(?:\?[^\s"'<>#]*)?(?:#[^\s"'<>]*)?/gi;
    for (const match of text.matchAll(imagePathRegex)) {
      if (match[0]) {
        add(match[0]);
      }
    }
  };

  visit(value);
  return found;
}

export function resolveCurrency(
  value: unknown,
  context?: Record<string, unknown>,
): string | undefined {
  const country = resolveCountry(value, context).toUpperCase();
  if (!country) return undefined;

  if (!(country in countryToCurrency)) return undefined;

  const currencyCode = countryToCurrency[country as keyof typeof countryToCurrency];
  return currencyCode || undefined;
}

export function resolveShopeeDomain(countryCode: string): string {
  const country = countryCode.trim().toUpperCase();
  if (country === "ID" || country === "TH") return "shopee.co";
  if (country === "MY" || country === "BR") return "shopee.com";
  return "shopee";
}
