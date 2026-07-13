// In-memory rolling history so commands (/clantop10, /league) and their
// auto-posted equivalents compute an EXACT trailing-60-minute rate — the same
// method the pet tracker uses: find the snapshot closest to exactly 60
// minutes ago and diff against that, rather than extrapolating a short
// sample. Not persisted across restarts, and requires a full hour of
// history before a rate is available (see getClanRate/getLeagueRate).
//
// Two separate stores per clan/league:
//  - *RateHistory: bounded to MAX_RATE_POINTS, used only for the hourly-rate
//    math above (doesn't need more than ~2hrs of lookback ever).
//  - *ChartHistory: UNBOUNDED, accumulates for as long as the bot runs, used
//    for the full chart series (per request: "entire time, not just past
//    hour"). This resets to empty on a new clan battle / league period via
//    resetChartHistory() so the chart naturally restarts each battle instead
//    of stitching unrelated periods together on one axis.

const clanRateHistory = new Map(); // clanName -> [{ time, points }] (bounded)
const leagueRateHistory = new Map(); // key -> [{ time, value }] (bounded)
const clanChartHistory = new Map(); // clanName -> [{ time, points }] (unbounded)
const leagueChartHistory = new Map(); // key -> [{ time, value }] (unbounded)

const MAX_RATE_POINTS = 12; // keep last 2 hours at 10-min resolution, for rate math only
const HOUR_MS = 60 * 60 * 1000;

function pushHistory(map, key, point, maxPoints = null) {
  const arr = map.get(key) ?? [];
  arr.push(point);
  if (maxPoints !== null && arr.length > maxPoints) arr.shift();
  map.set(key, arr);
}

// Finds the history point closest to exactly `targetMs` before `now`.
// Returns null if the oldest point on record is younger than ~55 minutes —
// i.e. we don't yet have a full hour of coverage, so no rate should be
// reported yet (better than reporting a number from a shorter window as if
// it were an hourly rate).
function findPointNearAgo(arr, now, targetMs) {
  if (!arr || arr.length < 2) return null;
  const oldest = arr[0];
  if (now - oldest.time < targetMs - 5 * 60 * 1000) return null;

  const target = now - targetMs;
  let closest = arr[0];
  let closestDiff = Math.abs(arr[0].time - target);
  for (const point of arr) {
    const diff = Math.abs(point.time - target);
    if (diff < closestDiff) {
      closest = point;
      closestDiff = diff;
    }
  }
  return closest;
}

export function recordClanSnapshot(clanName, points) {
  const point = { time: Date.now(), points };
  pushHistory(clanRateHistory, clanName, point, MAX_RATE_POINTS);
  pushHistory(clanChartHistory, clanName, point); // unbounded
}

export function getClanRate(clanName) {
  const arr = clanRateHistory.get(clanName);
  if (!arr || arr.length < 2) return null;
  const now = Date.now();
  const last = arr[arr.length - 1];
  const hourAgo = findPointNearAgo(arr, now, HOUR_MS);
  if (!hourAgo) return null; // not enough history yet for an exact hourly figure

  const deltaPoints = last.points - hourAgo.points;
  const deltaMs = last.time - hourAgo.time;
  if (deltaMs <= 0) return null;
  // Normalize to a per-hour figure even if the closest sample wasn't exactly
  // 60 min back (it'll be close, since we snapshot every 10 min).
  const perHour = (deltaPoints / deltaMs) * HOUR_MS;
  return { perHour, current: last.points, exactDelta: deltaPoints, windowMs: deltaMs };
}

export function recordLeagueSnapshot(key, value) {
  const point = { time: Date.now(), value };
  pushHistory(leagueRateHistory, key, point, MAX_RATE_POINTS);
  pushHistory(leagueChartHistory, key, point); // unbounded
}

