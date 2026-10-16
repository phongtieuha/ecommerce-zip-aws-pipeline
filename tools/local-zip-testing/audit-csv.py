#!/usr/bin/env python3
import argparse
import csv
import json
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def parse_list_len(raw):
    if raw is None:
        return 0
    text = str(raw).strip()
    if text == "":
        return 0
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return len(parsed)
    except Exception:
        pass
    return len([x for x in text.split(",") if str(x).strip() != ""])


def parse_float(raw):
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "":
        return None
    try:
        return float(text)
    except Exception:
        return None


def extract_channel_and_request_type(csv_path: Path):
    raw = str(csv_path)

    channel = None
    request_type = None

    m = re.search(r"channel=([^/]+?)_request_type=", raw, flags=re.IGNORECASE)
    if m:
        channel = m.group(1)

    if channel is None:
        m = re.search(r"channel=([^/]+)/request_type=", raw, flags=re.IGNORECASE)
        if m:
            channel = m.group(1)

    m = re.search(r"request_type=([a-zA-Z0-9-]+)", raw, flags=re.IGNORECASE)
    if m:
        request_type = m.group(1)

    return channel, request_type


# Faithful port of compilePattern()/matchPattern() from
# packages/lambda/src/processor/parser/json/index.ts:127-173. Supports "*" as
# a wildcard and "{a|b|c}" as alternation. Do not re-derive this with fnmatch,
# which cannot express "{a|b|c}" and silently mismatches path-shaped patterns.
# Also translates JS-style named groups "(?<name>...)" (used by e.g.
# mappings/Tiktok/index.json's shop_name capture) to Python's "(?P<name>...)"
# syntax — `re` raises `re.PatternError: unknown extension ?<s` on the raw JS
# form instead of silently mismatching, so this was caught immediately rather
# than drifting quietly, but still needs the translation to actually compile.
def compile_pattern(pattern: str) -> "re.Pattern":
    regex_like = re.search(r"[{}\\+()\[\]^$|]", pattern) is not None
    if regex_like:
        def repl(m):
            opts = [x.strip() for x in m.group(1).split("|") if x.strip()]
            return "(" + "|".join(opts) + ")"

        transformed = re.sub(r"\{([^{}]+)\}", repl, pattern)
        transformed = transformed.replace("*", ".*")
        transformed = re.sub(r"\(\?<([^>]+)>", r"(?P<\1>", transformed)
    else:
        transformed = re.sub(r"[.+?^${}()|\[\]\\]", lambda m: "\\" + m.group(0), pattern)
        transformed = transformed.replace("*", ".*")
    return re.compile("^" + transformed + "$", re.IGNORECASE)


def match_pattern(value: str, pattern: str) -> bool:
    if value == pattern:
        return True
    return compile_pattern(pattern).match(value) is not None


# Faithful port of extractDateFromZipFilename() from
# packages/lambda/src/processor/parser/json/index.ts:180-192. Supports either
# "YYYYMMDDTHHMMSS" (Shopee-style) or "YYYY-MM-DD_HH_MM" (TikTok-style, e.g.
# "..._2026-09-14_12_56.zip") — the latter was added when Tiktok-Products-2
# introduced a zipFilenameDateFrom gate using this filename format; missing it
# here would silently resolve the wrong mapping for zips tested near that cutover.
def extract_date_from_zip_filename(zip_filename: str):
    m = re.search(r"(\d{4})(\d{2})(\d{2})T\d{6}", zip_filename) or re.search(
        r"(\d{4})-(\d{2})-(\d{2})_\d{2}_\d{2}", zip_filename
    )
    if not m:
        return None
    year, month, day = m.groups()
    try:
        return datetime(int(year), int(month), int(day), tzinfo=timezone.utc)
    except ValueError:
        return None


def find_zip_for_csv(repo_root: Path, csv_path: Path) -> Path:
    zip_name = re.sub(r"_processed\.csv$", ".zip", csv_path.name, flags=re.IGNORECASE)
    matches = list((repo_root / "test-data").rglob(zip_name))
    if not matches:
        raise SystemExit(
            f"ZIP_NOT_FOUND=Could not locate source zip '{zip_name}' under test-data/; "
            "pass --zip <path> explicitly to resolve the mapping accurately"
        )
    return matches[0]


# Faithful port of selectMappingForFile() from
# packages/lambda/src/processor/parser/json/index.ts:197-230 — first-match-wins
# across requestType -> zipFilename -> zipFilenameDateFrom -> filename gates. A
# prior version of this function matched only on requestType and ignored the
# zipFilename/filename gates entirely, which could resolve to the wrong
# mapping (and thus the wrong required-fields list) whenever a channel has
# multiple mappings per requestType selected by zip/entry naming (e.g. Shopee
# product-skus' Shopee-PDP-3 vs Shopee-PDP-1). zipFilenameDateFrom was added
# later as an inclusive lower bound on the timestamp embedded in the zip
# filename, gating a rule to only zips at/after a known upstream schema-change
# cutover — omitting it here silently resolves the wrong mapping for any zip
# tested near such a cutover date.
def select_mapping_for_file(index: dict, request_type: str, zip_filename: str, entry_path: str, entry_basename: str):
    for rule in index.get("selectionRules", []):
        if not rule.get("filename") or not rule.get("mappingId"):
            continue
        if rule.get("requestType") and rule["requestType"] != request_type:
            continue
        if rule.get("zipFilename") and not match_pattern(zip_filename, rule["zipFilename"]):
            continue
        if rule.get("zipFilenameDateFrom"):
            zip_date = extract_date_from_zip_filename(zip_filename)
            threshold = datetime.fromisoformat(rule["zipFilenameDateFrom"]).replace(tzinfo=timezone.utc)
            if zip_date is None or zip_date < threshold:
                continue
        target = entry_path if "/" in rule["filename"] else entry_basename
        if match_pattern(target, rule["filename"]):
            return rule["mappingId"]
    return None


