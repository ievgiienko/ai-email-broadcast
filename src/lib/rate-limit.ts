/**
 * Rate-limit arithmetic, kept pure so it can be tested without a database.
 *
 * The window is a rolling hour: we count SMTP attempts logged in the last 60
 * minutes rather than resetting on the hour, which would allow a 2x burst
 * across a boundary.
 */

/** Fraction of the configured ceiling we actually aim for. */
export const DEFAULT_SAFETY_FACTOR = 0.95;

export function safetyFactor(): number {
  const raw = Number(process.env.SMTP_RATE_SAFETY_FACTOR);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_SAFETY_FACTOR;
}

/** Effective hourly ceiling after the safety margin. */
export function effectiveHourlyLimit(maxPerHour: number, factor = safetyFactor()): number {
  if (!Number.isFinite(maxPerHour) || maxPerHour <= 0) return 0;
  return Math.max(1, Math.floor(maxPerHour * factor));
}

/** How many sends are still permitted in the current rolling hour. */
export function remainingAllowance(maxPerHour: number, sentInLastHour: number, factor = safetyFactor()): number {
  return Math.max(0, effectiveHourlyLimit(maxPerHour, factor) - Math.max(0, sentInLastHour));
}

/**
 * Batch size for one worker invocation: bounded by the remaining hourly
 * allowance, the configured batch cap, and a per-tick share so a single tick
 * doesn't consume the whole hour's quota in one burst.
 */
export function batchSize(options: {
  maxPerHour: number;
  sentInLastHour: number;
  batchCap: number;
  tickIntervalSeconds: number;
  factor?: number;
}): number {
  const { maxPerHour, sentInLastHour, batchCap, tickIntervalSeconds } = options;
  const allowance = remainingAllowance(maxPerHour, sentInLastHour, options.factor);
  if (allowance <= 0) return 0;

  const perTickShare = Math.ceil(
    (effectiveHourlyLimit(maxPerHour, options.factor) * Math.max(1, tickIntervalSeconds)) / 3600,
  );
  return Math.max(0, Math.min(allowance, batchCap, perTickShare));
}

/** Estimated wall-clock duration for a campaign, in seconds. */
export function estimateDurationSeconds(recipientCount: number, maxPerHour: number, factor = safetyFactor()): number {
  const limit = effectiveHourlyLimit(maxPerHour, factor);
  if (limit <= 0 || recipientCount <= 0) return 0;
  return Math.ceil((recipientCount / limit) * 3600);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "less than a minute";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return minutes <= 1 ? "about a minute" : `about ${minutes} minutes`;
  if (minutes === 0) return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
  return `about ${hours}h ${minutes}m`;
}

/**
 * Retry backoff. Attempt 1 failed -> wait 1 minute, attempt 2 -> 5, attempt 3 -> 15.
 * After MAX_ATTEMPTS the recipient is marked FAILED and never retried.
 */
export const MAX_ATTEMPTS = Number(process.env.SMTP_MAX_ATTEMPTS ?? 3);

export function retryDelaySeconds(attempts: number): number {
  const ladder = [60, 300, 900];
  return ladder[Math.min(attempts, ladder.length) - 1] ?? 900;
}

export function shouldRetry(attempts: number, permanent: boolean, maxAttempts = MAX_ATTEMPTS): boolean {
  if (permanent) return false;
  return attempts < maxAttempts;
}
