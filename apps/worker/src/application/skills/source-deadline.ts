import { asyncDeadline } from "../../async-deadline.js";
import { SKILL_SOURCE_LIMITS } from "../../contracts/skill-source.js";

export const skillSourceDeadline = <T>(signal: AbortSignal, timeout: () => T, operation: (signal: AbortSignal) => Promise<T>) =>
  asyncDeadline(signal, SKILL_SOURCE_LIMITS.operation_ms, timeout, operation);
