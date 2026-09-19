

export interface GitServiceOptions {
  /** Test seam for a deliberately slow wrapper around git. */
  readonly executable?: string;
  /** Bound the subprocess lifetime; production defaults to eight seconds. */
  readonly timeoutMs?: number;
  /** Grace period between TERM and KILL when a process does not exit. */
  readonly killGraceMs?: number;
  /** Final bound after KILL so inherited pipes cannot stall the RPC forever. */
  readonly hardKillMs?: number;
}
