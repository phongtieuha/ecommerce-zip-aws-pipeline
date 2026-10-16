/**
 * Operation coordination module.
 * Parser and handlers are split into dedicated files.
 */

import { operationHandlers } from "./handlers/index.js";
import type { Operation, OperationRuntimeContext } from "./types.js";

export type { Operation, OperationRuntimeContext } from "./types.js";
export { parseOperation } from "./parser.js";

export function applyOperation(
  value: unknown,
  operation: Operation,
  context?: Record<string, unknown>,
  runtime?: OperationRuntimeContext,
): unknown {
  const handler = operationHandlers[operation.type] as (
    value: unknown,
    operation: Operation,
    context?: Record<string, unknown>,
    runtime?: OperationRuntimeContext,
  ) => unknown;

  return handler(value, operation, context, runtime);
}
