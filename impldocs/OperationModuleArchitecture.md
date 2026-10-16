# Operation Module Architecture

**Date**: July 1, 2026  
**Status**: Implemented  
**Project**: FilePipeline

## Purpose

This document describes the refactor of the operation engine used by schema mapping evaluation in the Lambda processor.

Goal of the refactor:

- Keep the public operation API stable.
- Reduce size and complexity of a single large file.
- Make adding or changing one operation low-risk.

## Current Structure

Operation code now lives under:

- `packages/lambda/src/processor/schema/operation/`

Main files:

- `index.ts`: coordination entry point only.
- `types.ts`: operation union type and handler-related types.
- `parser.ts`: path operation parsing (`parseOperation`).
- `helpers.ts`: shared helper utilities used by multiple handlers.
- `handlers/index.ts`: operation-type to handler registry.
- `handlers/*.ts`: one file per operation implementation.

## Runtime Flow

1. Mapping source text is parsed by `parseOperation` in `parser.ts`.
2. Parsed operation type is dispatched by `applyOperation` in `index.ts`.
3. `applyOperation` selects a handler from `handlers/index.ts`.
4. Specific handler executes operation logic and returns transformed output.

## Public Contract

The contract remains:

- `parseOperation(path)`
- `applyOperation(value, operation, context?, runtime?)`
- `Operation` type union

Callers in parser/validation/path resolvers continue to consume these symbols via schema operation imports.

## How To Add A New Operation

1. Add a new operation type to `types.ts`.
2. Add parser support in `parser.ts` (`parseOperationPart`).
3. Create handler file in `handlers/` (single operation per file).
4. Register the handler in `handlers/index.ts`.
5. Ensure `index.ts` dispatch can route to the new handler through the registry.
6. Update any mapping JSON sources to use the new operation token where needed.
7. Run `bun run build:lambda`.

## Handler Guidelines

- Keep handlers pure and deterministic.
- Return `undefined` when operation cannot be applied (unless operation semantics require explicit default values).
- Avoid side effects and external service calls.
- Reuse `helpers.ts` for shared logic to avoid duplication.
- Keep data-shape handling explicit for `null`, empty strings, arrays, and objects.

## Notes For Future Refactors

- Keep `index.ts` small and orchestration-only.
- Prefer small, focused handler files over grouped multi-operation files.
- If multiple handlers share parsing or normalization logic, move it into `helpers.ts`.
- Preserve operation token compatibility to avoid mapping regressions.

## Worked Examples

These docs describe specific operations built on this module structure:

- `impldocs/ContainImageOperation.md` — `contain_image`
- `impldocs/CountProductDescriptionOperation.md` — `clean_product_description` and related description-counting operations
- `impldocs/MultiRegionBulletPointAnalysis.md` — `count_bullets_clean`, `count_charactes_no_bullet`, and other per-country text-analysis operations
