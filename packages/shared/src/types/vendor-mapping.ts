export type FieldType = "string" | "number" | "boolean" | "array";
export type MappingParser = "json" | "html";
export type RankingComputationKind = "download" | "ads" | "organic" | "overall";

export interface ComputedFieldConfig {
  readonly type: "ranking";
  readonly kind: RankingComputationKind;
  readonly dependsOn?: string;
}

export interface FieldMapping {
  // Source path syntax:
  // - Relative (default): "price_info.sale_price"
  // - Absolute from original file root: "$root.data.mainInfo.currency"
  // - Runtime S3 metadata: "$s3.country", "$s3.vendor", "$s3.key"
  readonly source?: string;
  readonly compute?: ComputedFieldConfig;
  readonly required?: boolean;
  readonly type?: FieldType;
  readonly default?: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: string;
  // Conditional output: field included in CSV only if condition evaluates to true
  // Supports: ===, !==, >, >=, <, <=, &&, ||, +, string concatenation
  // Example: "field1 + '_' + field2 === field3"
  readonly outputIf?: string;
  // Find: search the row's top-level arrays for the first element matching a condition
  // The matched element is bound as `value` for source path resolution
  // Example: "formType|eq:5" → finds first item in any array where formType == 5
  readonly find?: string;
  // Filter: pre-filter an array resolved from source before applying pipe operations
  // Applies a condition to each element, keeping only those that match
  // Example: "type|eq:img" → keeps only items where type equals "img"
  readonly filter?: string;
}

/**
 * Output columns - 59 fields
 * Standard unified schema that all vendors map to
 * Only the `source` field mappings vary between vendors
 */
export type OutputColumns = Record<
  | "ads_ranking"
  | "avg_rating"
  | "brand_id"
  | "brand_name"
  | "category_id"
  | "category_name"
  | "category_name_en"
  | "cnt_bonus_score"
  | "cnt_desc_score"
  | "cnt_img_score"
  | "cnt_title_score"
  | "cnt_total_score"
  | "cnt_vid_score"
  | "currency"
  | "download_rank"
  | "hist_sold"
  | "image_urls"
  | "is_ad"
  | "is_available"
  | "is_free_shipping"
  | "is_mart"
  | "is_official_shop"
  | "is_preferred_plus_seller"
  | "keyword_priority"
  | "l1_category"
  | "l2_category"
  | "l3_category"
  | "l4_category"
  | "liked_count"
  | "listed_on"
  | "manufacturer"
  | "num_bullets_update"
  | "num_images"
  | "num_vid"
  | "organic_ranking"
  | "overall_ranking"
  | "platform"
  | "sku_price_after_discount"
  | "sku_price_before_discount"
  | "price_max_after_discount"
  | "price_max_before_discount"
  | "price_min_after_discount"
  | "price_min_before_discount"
  | "product_desc"
  | "product_name"
  | "product_url"
  | "rating_count"
  | "rating_count_with_context"
  | "rating_count_with_image"
  | "recorded_on"
  | "region"
  | "review_count"
  | "search_keyword"
  | "shop_id"
  | "shop_location"
  | "shop_name"
  | "sku_name"
  | "small_cat"
  | "source_product_id"
  | "source_sku_id"
  | "stock"
  | "updated_num_words"
  | "video_urls"
  | "word_count",
  FieldMapping
>;

export interface VendorMapping {
  readonly vendor: string;
  // Parser hint for processor routing. Defaults to "json" when omitted.
  readonly parser?: MappingParser;
  readonly columns: OutputColumns;
  readonly pathExtraction?: {
    readonly path?: string;
    // JS expression evaluated against <script> tag contents from HTML.
    // The expression runs in a sandboxed VM with `window`, `document` stubs
    // and all inline scripts pre-executed. Result must be an array of objects.
    // When set, extracted rows use JSON dot-path field resolution (not CSS selectors).
    readonly scriptExpression?: string;
    readonly ignoreIfContains?: ReadonlyArray<{
      readonly path: string;
      readonly text: string | ReadonlyArray<string>;
      readonly caseInsensitive?: boolean;
    }>;
    readonly deduplicateByTimestamp?: {
      readonly pattern: string;
      /** Dot-path to the keyword field in the root JSON data.
       *  When set, files are sorted by this value (instead of the filename-extracted keyword)
       *  so that ranking runs over contiguous keyword groups. */
      readonly keywordPath?: string;
    };
  };
  /**
   * When set, each extracted row is expanded into multiple rows by iterating
   * over the array at `arrayPath`. The array element is injected into the row
   * data under the `$expansion` key so mapping sources can reference element
   * fields via `$expansion.<field>` (e.g. `$expansion.modelId`).
   */
  readonly rowExpansion?: {
    readonly arrayPath: string;
    /** When set, deduplicate expanded elements by this nested key (e.g. "skuId"). */
    readonly dedupKey?: string;
  };
  /**
   * When set, deduplicate rows based on partition fields and a unique key.
   * Rows are grouped by partitionBy fields, then within each partition,
   * only the first occurrence of each unique key is kept.
   */
  readonly rowDeduplication?: {
    readonly partitionBy: ReadonlyArray<string>;
    readonly key: string;
    readonly keep: "first" | "last";
  };
  /**
   * Joins a sibling file from the same ZIP into each JSON row, matched by
   * filename stem (e.g. "description/output/TP123.html" joins into rows from
   * "product_sku/output/TP123.json"). Needed because a single ZIP is only
   * ever parsed with one file type (see the "Mixed parser types" guard in
   * processor/index.ts) — this reads the companion file out-of-band and
   * injects its extracted <body> content under `injectAs`, so mapping
   * sources can reference it like any other field (e.g. "$description",
   * or "$description|clean_product_description" with a fallback via "||").
   */
  readonly companionSource?: {
    /** Zip-entry path pattern for the companion file, using the same {a|b} / * syntax as selectionRules.filename. */
    readonly filePattern: string;
    /** Key merged into each row's data, holding the companion file's extracted <body> text. */
    readonly injectAs: string;
  };
}

export interface VendorInfo {
  readonly name: string;
  readonly mappingFile: string;
  readonly fileCount?: number;
}
