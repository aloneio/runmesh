/** Pure capacity calculation; JobManager remains the only accounting owner. */
export function availableLogBytes(jobBytes: number, totalBytes: number, perJobLimit: number, totalLimit: number): number {
  return Math.max(0, Math.min(perJobLimit - jobBytes, totalLimit - totalBytes));
}
