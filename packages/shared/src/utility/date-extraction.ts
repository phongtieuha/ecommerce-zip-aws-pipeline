// Canonical filename date extractor, shared by the processor, coordinator,
// and S3 key parsing utilities so they can't drift apart on which date
// formats are recognized (previously each had its own copy; the coordinator's
// copy fell behind and silently dropped files from the consolidated CSV).
//
// Supported formats, first match wins:
// - YYYY-MM-DD           (e.g. "..._2026-03-24_00_10.zip")
// - DD-MM-YYYY           (e.g. "..._24-03-2026_00_10.zip")
// - YYYYMMDD             (e.g. "..._20260401.zip"), optionally followed by
//                          "Thhmmss" (e.g. "20260324T094025_...")
//
// Returns null if no date is found, or if the digits don't form a real
// calendar date.

function toIsoDate(year: string, month: string, day: string): string | null {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);

  if (!Number.isInteger(yyyy) || !Number.isInteger(mm) || !Number.isInteger(dd)) {
    return null;
  }

  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

export function extractDateFromFilename(filename: string): string | null {
  // Format 1: ...2026-03-24... (hyphenated year-month-day)
  const hyphenatedMatch = filename.match(/(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)/);
  if (hyphenatedMatch) {
    return toIsoDate(hyphenatedMatch[1], hyphenatedMatch[2], hyphenatedMatch[3]);
  }

  // Format 2: ...24-03-2026... (day-month-year)
  const dayMonthYearMatch = filename.match(/(?:^|[^\d])(\d{2})-(\d{2})-(\d{4})(?:[^\d]|$)/);
  if (dayMonthYearMatch) {
    return toIsoDate(dayMonthYearMatch[3], dayMonthYearMatch[2], dayMonthYearMatch[1]);
  }

  // Format 3: ...20260324T094025... or ...-20260401.zip (compact year-month-day,
  // with or without a Thhmmss suffix)
  const compactMatch = filename.match(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?=T\d{6}|[^\d]|$)/);
  if (compactMatch) {
    return toIsoDate(compactMatch[1], compactMatch[2], compactMatch[3]);
  }

  return null;
}
