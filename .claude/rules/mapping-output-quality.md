# FilePipeline Mapping and Parser Output Quality Rules

- Preserve output schema stability unless the user explicitly requests schema changes.
- Avoid duplicate semantic columns in consolidated output unless explicitly required.
- Prefer one canonical normalized field for downstream CSV consumption.
- Keep null and empty handling explicit and deterministic.
- Make required-field checks explicit and avoid silent pass-through due to empty mapping sources.
- Treat sentinel values such as `-1` and `0` intentionally and avoid accidental introduction.
- Keep numeric field formatting consistent and predictable across rows.
- For high-volume archives, avoid per-entry noisy logs and prefer throttled progress logging.
- Keep transformations linear and avoid repeated expensive parsing per row.
- Verify changed fields appear as intended in output and clearly call out any expected null-heavy columns.
