

export type GitRun = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
};

export type StatusEntry = {
  readonly path: string;
  readonly index_status: string;
  readonly worktree_status: string;
  readonly untracked: boolean;
  readonly ignored: boolean;
  readonly original_path?: string;
};

export type ParsedStatus = {
  readonly branch: Record<string, unknown>;
  readonly entries: readonly StatusEntry[];
  readonly ahead?: number;
  readonly behind?: number;
  readonly truncated: boolean;
};

export type GitPath = {
  readonly rootPath: string;
  readonly relativePath: string;
};

export type IsolatedGitContext = {
  readonly directory: string;
  readonly commandCwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
};

export type { GitServiceOptions } from "./public-contracts.js";