export function getLeagueRate(key) {
  const arr = leagueRateHistory.get(key);
  if (!arr || arr.length < 2) return null;
  const now = Date.now();
  const last = arr[arr.length - 1];
  const hourAgo = findPointNearAgo(arr, now, HOUR_MS);
  if (!hourAgo) return null;

  const deltaValue = last.value - hourAgo.value;
  const deltaMs = last.time - hourAgo.time;
  if (deltaMs <= 0) return null;
  const perHour = (deltaValue / deltaMs) * HOUR_MS;
  return { perHour, current: last.value, exactDelta: deltaValue, windowMs: deltaMs };
}

// Given a rate (per hour) and the gap to the next-ranked entry, estimate hours
// until overtake. Returns null if not gaining (rate <= 0) since it'll never catch up
// on current trajectory, or if there's nothing to catch (already #1).
export function estimateHoursToOvertake(currentValue, nextValue, currentRatePerHour, nextRatePerHour = 0) {
  const relativeRate = currentRatePerHour - nextRatePerHour;
  const gap = nextValue - currentValue;
  if (gap <= 0) return 0; // already ahead or tied
  if (relativeRate <= 0) return null; // not closing the gap
  return gap / relativeRate;
}

export function formatHours(hours) {
  if (hours === null) return 'not gaining (won\'t catch up at current rate)';
  if (hours === 0) return 'already ahead';
  if (hours < 1) return `~${Math.round(hours * 60)}m`;
  if (hours < 48) return `~${hours.toFixed(1)}h`;
  return `~${(hours / 24).toFixed(1)}d`;
}

// --- Pet exists history (shared with tracker.js and /pet chart) ---
// Same exact-trailing-hour approach as clans/leagues. Keyed by
// "petName|pt|sh" (pt: 0 normal/1 golden/2 rainbow, sh: shiny flag),
// matching the key format used throughout ps99Api.js/tracker.js.

const petExistsHistory = new Map(); // key -> [{ time, value }]
const petRapHistory = new Map(); // key -> [{ time, value }]

export function recordPetExistsSnapshot(key, value) {
  pushHistory(petExistsHistory, key, { time: Date.now(), value });
}

export function recordPetRapSnapshot(key, value) {
  pushHistory(petRapHistory, key, { time: Date.now(), value });
}

export function getPetExistsSeries(key) {
  return petExistsHistory.get(key) ?? [];
}

export function getPetRapSeries(key) {
  return petRapHistory.get(key) ?? [];
}

// Returns { current, previous, previousTime } using the immediately-prior
// snapshot (NOT the trailing-hour window) — used for short-term spike
// detection (the 2x/10min exists alert). Returns null if there's no prior
// snapshot yet for this key.
export function getPetExistsPreviousSnapshot(key) {
  const arr = petExistsHistory.get(key);
  if (!arr || arr.length === 0) return null;
  const previous = arr[arr.length - 1];
  return { value: previous.value, time: previous.time };
}

// Returns the exact trailing-hour delta for a pet, or null if there isn't
// yet a full hour of history. Mirrors getClanRate/getLeagueRate.
export function getPetExistsHourlyDelta(key) {
  const arr = petExistsHistory.get(key);
  if (!arr || arr.length < 2) return null;
  const now = Date.now();
  const last = arr[arr.length - 1];
  const hourAgo = findPointNearAgo(arr, now, HOUR_MS);
  if (!hourAgo) return null;

  const deltaMs = last.time - hourAgo.time;
  if (deltaMs <= 0) return null;
  return { current: last.value, hourAgoValue: hourAgo.value, delta: last.value - hourAgo.value };
}

export function getClanSeries(clanName) {
  return clanChartHistory.get(clanName) ?? [];
}

export function getLeagueSeries(key) {
  return leagueChartHistory.get(key) ?? [];
}

// Clears ONLY the chart-history stores (not the rate-calc history) — called
// when a new clan battle / league period is detected, so the "entire time"
// chart naturally restarts at the new period instead of stitching together
// two unrelated battles on one continuous axis. Rate history is left alone
// since the hourly-rate math is period-agnostic (it's just "gain per hour
// right now", which stays meaningful across a battle boundary).
export function resetClanChartHistory() {
  clanChartHistory.clear();
}

export function resetLeagueChartHistory() {
  leagueChartHistory.clear();
}
