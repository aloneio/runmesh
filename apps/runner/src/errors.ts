import { failureMetadata, type RpcFailureClass, type RpcNextAction, type RpcOperationState } from "@aloneio/runmesh-protocol";
export { failureMetadata };
export type { RpcFailureClass, RpcNextAction, RpcOperationState } from "@aloneio/runmesh-protocol";

export class RpcRuntimeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RpcRuntimeError";
  }
}

export function asRpcError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly failure_class: RpcFailureClass;
  readonly operation_state: RpcOperationState;
  readonly retry_after_ms?: number;
  readonly next_action: RpcNextAction;
  readonly details?: Record<string, unknown>;
} | undefined {
  if (error instanceof RpcRuntimeError) {
    return {
      code: error.code,
      message: error.message.slice(0, 4_096),
      ...failureMetadata(error.code),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return undefined;
}
