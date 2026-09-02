import { EmbedBuilder } from 'discord.js';
import {
  recordCurrencyReading,
  getCurrencyHistory,
  getChannelsOfKind,
  getMeta,
  setMeta,
} from './db.js';
import { formatCompact, formatNumber } from './format.js';

/**
 * Tracks how fast the game's total diamond supply is growing.
 *
 * `/api/exists` carries a `Currency` category holding game-WIDE totals, so
 * inflation needs no new data source — it is a daily delta on one number.
 *
 * THE TRAP, and the reason this file exists rather than a one-line filter:
 * `configData.id === 'Diamonds'` matches TWENTY-ONE entries. There is a
 * Diamonds enchant, several Diamonds potions and a Diamonds charm, and the
 * enchant alone reads ~4.9e9 against the currency's ~1.05e15 — six orders of
 * magnitude out. Selecting on the id alone silently tracks the wrong number
 * and produces a plausible-looking chart of nothing. The category is not
 * optional.
 */

const CURRENCY_CATEGORY = 'Currency';
const DIAMONDS_ID = 'Diamonds';
const CHANNEL_KIND = 'economy';

/**
 * Pull one currency total out of a raw /api/exists payload.
 *
 * Returns null rather than throwing when absent: a missing currency is an
 * upstream change, and it should cost this feature rather than the poll.
 */
export function extractCurrency(existsRaw, id = DIAMONDS_ID) {
  const matches = existsRaw.filter(
    (e) => e.category === CURRENCY_CATEGORY && e.configData?.id === id
  );

  if (matches.length === 0) return null;

  // Summed, not first-wins, for the same reason collectTieredPets sums: the
  // payload can carry more than one row for a single key, and taking the
  // first would silently under-report.
  return matches.reduce((total, e) => total + (Number(e.value) || 0), 0);
}

/** YYYY-MM-DD in UTC. */
export function utcDay(ts = Math.floor(Date.now() / 1000)) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Record today's diamond total. Called on every poll; the day key makes
 * repeated calls overwrite rather than accumulate.
 */
export function recordDiamonds(existsRaw, ts = Math.floor(Date.now() / 1000)) {
  const value = extractCurrency(existsRaw, DIAMONDS_ID);
  if (value == null) {
    console.warn('[economy] No Currency.Diamonds entry in /api/exists — skipping.');
    return null;
  }

  recordCurrencyReading(DIAMONDS_ID, utcDay(ts), value);
  return value;
}

/**
 * Build the daily inflation report, or null when there is not yet a previous
 * day to compare against.
 *
 * Deliberately reports the delta against the PREVIOUS RECORDED day rather
 * than "yesterday" by date arithmetic: the bot can be down for a day, and a
 * two-day delta labelled with its real span is honest where a missing
 * comparison or a silent gap is not.
 */
/**
 * Never compares against TODAY's row.
 *
 * recordDiamonds() overwrites today's row on every 10-minute poll, so at any
 * point before the day ends it holds a partial reading, not a day's total.
 * The bug this fixes: with the report gated on an hour shared with the RAP
 * digest (which legitimately fires right at midnight UTC), "today" meant
 * "the single poll taken ~8 minutes ago." The report then diffed that
 * against yesterday's FINAL row — a real-world gap of ~15 minutes, not 24
 * hours, labelled "since yesterday" every single day. The number shown was
 * essentially noise.
 *
 * The fix is to always compare the two most recent FULLY ELAPSED days,
 * whatever hour this happens to run at. `excludeDay` (today's key) is
 * stripped before picking the pair, so the comparison window is always a
 * genuine day-to-day delta and the exact firing hour stops mattering.
 */
export function buildInflationReport(history, { excludeDay } = {}) {
  const usable = excludeDay ? history.filter((h) => h.day !== excludeDay) : history;
  if (usable.length < 2) return null;

  const [latest, previous] = usable;
  const change = Number(latest.value) - Number(previous.value);
  const pct = Number(previous.value) > 0 ? change / Number(previous.value) : 0;

  const days = Math.max(
    1,
    Math.round((Date.parse(latest.day) - Date.parse(previous.day)) / 86_400_000)
  );

  return {
    current: Number(latest.value),
    previous: Number(previous.value),
    change,
    pct,
    days,
    from: previous.day,
    to: latest.day,
  };
}

function buildEmbed(report) {
  const rising = report.change >= 0;

  const embed = new EmbedBuilder()
    .setTitle('💎 Diamond Economy')
    .setColor(rising ? 0x3987e5 : 0xed4245)
    .setDescription(
      `## ${formatCompact(report.current)} diamonds in the game\n` +
        `${rising ? 'Up' : 'Down'} **${formatCompact(Math.abs(report.change))}** ` +
        `(${rising ? '+' : '−'}${(Math.abs(report.pct) * 100).toFixed(2)}%) ` +
        (report.days === 1 ? 'since yesterday.' : `over the last ${report.days} days.`)
    )
    .addFields(
      { name: '📊 Total now', value: `**${formatNumber(report.current)}**`, inline: false },
      { name: '⏪ Previous', value: formatNumber(report.previous), inline: true },
      {
        name: rising ? '📈 Minted' : '📉 Removed',
        value: `${rising ? '+' : '−'}${formatNumber(Math.abs(report.change))}`,
        inline: true,
      }
    )
    .setFooter({ text: `${report.from} → ${report.to} · game-wide total, posted once a day` })
    .setTimestamp();

  return embed;
}

/**
 * Post the daily report if today's has not gone out yet.
 *
 * The "already posted" marker lives in bot_meta rather than memory for the
 * same reason the RAP summary's does: Railway restarts several times a week,
 * and an in-memory flag would let an afternoon of deploys post the same
 * report repeatedly.
 */
/**
 * No hour gate, deliberately.
 *
 * A previous version accepted an `hourUtc` and skipped running until past it
 * — inherited from the RAP digest's own gate, and passed the SAME env var
 * (RAP_SUMMARY_HOUR_UTC) at the call site. RAP's data is fine to read the
 * instant the day rolls over, because it's alerts already accumulated
 * throughout the previous day. Diamonds are not: buildInflationReport() now
 * excludes today's still-filling row itself, so there is nothing left for an
 * hour gate to protect against. Removing it also removes the coupling to a
 * constant named for an unrelated feature, which is what caused this bug.
 */
export async function runEconomyReport(client) {
  const now = Math.floor(Date.now() / 1000);
  const today = utcDay(now);

  if (getMeta('economy_report_last_day') === today) return;

  const channels = getChannelsOfKind(CHANNEL_KIND);
  if (channels.length === 0) return;

  const report = buildInflationReport(getCurrencyHistory(DIAMONDS_ID, 30), { excludeDay: today });
  if (!report) return; // needs two FULLY ELAPSED days before it can say anything

  const embed = buildEmbed(report);

  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    await channel
      .send({ embeds: [embed] })
      .catch((err) => console.warn(`[economy] Could not post to ${row.channel_id}:`, err.message));
  }

  setMeta('economy_report_last_day', today);
  console.log(`[economy] Posted daily diamond report for ${today}.`);
}
