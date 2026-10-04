// HTTP credentials must not contain C0/C1 control bytes or DEL.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function containsControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

/** Deployment secrets require 32–512 non-whitespace characters; generate them randomly. */
export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 512 && !/\s/u.test(value) && !containsControlCharacter(value);
}
