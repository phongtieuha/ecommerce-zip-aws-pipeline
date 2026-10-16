import type { Operation } from "./types.js";

function parseOperationPart(operationPart: string): Operation | null {
  if (operationPart.startsWith("date:")) {
    const pattern = operationPart.substring(5);
    return { type: "date", pattern };
  }

  if (operationPart.startsWith("eq:")) {
    const value = operationPart.substring(3);
    return { type: "eq", value };
  }

  if (operationPart.startsWith("gt:")) {
    const value = operationPart.substring(3);
    return { type: "gt", value };
  }

  if (operationPart.startsWith("divide:")) {
    const divisor = Number.parseFloat(operationPart.substring(7));
    if (!Number.isNaN(divisor) && divisor !== 0) {
      return { type: "divide", divisor };
    }
  }

  if (operationPart.startsWith("filter:")) {
    const condition = operationPart.substring(7);
    const match = condition.match(/^(.+?)(===|!==|>=|<=|==|!=|>|<)(.+)$/);
    if (match) {
      const [, path, operator, value] = match;
      return { type: "filter", path: path.trim(), operator: operator.trim(), value: value.trim() };
    }
  }

  if (operationPart.startsWith("find:")) {
    const matchValue = operationPart.substring(5);
    return { type: "find", matchValue };
  }

  if (operationPart.startsWith("get:")) {
    const fieldName = operationPart.substring(4);
    return { type: "get", fieldName };
  }

  if (operationPart.startsWith("mapurl:")) {
    const template = operationPart.substring(7);
    return { type: "mapurl", template };
  }

  if (operationPart === "currency") {
    return { type: "currency" };
  }

  if (operationPart === "capitalize") {
    return { type: "capitalize" };
  }

  if (operationPart === "length") {
    return { type: "length" };
  }

  if (operationPart === "sum") {
    return { type: "sum" };
  }

  if (operationPart === "max") {
    return { type: "max" };
  }

  if (operationPart === "min") {
    return { type: "min" };
  }

  if (operationPart === "first") {
    return { type: "first" };
  }

  if (operationPart === "last") {
    return { type: "last" };
  }

  if (operationPart.startsWith("join:")) {
    const separator = operationPart.substring(5);
    return { type: "join", separator };
  }

  if (operationPart.startsWith("concat:")) {
    const value = operationPart.substring(7);
    return { type: "concat", value };
  }

  if (operationPart.startsWith("concat_field:")) {
    const path = operationPart.substring(13).trim();
    if (path.length > 0) {
      return { type: "concat_field", path };
    }
  }

  if (operationPart.startsWith("split:")) {
    const delimiter = operationPart.substring(6);
    return { type: "split", delimiter };
  }

  if (operationPart === "flatten") {
    return { type: "flatten" };
  }

  if (operationPart === "filter_empty_strings") {
    return { type: "filter_empty_strings" };
  }

  if (operationPart.startsWith("filter_by_prefix:")) {
    const prefixes = operationPart
      .substring(17)
      .split(",")
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0);
    if (prefixes.length > 0) {
      return { type: "filter_by_prefix", prefixes };
    }
  }

  if (operationPart === "Object.values") {
    return { type: "object_values" };
  }

  if (operationPart === "JSON.stringify") {
    return { type: "json_stringify" };
  }

  if (operationPart === "unique") {
    return { type: "unique" };
  }

  if (operationPart === "unique_by_asset_hash") {
    return { type: "unique_by_asset_hash" };
  }

  if (operationPart === "text_to_number") {
    return { type: "text_to_number" };
  }

  if (operationPart === "rating_text_to_number") {
    return { type: "rating_text_to_number" };
  }

  if (operationPart === "count_bullets_clean") {
    return { type: "count_bullets_clean" };
  }

  if (operationPart === "count_words") {
    return { type: "count_words" };
  }

  if (operationPart === "count_words_no_bullet") {
    return { type: "count_words_no_bullet" };
  }

  if (operationPart === "count_charactes_no_bullet") {
    return { type: "count_charactes_no_bullet" };
  }

  if (operationPart === "clean_product_description") {
    return { type: "clean_product_description" };
  }

  if (operationPart === "extract_from_square_brackets") {
    return { type: "extract_from_square_brackets" };
  }

  if (operationPart === "clean_tiktok_product_description") {
    return { type: "clean_tiktok_product_description" };
  }

  if (operationPart === "boolean_to_number") {
    return { type: "boolean_to_number" };
  }

  if (operationPart === "boolean_to_stock") {
    return { type: "boolean_to_stock" };
  }

  if (operationPart === "transform_to_stock") {
    return { type: "transform_to_stock" };
  }

  if (operationPart === "boolean_to_text") {
    return { type: "boolean_to_text" };
  }

  if (operationPart === "rating_average") {
    return { type: "rating_average" };
  }

  if (operationPart.startsWith("contain:")) {
    const value = operationPart.substring(8);
    return { type: "contain", value };
  }

  if (operationPart.startsWith("not-contain:")) {
    const value = operationPart.substring(12);
    return { type: "not_contain", value };
  }

  if (operationPart === "transform_lazada_sku_name") {
    return { type: "transform_lazada_sku_name" };
  }

  if (operationPart === "contain_image") {
    return { type: "contain_image" };
  }

  if (operationPart === "extract_product_desc_images") {
    return { type: "extract_product_desc_images" };
  }

  if (operationPart.startsWith("extract_field_to_array:")) {
    const fieldNames = operationPart
      .substring(23)
      .split(",")
      .map((fieldName) => fieldName.trim())
      .filter((fieldName) => fieldName.length > 0);

    if (fieldNames.length > 0) {
      return { type: "extract_field_to_array", fieldNames };
    }
  }

  if (operationPart.startsWith("pair_with_separator:")) {
    const parts = operationPart.substring(20).split(",");
    if (parts.length >= 2) {
      const field1 = parts[0].trim();
      const field2 = parts[1].trim();
      const separator = parts.length > 2 ? parts[2] : ":";
      return { type: "pair_with_separator", field1, field2, separator };
    }
  }

  if (operationPart.startsWith("null_if:")) {
    const value = operationPart.substring(8);
    return { type: "null_if", value };
  }

  return null;
}

export function parseOperation(path: string): {
  basePath: string;
  operation: Operation | null;
  operations: Operation[];
} {
  const pipeIndex = path.indexOf("|");
  if (pipeIndex !== -1) {
    const basePath = path.substring(0, pipeIndex);
    const operationPart = path.substring(pipeIndex + 1);
    const parts = operationPart.split("|").filter((part) => part.length > 0);
    const operations = parts
      .map((part) => parseOperationPart(part))
      .filter((op): op is Operation => op !== null);

    if (operations.length > 0) {
      return {
        basePath,
        operation: operations[operations.length - 1],
        operations,
      };
    }

    return {
      basePath,
      operation: null,
      operations: [],
    };
  }

  return {
    basePath: path,
    operation: null,
    operations: [],
  };
}
