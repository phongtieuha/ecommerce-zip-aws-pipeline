// Shared types
export type {
  ParsedRow,
  ParseResult,
  ExtractedFile,
  ZipExtractionResult,
  MappingSelectionRule,
} from "./types";

// HTML parser exports
export { parseHTML, streamHTMLFromZip } from "./html";
export { getHtmlNestedValue, resolveHtmlSelectorValue } from "./html/path-resolver";

// JSON parser exports
export { parseJSON, extractJSONFromZip, streamJSONFromZip } from "./json";

// Companion file join (e.g. a sibling description/*.html joined into JSON rows)
export { loadCompanionFileMap, companionStemOf } from "./companion";
export type { CompanionFileMap } from "./companion";
