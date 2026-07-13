export function formatNumber(n) {
  if (n === null || n === undefined) return 'N/A';
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatCompact(n) {
  if (n === null || n === undefined) return 'N/A';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

// Custom k/m/b/t formatter (lowercase suffixes) — used for chart labels and
// anywhere a consistent, locale-independent short form is wanted instead of
// relying on Intl's compact notation (which can vary in capitalization/
// rounding behavior across environments).
const SUFFIXES = [
  { value: 1e12, suffix: 't' },
  { value: 1e9, suffix: 'b' },
  { value: 1e6, suffix: 'm' },
  { value: 1e3, suffix: 'k' },
];

export function formatKMBT(n) {
  if (n === null || n === undefined) return 'N/A';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);

  for (let i = 0; i < SUFFIXES.length; i++) {
    const { value, suffix } = SUFFIXES[i];
    if (abs >= value) {
      let rounded = Math.round((abs / value) * 100) / 100;

      // Guard: rounding can push a value to exactly the next tier's boundary
      // (e.g. 999999 / 1000 = 999.999 -> rounds to 1000, which should read
      // "1m" not "1000k"). If so, escalate to the next-larger suffix.
      if (rounded >= 1000 && i > 0) {
        const next = SUFFIXES[i - 1];
        rounded = Math.round((abs / next.value) * 100) / 100;
        return `${sign}${rounded}${next.suffix}`;
      }

      return `${sign}${rounded}${suffix}`;
    }
  }

  // Under 1000: show as a plain integer (no decimals expected for exists/RAP counts)
  return `${sign}${Math.round(abs)}`;
}
