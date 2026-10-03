/** Parsed transport observations. A receipt is evidence, never an authorization grant. */
export type JsonReceipt = { readonly status: number; readonly value?: unknown } | undefined;
export type McpIdentityVerifier = (secretVerifier: string) => Promise<JsonReceipt>;
export type AuthThrottleKind = "login" | "setup";
export interface AuthThrottlePorts {
  check(kind: AuthThrottleKind): Promise<JsonReceipt>;
  record(kind: AuthThrottleKind, success: boolean): Promise<void>;
}
export interface EnrollmentPorts {
  randomCode(): string;
  digest(code: string): Promise<string>;
  create(runnerId: string, payload: Record<string, unknown>): Promise<JsonReceipt>;
}
export interface RunnerQueryPorts {
  execution(runnerId: string): Promise<JsonReceipt>;
  readiness(runnerId: string): Promise<JsonReceipt>;
  rpc(runnerId: string, method: string, params: Record<string, unknown>, revision: number, checksum: string): Promise<JsonReceipt>;
}
