// Discord rejects an embed whose field value exceeds 1024 characters (4096 for
// a description), and it rejects the WHOLE message, not just that one field.
export const FIELD_LIMIT = 1024;
export const DESCRIPTION_LIMIT = 4096;

/**
 * Join lines into an embed value, dropping the tail that wouldn't fit and
 * noting how many were dropped. Mirrors the clan and league bots' helper of
 * the same name — the three bots deliberately keep separate copies of lib code.
 *
 * Capping by entry count instead of characters is the recurring bug across all
 * three: a list measures fine on typical names, then a few long ones push it
 * past the limit and the entire reply is refused. This measures.
 *
 * @param {string[]} lines
 * @param {string} emptyText Value to use when there are no lines at all.
 * @param {number} limit Character budget; defaults to the field limit.
 */
export function capToFieldLimit(lines, emptyText = '_None._', limit = FIELD_LIMIT) {
  if (lines.length === 0) return emptyText;

  const kept = [];
  let used = 0;
  for (const line of lines) {
    // Budget for the "…and N more." tail as if it were needed, so adding it
    // afterwards can never be what pushes the value over the limit.
    const suffix = `\n_…and ${lines.length - kept.length} more._`;
    if (used + line.length + 1 + suffix.length > limit) break;
    kept.push(line);
    used += line.length + 1;
  }

  // Nothing fit at all: one pathologically long line would otherwise return a
  // value that is only the "…and N more." tail. Show a truncated first line
  // instead, so the value still says something.
  if (kept.length === 0) return lines[0].slice(0, limit - 1) + '…';

  const remaining = lines.length - kept.length;
  return kept.join('\n') + (remaining > 0 ? `\n_…and ${remaining} more._` : '');
}

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
