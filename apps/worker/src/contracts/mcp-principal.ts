import type { CodingScope } from "./administration.js";

export interface VerifiedMcpClient {
  /** Optional internal launch observation; never an execution grant. */
  readonly record_history?: boolean;
  readonly client_id: string;
  readonly label: string;
  readonly scopes: readonly CodingScope[];
  readonly secret_version: number;
}
