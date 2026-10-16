import { compilePattern } from "./json/index";
import { extractHtmlBody } from "./html/index";

export type CompanionFileMap = ReadonlyMap<string, string>;

// Lowercased so a companion file's casing doesn't have to match its JSON
// counterpart exactly — filePattern matching (compilePattern) is already
// case-insensitive, so the join key should be too.
function stemOf(path: string): string {
  const base = path.split("/").pop() || path;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * Buffers every ZIP entry matching `filePattern` and extracts each entry's
 * <body> content, keyed by filename stem (e.g. "TP00000780002158" for
 * "description/output/TP00000780002158.html"). Used to join a companion
 * file from the same ZIP into JSON rows — see VendorMapping.companionSource.
 */
export async function loadCompanionFileMap(
  zipBuffer: Buffer,
  filePattern: string,
): Promise<CompanionFileMap> {
  const unzipper = await import("unzipper");
  const directory = await unzipper.Open.buffer(zipBuffer);
  const pattern = compilePattern(filePattern);
  const map = new Map<string, string>();

  for (const entry of directory.files) {
    if (entry.type !== "File" || !pattern.test(entry.path)) continue;
    const content = (await entry.buffer()).toString("utf-8");
    map.set(stemOf(entry.path), extractHtmlBody(content));
  }

  return map;
}

export { stemOf as companionStemOf };
