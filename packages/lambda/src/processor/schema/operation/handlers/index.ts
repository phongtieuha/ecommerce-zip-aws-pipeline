import { handleBooleanToNumber } from "./boolean-to-number.js";
import { handleBooleanToStock } from "./boolean-to-stock.js";
import { handleBooleanToText } from "./boolean-to-text.js";
import { handleCapitalize } from "./capitalize.js";
import { handleCleanProductDescription } from "./clean-product-description.js";
import { handleCleanTikTokProductDescription } from "./clean-tiktok-product-description.js";
import { handleConcat } from "./concat.js";
import { handleConcatField } from "./concat-field.js";
import { handleContainImage } from "./contain-image.js";
import { handleContain } from "./contain.js";
import { handleCountBulletsClean } from "./count-bullets-clean.js";
import { handleCountCharactesNoBullet } from "./count-charactes-no-bullet.js";
import { handleCountWordsNoBullet } from "./count-words-no-bullet.js";
import { handleCountWords } from "./count-words.js";
import { handleCurrency } from "./currency.js";
import { handleDate } from "./date.js";
import { handleDivide } from "./divide.js";
import { handleEq } from "./eq.js";
import { handleExtractFieldToArray } from "./extract-field-to-array.js";
import { handleExtractFromSquareBrackets } from "./extract-from-square-brackets.js";
import { handleExtractProductDescImages } from "./extract-product-desc-images.js";
import { handleFilter } from "./filter.js";
import { handleFilterByPrefix } from "./filter-by-prefix.js";
import { handleFilterEmptyStrings } from "./filter-empty-strings.js";
import { handleFind } from "./find.js";
import { handleFirst } from "./first.js";
import { handleFlatten } from "./flatten.js";
import { handleGet } from "./get.js";
import { handleGt } from "./gt.js";
import { handleJoin } from "./join.js";
import { handleJsonStringify } from "./json-stringify.js";
import { handleLast } from "./last.js";
import { handleLength } from "./length.js";
import { handleMapurl } from "./mapurl.js";
import { handleMax } from "./max.js";
import { handleMin } from "./min.js";
import { handleNotContain } from "./not-contain.js";
import { handleNullIf } from "./null-if.js";
import { handleObjectValues } from "./object-values.js";
import { handlePairWithSeparator } from "./pair-with-separator.js";
import { handleRatingAverage } from "./rating-average.js";
import { handleRatingTextToNumber } from "./rating-text-to-number.js";
import { handleSplit } from "./split.js";
import { handleSum } from "./sum.js";
import { handleTextToNumber } from "./text-to-number.js";
import { handleTransformLazadaSkuName } from "./transform-lazada-sku-name.js";
import { handleTransformToStock } from "./transform-to-stock.js";
import { handleUnique } from "./unique.js";
import { handleUniqueByAssetHash } from "./unique-by-asset-hash.js";
import type { Operation, OperationHandler } from "../types.js";

export const operationHandlers: {
  [K in Operation["type"]]: OperationHandler<K>;
} = {
  boolean_to_number: handleBooleanToNumber,
  boolean_to_stock: handleBooleanToStock,
  boolean_to_text: handleBooleanToText,
  capitalize: handleCapitalize,
  clean_product_description: handleCleanProductDescription,
  clean_tiktok_product_description: handleCleanTikTokProductDescription,
  concat: handleConcat,
  concat_field: handleConcatField,
  contain: handleContain,
  contain_image: handleContainImage,
  count_bullets_clean: handleCountBulletsClean,
  count_charactes_no_bullet: handleCountCharactesNoBullet,
  count_words: handleCountWords,
  count_words_no_bullet: handleCountWordsNoBullet,
  currency: handleCurrency,
  date: handleDate,
  divide: handleDivide,
  eq: handleEq,
  extract_field_to_array: handleExtractFieldToArray,
  extract_from_square_brackets: handleExtractFromSquareBrackets,
  extract_product_desc_images: handleExtractProductDescImages,
  filter: handleFilter,
  filter_by_prefix: handleFilterByPrefix,
  filter_empty_strings: handleFilterEmptyStrings,
  find: handleFind,
  first: handleFirst,
  flatten: handleFlatten,
  get: handleGet,
  gt: handleGt,
  join: handleJoin,
  json_stringify: handleJsonStringify,
  last: handleLast,
  length: handleLength,
  mapurl: handleMapurl,
  max: handleMax,
  min: handleMin,
  not_contain: handleNotContain,
  null_if: handleNullIf,
  object_values: handleObjectValues,
  pair_with_separator: handlePairWithSeparator,
  rating_average: handleRatingAverage,
  rating_text_to_number: handleRatingTextToNumber,
  split: handleSplit,
  sum: handleSum,
  text_to_number: handleTextToNumber,
  transform_lazada_sku_name: handleTransformLazadaSkuName,
  transform_to_stock: handleTransformToStock,
  unique: handleUnique,
  unique_by_asset_hash: handleUniqueByAssetHash,
};
