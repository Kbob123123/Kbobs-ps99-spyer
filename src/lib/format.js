/** 1234567 -> "1,234,567" */
export function formatNumber(n) {
  if (n == null || Number.isNaN(n)) return 'N/A';
  return Math.round(n).toLocaleString('en-US');
}

/** 1234567 -> "1.23M". Used where space is tight (chart axes, dense lists). */
export function formatCompact(n) {
  if (n == null || Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** A per-hour delta, with an explicit sign so a drop is unmistakable. */
export function formatRate(n) {
  if (n == null || Number.isNaN(n)) return 'collecting data...';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatNumber(n)}/h`;
}

/** Multiplier as a readable factor: 2 -> "2.0x", 0.25 -> "0.25x". */
export function formatMultiplier(x) {
  if (x == null || !Number.isFinite(x)) return 'N/A';
  return x >= 10 ? `${x.toFixed(0)}x` : `${x.toFixed(2)}x`;
}

/** Percentage change from `from` to `to`, e.g. "+340%" / "-62%". */
export function formatPercentChange(from, to) {
  if (!from) return 'N/A';
  const pct = ((to - from) / Math.abs(from)) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Math.round(pct)}%`;
}

/** ▲ / ▼ / ▬ for a signed value. */
export function trendArrow(n) {
  if (n == null || n === 0) return '▬';
  return n > 0 ? '▲' : '▼';
}

/** A pet's full display name including its variant, e.g. "Golden Huge Cat". */
export function displayName(name, variant) {
  return variant && variant !== 'Normal' ? `${variant} ${name}` : name;
}
