// PS99 has no API for its update schedule, so this is a fixed weekly anchor —
// same shape as the league bot's battleTimer.js. Confirmed by the user:
// updates land Sunday 2am AEST. AEST is a fixed UTC+10 offset with no DST, so
// anchoring to "AEST" specifically (rather than "Sydney time", which drifts to
// AEDT/UTC+11 for roughly half the year) keeps this correct year-round.
//
// Sunday 2am AEST = Saturday 16:00 UTC (2 - 10 = -8, +24 = 16, day rolls back
// one). This is a target, not a guarantee — PS99 can ship early, late, or skip
// a week entirely. The countdown says when the next update is DUE, not a
// promise one is coming.

const TARGET_UTC_DAY = 6; // Saturday in UTC (0 = Sunday ... 6 = Saturday)
const TARGET_UTC_HOUR = 16;

/**
 * Returns the next occurrence of "Sunday 2am AEST" at or after `fromDate`, as
 * a JS Date. If `fromDate` is exactly on that moment, returns `fromDate`
 * itself (not the following week).
 */
export function nextUpdate(fromDate = new Date()) {
  const d = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), TARGET_UTC_HOUR, 0, 0, 0)
  );

  // Walk forward day-by-day (max 8 iterations) until we hit the target UTC
  // weekday at-or-after fromDate — same approach as battleTimer.js, avoiding
  // modular-arithmetic edge cases across month/year boundaries.
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(d.getTime() + i * 24 * 3600 * 1000);
    if (candidate.getUTCDay() === TARGET_UTC_DAY && candidate.getTime() >= fromDate.getTime()) {
      return candidate;
    }
  }
  return new Date(fromDate.getTime() + 7 * 24 * 3600 * 1000); // unreachable, but never return undefined
}

/** Hours remaining until the next expected update, from `fromDate` (default now). Never negative. */
export function hoursUntilUpdate(fromDate = new Date()) {
  return Math.max(0, (nextUpdate(fromDate).getTime() - fromDate.getTime()) / 3600000);
}

/** Unix seconds timestamp of the next expected update — for Discord's native <t:...:R> markup. */
export function nextUpdateUnix(fromDate = new Date()) {
  return Math.floor(nextUpdate(fromDate).getTime() / 1000);
}
