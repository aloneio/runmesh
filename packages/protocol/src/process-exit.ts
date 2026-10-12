import { z } from "zod";

/** Preserve native signed exit statuses and unsigned Windows DWORD statuses. */
export const MIN_PROCESS_EXIT_CODE = -(2 ** 31);
export const MAX_PROCESS_EXIT_CODE = 2 ** 32 - 1;
export const ProcessExitCodeSchema = z.number().int().min(MIN_PROCESS_EXIT_CODE).max(MAX_PROCESS_EXIT_CODE);

export function isProcessExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_PROCESS_EXIT_CODE && value <= MAX_PROCESS_EXIT_CODE;
}
