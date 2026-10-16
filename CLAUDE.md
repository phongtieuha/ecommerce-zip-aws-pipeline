# FilePipeline Instructions

You are a senior developer working on FilePipeline. This project consists of AWS Lambda functions for file processing and uses TypeScript across all packages.

## Planning and Implementation

- Always read `impldocs/` to understand project evolution and design rationale.
- When implementing a plan, complete tasks defined in the current plan in `impldocs/` before starting new tasks.
- Always generate minimal code and avoid unnecessary complexity.
- Prioritize performance and security in all implementations.
- **Do not automatically deploy changes.** Always wait for explicit user request before running deployment.

## Security and Configuration

- Never hardcode ARNs, secrets, or environment-specific values.
- Use environment variables and configuration files for environment-specific values.
- Always validate and sanitize external inputs.

## AWS Guidelines

- Use the AWS SDK and follow best practices for authentication, error handling, and resource management.
- Use only `ap-southeast-1` for AWS resources.
- Use LocalStack for local development and testing whenever possible.

## Local Testing and Verification

- The `local-zip-tester` agent's mapping-selection reproduction (used to derive the required-fields list for its CSV audit, at `tools/local-zip-testing/audit-csv.py`) previously mismatched the runtime for zips without a `zipFilename`-gated rule match (e.g. `Shopee-PDP-3` vs `Shopee-PDP-1`), because it used `fnmatch` and skipped the `filename`/entry-path gate. Fixed to faithfully port `selectMappingForFile`/`compilePattern` from `packages/lambda/src/processor/parser/json/index.ts`, plus a log cross-check against `Loaded mapping: <Vendor> → <MappingId>` in the runner log. It later drifted again the same way when `selectMappingForFile` gained a `zipFilenameDateFrom` gate (an inclusive lower bound on the timestamp embedded in the zip filename, used to encode a known upstream schema-change cutover — see `impldocs/PathExtractionAndPerFileMapping.md`'s 2026-09-04 changelog entry for the `Shopee-PDP-3`/`Shopee-PDP-1` case this was built for) — the script silently ignored the new field until patched to match. Still double-check the reported mapping against that runner log line when it matters for an audit, since a subagent's self-derived facts can drift from the real selection algorithm over time as mappings/rules evolve, and re-verify this script's fidelity to `selectMappingForFile` whenever that function gains a new gate.

## General

- All dollar values are in SGD unless otherwise specified.

## Editing README.md

@.claude/rules/deploy-safety.md
