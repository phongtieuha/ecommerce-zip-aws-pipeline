import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_DISPLAY_NAME } from "../constants/channel-display-names";

interface VendorMappingPaths {
  readonly vendorDir: string;
  readonly indexFile: string;
}

function getVendorMappingPaths(mappingsDir: string, vendor: string): VendorMappingPaths {
  const vendorDir = join(mappingsDir, vendor);
  return {
    vendorDir,
    indexFile: join(vendorDir, "index.json"),
  };
}

function resolveMappingsDir(): string | null {
  const candidateDirs = [join("/var/task", "mappings"), join(process.cwd(), "mappings")];

  for (const dir of candidateDirs) {
    if (existsSync(dir)) return dir;
  }

  return null;
}

/**
 * Convert a slug (lowercase) to the directory name using CHANNEL_DISPLAY_NAME mapping.
 * For example: "jd" -> "JD", "lazada" -> "Lazada", "711" -> "711"
 */
function slugToDirectoryName(slug: string): string {
  // Try exact match first
  const directoryName = CHANNEL_DISPLAY_NAME[slug];
  if (directoryName) return directoryName;

  // Fall back to the slug itself (in case it's already a directory name)
  return slug;
}

export function isVendorSupported(vendor: string): boolean {
  const normalizedVendor = vendor.trim();
  if (!normalizedVendor) return false;

  const mappingsDir = resolveMappingsDir();
  if (!mappingsDir) return false;

  // Convert slug to directory name (e.g. "jd" -> "JD", "lazada" -> "Lazada")
  const directoryName = slugToDirectoryName(normalizedVendor);

  const { vendorDir, indexFile } = getVendorMappingPaths(mappingsDir, directoryName);
  return existsSync(vendorDir) && existsSync(indexFile);
}
