// Type declarations for check-secret-logs.mjs (zero-dependency guard).
// Lets the vitest test import the detector while keeping `tsc --noEmit` green.

export interface SecretLogMatch {
  file: string;
  line: number;
  endLine: number;
  method: string;
  matched: string;
  snippet: string;
}

/** Find console.* calls that would log a credential value (unsuppressed). */
export function findSecretLogViolations(
  source: string,
  filename?: string,
): SecretLogMatch[];

/** Find console.* credential logs suppressed via an allow-secret-log comment. */
export function findSuppressedSecretLogs(
  source: string,
  filename?: string,
): SecretLogMatch[];

/** Strip string-literal contents, keep template `${…}` interpolations as code. */
export function codeOnly(source: string): string;
