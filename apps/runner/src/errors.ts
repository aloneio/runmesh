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
  readonly details?: Record<string, unknown>;
} | undefined {
  if (error instanceof RpcRuntimeError) {
    return {
      code: error.code,
      message: error.message.slice(0, 4_096),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return undefined;
}
