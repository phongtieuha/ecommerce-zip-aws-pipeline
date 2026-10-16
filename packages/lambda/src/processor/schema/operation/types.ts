export type Operation =
  | { type: "length" }
  | { type: "sum" }
  | { type: "max" }
  | { type: "min" }
  | { type: "first" }
  | { type: "last" }
  | { type: "join"; separator: string }
  | { type: "concat"; value: string }
  | { type: "concat_field"; path: string }
  | { type: "split"; delimiter: string }
  | { type: "date"; pattern: string }
  | { type: "eq"; value: string }
  | { type: "gt"; value: string }
  | { type: "divide"; divisor: number }
  | { type: "filter"; path: string; operator: string; value: string }
  | { type: "find"; matchValue: string }
  | { type: "get"; fieldName: string }
  | { type: "flatten" }
  | { type: "filter_empty_strings" }
  | { type: "filter_by_prefix"; prefixes: string[] }
  | { type: "unique" }
  | { type: "unique_by_asset_hash" }
  | { type: "mapurl"; template: string }
  | { type: "currency" }
  | { type: "capitalize" }
  | { type: "text_to_number" }
  | { type: "rating_text_to_number" }
  | { type: "extract_field_to_array"; fieldNames: string[] }
  | { type: "pair_with_separator"; field1: string; field2: string; separator: string }
  | { type: "count_bullets_clean" }
  | { type: "count_words" }
  | { type: "count_words_no_bullet" }
  | { type: "count_charactes_no_bullet" }
  | { type: "clean_product_description" }
  | { type: "extract_from_square_brackets" }
  | { type: "clean_tiktok_product_description" }
  | { type: "boolean_to_number" }
  | { type: "boolean_to_stock" }
  | { type: "transform_to_stock" }
  | { type: "boolean_to_text" }
  | { type: "rating_average" }
  | { type: "contain"; value: string }
  | { type: "not_contain"; value: string }
  | { type: "transform_lazada_sku_name" }
  | { type: "contain_image" }
  | { type: "extract_product_desc_images" }
  | { type: "object_values" }
  | { type: "json_stringify" }
  | { type: "null_if"; value: string };

export interface OperationRuntimeContext {
  /** The mapping's own resolved `region` column value, reused by `{region}` in `mapurl`. */
  region?: string;
}

export type OperationHandler<K extends Operation["type"] = Operation["type"]> = (
  value: unknown,
  operation: Extract<Operation, { type: K }>,
  context?: Record<string, unknown>,
  runtime?: OperationRuntimeContext,
) => unknown;
