import { getValueByPath } from "../helpers.js";
import type { OperationHandler } from "../types.js";

type GenericObject = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function pickFirstString(obj: GenericObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = asNonEmptyString(obj[key]);
    if (found) return found;
  }
  return undefined;
}

function matchesByCandidate(item: GenericObject, token: string): boolean {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return false;

  const candidateKeys = [
    "pid",
    "propId",
    "propertyId",
    "id",
    "vid",
    "valueId",
    "name",
    "propName",
    "valueName",
    "label",
    "text",
    "value",
    "title",
  ];

  for (const key of candidateKeys) {
    const candidate = asNonEmptyString(item[key]);
    if (candidate && normalizeToken(candidate) === normalizedToken) {
      return true;
    }
  }

  return false;
}

function resolveProperties(context?: Record<string, unknown>): GenericObject[] {
  if (!context) return [];

  const candidates = [
    "productOption.skuBase.properties",
    "skuBase.properties",
    "productOption.properties",
  ];

  for (const path of candidates) {
    const value = getValueByPath(context, path);
    const arr = asArray(value).filter(
      (item): item is GenericObject => typeof item === "object" && item !== null,
    );
    if (arr.length > 0) return arr;
  }

  return [];
}

export const handleTransformLazadaSkuName: OperationHandler<"transform_lazada_sku_name"> = (
  value,
  _operation,
  context,
) => {
  const raw = asNonEmptyString(value);
  if (!raw) return "";

  const properties = resolveProperties(context);
  if (properties.length === 0) return raw;

  const segments = raw
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return raw;

  const transformed = segments.map((segment) => {
    const colonIndex = segment.indexOf(":");
    if (colonIndex <= 0) {
      return segment;
    }

    const pidToken = segment.slice(0, colonIndex).trim();
    const vidToken = segment.slice(colonIndex + 1).trim();
    if (!pidToken || !vidToken) {
      return segment;
    }

    const matchedProperty = properties.find((property) => matchesByCandidate(property, pidToken));
    if (!matchedProperty) {
      return `${pidToken}:${vidToken}`;
    }

    const propertyName =
      pickFirstString(matchedProperty, ["name", "propName", "title", "label"]) || pidToken;

    const values = asArray(matchedProperty.values).filter(
      (item): item is GenericObject => typeof item === "object" && item !== null,
    );

    const matchedValue = values.find((item) => matchesByCandidate(item, vidToken));
    const valueName = matchedValue
      ? pickFirstString(matchedValue, ["name", "valueName", "title", "label", "text", "value"])
      : undefined;

    return `${propertyName}:${valueName || vidToken}`;
  });

  return transformed.join(";");
};