def resolve_mapping(
    repo_root: Path,
    channel: str,
    request_type: str,
    zip_filename: str,
    entry_path: str,
    entry_basename: str,
):
    mappings_root = repo_root / "mappings"
    vendor_dir = next(
        (d for d in mappings_root.iterdir() if d.is_dir() and d.name.lower() == channel.lower()),
        None,
    )
    if vendor_dir is None:
        raise SystemExit(f"CHANNEL_NOT_FOUND={channel}")

    index_path = vendor_dir / "index.json"
    if not index_path.exists():
        raise SystemExit(f"INDEX_NOT_FOUND={index_path}")

    index = json.load(open(index_path, encoding="utf-8"))
    mappings = {m["id"]: m["file"] for m in index.get("mappings", [])}

    mapping_id = select_mapping_for_file(index, request_type, zip_filename, entry_path, entry_basename)
    if not mapping_id:
        mapping_id = index.get("default")

    if not mapping_id or mapping_id not in mappings:
        raise SystemExit(
            f"MAPPING_RESOLUTION_FAILED channel={channel} request_type={request_type} zip={zip_filename}"
        )

    mapping_path = vendor_dir / mappings[mapping_id]
    if not mapping_path.exists():
        raise SystemExit(f"MAPPING_FILE_NOT_FOUND={mapping_path}")

    return mapping_id, mapping_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path")
    parser.add_argument(
        "--zip",
        dest="zip_path",
        help="Source zip that produced this CSV (auto-located under test-data/ by filename if omitted)",
    )
    args = parser.parse_args()

    csv_path = Path(args.csv_path).expanduser().resolve()
    if not csv_path.exists():
        raise SystemExit(f"CSV_NOT_FOUND={csv_path}")

    repo_root = Path(__file__).resolve().parents[2]

    channel, request_type = extract_channel_and_request_type(csv_path)
    if not channel or not request_type:
        raise SystemExit(
            "PATH_PARSE_FAILED=Expected 'channel=<name>' and 'request_type=<name>' in CSV path or filename"
        )

    zip_path = (
        Path(args.zip_path).expanduser().resolve()
        if args.zip_path
        else find_zip_for_csv(repo_root, csv_path)
    )
    if not zip_path.exists():
        raise SystemExit(f"ZIP_NOT_FOUND={zip_path}")

    with zipfile.ZipFile(zip_path) as zf:
        entry_path = next((n for n in zf.namelist() if n.lower().endswith(".json")), None)
    if entry_path is None:
        raise SystemExit(f"NO_JSON_ENTRIES_IN_ZIP={zip_path}")
    entry_basename = entry_path.rsplit("/", 1)[-1]

    mapping_id, mapping_path = resolve_mapping(
        repo_root, channel, request_type, zip_path.name, entry_path, entry_basename
    )
    mapping = json.load(open(mapping_path, encoding="utf-8"))
    required_fields = [k for k, v in mapping.get("columns", {}).items() if v.get("required")]

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        rows = list(reader)

    missing_required_columns = [c for c in required_fields if c not in headers]

    image_mismatch = 0
    video_mismatch = 0
    for row in rows:
        num_images = parse_float(row.get("num_images"))
        num_vid = parse_float(row.get("num_vid"))
        image_len = parse_list_len(row.get("image_urls"))
        video_len = parse_list_len(row.get("video_urls"))

        if int(num_images or 0) != image_len:
            image_mismatch += 1
        if int(num_vid or 0) != video_len:
            video_mismatch += 1

    pairs = []
    header_set = set(headers)
    for h in headers:
        if "_before_" in h:
            after_h = h.replace("_before_", "_after_")
            if after_h in header_set:
                pairs.append((h, after_h))

    violations_by_pair = defaultdict(int)
    for row in rows:
        for before, after in pairs:
            bv = parse_float(row.get(before))
            av = parse_float(row.get(after))
            if bv is None or av is None:
                continue
            if bv < av:
                violations_by_pair[f"{before}>={after}"] += 1

    print(f"CSV_PATH={csv_path}")
    print(f"ZIP_PATH={zip_path}")
    print(f"MAPPING_ID={mapping_id}")
    print(f"MAPPING_FILE={mapping_path}")
    print(f"ROW_COUNT={len(rows)}")
    print(f"REQUIRED_FIELDS_MISSING={len(missing_required_columns)}")
    print(
        "MISSING_REQUIRED_FIELDS="
        + ("|".join(missing_required_columns) if missing_required_columns else "N/A")
    )
    print(f"NUM_IMAGES_MISMATCH_ROWS={image_mismatch}")
    print(f"NUM_VID_MISMATCH_ROWS={video_mismatch}")
    print(f"BEFORE_AFTER_PAIRS_CHECKED={len(pairs)}")
    print(f"BEFORE_AFTER_VIOLATION_ROWS_TOTAL={sum(violations_by_pair.values())}")

    if violations_by_pair:
        detail = ";".join([f"{k}:{v}" for k, v in sorted(violations_by_pair.items())])
    else:
        detail = "N/A"

    print(f"BEFORE_AFTER_VIOLATIONS_BY_PAIR={detail}")


if __name__ == "__main__":
    main()
