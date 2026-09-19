

export const MAX_PATCH_BYTES = 1_048_576;

export const MAX_TEXT_FILE_BYTES = 4 * 1_024 * 1_024;

export const MAX_TOTAL_BASELINE_BYTES = 32 * 1_024 * 1_024;

export const MAX_PATCH_LINES = 20_000;

export const MAX_PATCH_OPERATIONS = 128;

export const MAX_HUNKS = 512;

export const MAX_HUNK_LINES = 4_096;

export const MAX_MATCH_COMPARISONS = 2_000_000;

export const MAX_PATH_ATTEMPTS = 16;

// still preserved so executable scripts retain their intended mode.
export const REGULAR_FILE_MODE_MASK = 0o0777;

export const SHA256 = /^[a-f0-9]{64}$/;
