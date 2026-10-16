// Utility to extract country code from a folder path inside a zip
// Accepts paths like: Mobile_Price_Lite/ID_shops/..., Mobile_Price_Lite/id/..., Mobile_Price_Lite/ID/...
// Returns the country code in uppercase (e.g., 'ID') or null if not found

export function extractCountryFromPath(path: string): string | null {
  // Split path into segments
  const segments = path.split("/").filter(Boolean);
  // Look for a segment that matches country code pattern
  for (const segment of segments) {
    // Match 'ID', 'id', 'ID_shops', etc.
    const match = segment.match(/^([a-zA-Z]{2})(?:[_-].*)?$/);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}
