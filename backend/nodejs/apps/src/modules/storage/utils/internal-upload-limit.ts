/**
 * J-26: the agent harness's worker stores a run's inputs through the internal upload route as workspace objects,
 * so that route takes files as large as the deployment's largest input (`HARNESS_INPUT_MAX_MB`, read here as the
 * worker reads it), even where the platform's user-facing upload cap is lower.
 */
export const INPUT_MAX_ENV = 'HARNESS_INPUT_MAX_MB';
export const DEFAULT_INPUT_MAX_MB = 100;
const MIB = 1024 * 1024;

/** `HARNESS_INPUT_MAX_MB` in bytes: unset or blank is 100 MiB; anything but a positive whole number throws. */
export function harnessInputMaxBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = (env[INPUT_MAX_ENV] ?? '').trim();
  if (raw === '') return DEFAULT_INPUT_MAX_MB * MIB;
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(
      `${INPUT_MAX_ENV}=${JSON.stringify(raw)} is not a positive whole number of MiB`,
    );
  }
  return Number(raw) * MIB;
}

/** The internal upload route's cap: the platform's, or the deployment's largest input where that is larger. */
export function internalUploadMaxBytes(
  platformMaxBytes: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return Math.max(platformMaxBytes, harnessInputMaxBytes(env));
}
