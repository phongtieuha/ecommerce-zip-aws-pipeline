import argparse
import csv
from pathlib import Path


def _coerce_is_ad(value) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return 1 if int(value) == 1 else 0
    normalized = str(value).strip().lower()
    return 1 if normalized in {"1", "true", "t", "yes", "y"} else 0


def _resolve_keyword_column(fieldnames: list[str]) -> str:
    if "search_keyword" in fieldnames:
        return "search_keyword"
    if "keyword" in fieldnames:
        return "keyword"
    raise ValueError("Missing keyword column: expected 'search_keyword' or 'keyword'.")


def _resolve_region_column(fieldnames: list[str]) -> str | None:
    return "region" if "region" in fieldnames else None


def add_rankings(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    if not rows:
        return rows

    keyword_col = _resolve_keyword_column(list(rows[0].keys()))
    region_col = _resolve_region_column(list(rows[0].keys()))
    if "is_ad" not in rows[0]:
        raise ValueError("Missing required column: 'is_ad'.")

    ads_r = []
    organic_r = []
    overall_r = []

    a_count = 0
    o_count = 0
    t_count = 0
    keyword = None
    region = None

    for row in rows:
        current_keyword = row[keyword_col]
        current_region = row[region_col] if region_col else None

        # Reset counters whenever keyword/region partition changes.
        if current_keyword != keyword or current_region != region:
            keyword = current_keyword
            region = current_region
            a_count = 0
            o_count = 0
            t_count = 0

        t_count += 1
        overall_r.append(t_count)

        if _coerce_is_ad(row.get("is_ad")) == 1:
            a_count += 1
            ads_r.append(a_count)
            organic_r.append(o_count)
        else:
            o_count += 1
            ads_r.append(0)
            organic_r.append(o_count)

    ranked_rows: list[dict[str, str]] = []
    for i, row in enumerate(rows):
        enriched = dict(row)
        enriched["download_rank"] = str(i + 1)
        enriched["ads_ranking"] = str(ads_r[i])
        enriched["organic_ranking"] = str(organic_r[i])
        enriched["overall_ranking"] = str(overall_r[i])
        ranked_rows.append(enriched)

    return ranked_rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calculate download/ad/organic/overall rankings for share-of-search data."
    )
    parser.add_argument("input", help="Input CSV path")
    parser.add_argument("-o", "--output", help="Output CSV path (defaults to input stem + _ranked.csv)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    output_path = Path(args.output) if args.output else input_path.with_name(f"{input_path.stem}_ranked.csv")

    with input_path.open(newline="", encoding="utf-8-sig") as input_file:
        reader = csv.DictReader(input_file)
        if reader.fieldnames is None:
            raise ValueError("Input CSV is missing a header row.")
        rows = list(reader)

    ranked_rows = add_rankings(rows)

    output_fieldnames = list(reader.fieldnames)
    for col in ["download_rank", "ads_ranking", "organic_ranking", "overall_ranking"]:
        if col not in output_fieldnames:
            output_fieldnames.append(col)

    with output_path.open("w", newline="", encoding="utf-8") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=output_fieldnames)
        writer.writeheader()
        writer.writerows(ranked_rows)

    print(f"Wrote ranked CSV: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
