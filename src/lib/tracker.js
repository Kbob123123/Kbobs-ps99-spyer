import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getAllExists, getAllRap, variantKey, describeVariant } from './ps99Api.js';
import { getTierMap, TIERS, TIER_META } from './pets.js';
import {
  recordReadings,
  upsertPetMetaBatch,
  getValueAt,
  pruneHistory,
  getChannelsOfKind,
  setChannelMessageId,
  clearChannel,
  countRows,
} from './db.js';
import { renderTierRateChart, TIER_COLORS } from './graph.js';
import { formatNumber, formatRate, formatMultiplier, formatPercentChange, displayName } from './format.js';

const HOUR = 3600;

const HISTORY_KEEP_SECONDS = 30 * 24 * HOUR; // 30 days, for /pet charts

// Exists-rate alerts compare THIS hour's hatch rate against LAST hour's, so
// the bot needs ~2 hours of readings before they can fire at all.
const RATE_SPIKE_FACTOR = 2; // hatching >=2x last hour's pace
const RATE_DROP_FACTOR = 0.5; // hatching <=half last hour's pace

// Below this many hatches/hour the numbers are too small for a ratio to mean
// anything — a pet going from 1/h to 4/h is not news.
const MIN_BASELINE_RATE = 40;

// RAP alert: a 200% swing means the value tripled or fell to a third.
const RAP_CHANGE_FACTOR = 3;

// Spike/drop alerts cover Titanic and Gargantuan only. Huge pets hatch in such
// volume that their alerts fire constantly and stop being signal. The hourly
// rate CHANNELS still cover all three tiers.
const ALERT_TIERS = new Set(['titanic', 'gargantuan']);

/**
 * One poll (every 10 minutes): read exists + RAP, store what changed, and
 * refresh the hatch-rate channels.
 *
 * Alerts deliberately do NOT run here — see runHourlyAlerts below.
 */
export async function runPoll(client) {
  const tierMap = await getTierMap();
  const now = Math.floor(Date.now() / 1000);

  const [existsRaw, rapRaw] = await Promise.all([getAllExists(), getAllRap()]);

  const existsEntries = collectTieredPets(existsRaw, tierMap);
  const rapEntries = collectTieredPets(rapRaw, tierMap);

  // Keep pet_meta current so history rows only need to carry a key.
  upsertPetMetaBatch(
    [...existsEntries.values()].map((e) => ({
      petKey: e.petKey,
      name: e.name,
      variant: e.variant,
      tier: e.tier,
    }))
  );

  const existsWritten = recordReadings(
    'exists',
    [...existsEntries.values()].map((e) => ({ petKey: e.petKey, value: e.value })),
    now
  );
  const rapWritten = recordReadings(
    'rap',
    [...rapEntries.values()].map((e) => ({ petKey: e.petKey, value: e.value })),
    now
  );

  console.log(
    `[tracker] Poll: ${existsEntries.size} exists / ${rapEntries.size} rap entries seen; ` +
      `${existsWritten} + ${rapWritten} changed rows stored ` +
      `(${countRows('exists')} + ${countRows('rap')} total).`
  );

  await postRateUpdates(client, existsEntries, now);

  pruneHistory('exists', HISTORY_KEEP_SECONDS);
  pruneHistory('rap', HISTORY_KEEP_SECONDS);
}

/**
 * Alert pass — runs ONCE AN HOUR, separately from the 10-minute poll.
 *
 * Cadence is part of the design, not an implementation detail. Both alert
 * types below compare windows measured in hours, so running them on the
 * 10-minute poll re-evaluated the same unchanged window six times an hour and
 * re-sent the same alert each time. Firing hourly means one alert per genuine
 * event.
 *
 * Reads its own fresh exists/RAP snapshot; both are served from the API
 * client's short cache, so this is nearly free.
 */
export async function runHourlyAlerts(client) {
  const tierMap = await getTierMap();
  const now = Math.floor(Date.now() / 1000);

  const [existsRaw, rapRaw] = await Promise.all([getAllExists(), getAllRap()]);
  const existsEntries = collectTieredPets(existsRaw, tierMap);
  const rapEntries = collectTieredPets(rapRaw, tierMap);

  await checkExistsRateAlerts(client, existsEntries, now);
  await checkRapAlerts(client, rapEntries, now);
}

/**
 * Reduce a raw /api/exists or /api/rap payload to tiered pets only.
 *
 * Duplicate rows for the same variant are SUMMED rather than overwritten.
 * The upstream payload can carry more than one row for a single variant, and
 * letting a later row replace an earlier one made totals jump around, which
 * previously showed up as implausible spikes.
 */
function collectTieredPets(raw, tierMap) {
  const out = new Map();

  for (const entry of raw) {
    if (entry.category !== 'Pet') continue;
    const cfg = entry.configData ?? {};
    const name = cfg.id;
    if (!name) continue;

    const tier = tierMap.get(name);
    if (!tier) continue;

    const petKey = variantKey(entry);
    const existing = out.get(petKey);
    if (existing) {
      existing.value += Number(entry.value) || 0;
    } else {
      out.set(petKey, {
        petKey,
        name,
        variant: describeVariant(cfg),
        tier,
        value: Number(entry.value) || 0,
      });
    }
  }

  return out;
}

/** Hatches in the trailing hour, or null if there isn't an hour of history yet. */
function hourlyRate(petKey, currentValue, now) {
  // getValueAt only returns rows with ts <= the cutoff, so a non-null result
  // already proves a reading exists from at least an hour ago. That is the
  // whole check — nothing further is needed.
  //
  // This previously also consulted getLatestValue() to "confirm" enough
  // history existed. That was wrong twice over: getLatestValue returns the
  // NEWEST row (misread as the oldest), and the newest row is rewritten on
  // every poll, so its timestamp is always ~now. The guard was therefore
  // always true and this function returned null every time — no hatch rates,
  // no rate posts, and no spike/drop alerts, permanently.
  const hourAgo = getValueAt('exists', petKey, now - HOUR);
  if (hourAgo == null) return null;

  return currentValue - hourAgo;
}

/* ---------------------------------------------------------------------------
 * Hourly hatch-rate channels (one per tier)
 * ------------------------------------------------------------------------- */

async function postRateUpdates(client, existsEntries, now) {
  for (const tier of TIERS) {
    const channels = getChannelsOfKind(tier);
    if (channels.length === 0) continue;

    const meta = TIER_META[tier];
    const ranked = [];

    for (const entry of existsEntries.values()) {
      if (entry.tier !== tier) continue;
      const rate = hourlyRate(entry.petKey, entry.value, now);
      if (rate == null || rate <= 0) continue;
      ranked.push({ ...entry, rate });
    }

    ranked.sort((a, b) => b.rate - a.rate);

    const embed = new EmbedBuilder()
      .setTitle(`${meta.emoji} ${meta.label} — hatched in the last hour`)
      .setColor(parseInt(TIER_COLORS[tier].slice(1), 16))
      .setTimestamp();

    const files = [];

    if (ranked.length === 0) {
      embed.setDescription(
        'Collecting data — hatch rates appear once a full hour of readings exists ' +
          '(about an hour after the bot starts).'
      );
    } else {
      const total = ranked.reduce((sum, r) => sum + r.rate, 0);
      embed.setDescription(
        `**${formatNumber(total)}** ${meta.label} pets hatched in the last hour, across ` +
          `**${ranked.length}** variants.`
      );

      const chart = await renderTierRateChart(
        tier,
        meta.label,
        ranked.map((r) => ({ name: r.name, variant: r.variant, value: r.rate }))
      ).catch((err) => {
        console.warn(`[tracker] Chart render failed for ${tier}:`, err.message);
        return null;
      });

      if (chart) {
        files.push(new AttachmentBuilder(chart, { name: `${tier}-rates.png` }));
        embed.setImage(`attachment://${tier}-rates.png`);
      } else {
        // No chart — fall back to a text list so the post is still useful.
        embed.addFields({
          name: 'Top hatches',
          value: ranked
            .slice(0, 10)
            .map((r, i) => `**#${i + 1}** ${displayName(r.name, r.variant)} — ${formatNumber(r.rate)}`)
            .join('\n'),
        });
      }
    }

    embed.setFooter({ text: 'Exact count over the trailing 60 minutes · updates every 10 minutes' });

    for (const row of channels) {
      await postOrEdit(client, row, { embeds: [embed], files });
    }
  }
}

/* ---------------------------------------------------------------------------
 * Exists RATE spike / drop alerts
 * ------------------------------------------------------------------------- */

/**
 * Alert when a pet's HATCH RATE changes sharply — not when its cumulative
 * count does.
 *
 * Two things this gets right that the original didn't:
 *
 * 1. It measures a RATE. The original compared a pet's total exists count
 *    against its count 10 minutes earlier and fired at 2x. For an established
 *    pet sitting at tens of millions, that ratio is unreachable — the alert
 *    was mathematically incapable of firing.
 *
 * 2. It compares THIS hour's hatch rate against LAST hour's, hour over hour.
 *    That is self-limiting in a way a long rolling baseline is not: once a
 *    pet's rate settles at its new high, the next comparison is high-against-
 *    high (~1x) and the alerts stop, instead of repeating for as long as the
 *    elevated rate stays above a six-hour average.
 *
 * Drops matter as much as spikes — a pet that suddenly stops being hatched is
 * as interesting as one that floods in.
 */
async function checkExistsRateAlerts(client, existsEntries, now) {
  const channels = getChannelsOfKind('exists');
  if (channels.length === 0) return;

  const spikes = [];
  const drops = [];

  for (const entry of existsEntries.values()) {
    if (!ALERT_TIERS.has(entry.tier)) continue;

    // This hour: how many hatched between an hour ago and now.
    const currentRate = hourlyRate(entry.petKey, entry.value, now);
    if (currentRate == null) continue;

    // Last hour: between two hours ago and one hour ago.
    const twoHoursAgo = getValueAt('exists', entry.petKey, now - 2 * HOUR);
    const oneHourAgo = getValueAt('exists', entry.petKey, now - HOUR);
    if (twoHoursAgo == null || oneHourAgo == null) continue;

    const previousRate = oneHourAgo - twoHoursAgo;

    // A ratio against a near-zero previous hour is meaningless — 2 hatches
    // becoming 20 is a 10x "spike" that nobody cares about.
    if (previousRate < MIN_BASELINE_RATE) continue;

    const ratio = currentRate / previousRate;
    const record = { ...entry, currentRate, previousRate, ratio };

    if (ratio >= RATE_SPIKE_FACTOR) spikes.push(record);
    else if (ratio <= RATE_DROP_FACTOR) drops.push(record);
  }

  if (spikes.length === 0 && drops.length === 0) return;

  spikes.sort((a, b) => b.ratio - a.ratio);
  drops.sort((a, b) => a.ratio - b.ratio);

  const embed = new EmbedBuilder()
    .setTitle('⚡ Hatch Rate Alert')
    .setColor(0x3987e5)
    .setTimestamp()
    .setFooter({
      text:
        `This hour vs last hour · spike ≥${RATE_SPIKE_FACTOR}x, drop ≤${RATE_DROP_FACTOR}x · ` +
        'checked hourly · Titanic/Gargantuan only',
    });

  if (spikes.length > 0) {
    embed.addFields({
      name: `📈 Hatching ${RATE_SPIKE_FACTOR}x faster or more`,
      value: spikes.slice(0, 10).map(formatRateAlertLine).join('\n'),
    });
  }
  if (drops.length > 0) {
    embed.addFields({
      name: `📉 Hatching at half speed or less`,
      value: drops.slice(0, 10).map(formatRateAlertLine).join('\n'),
    });
  }

  await broadcast(client, channels, { embeds: [embed] });
}

function formatRateAlertLine(a) {
  return (
    `**${displayName(a.name, a.variant)}** [${a.tier}] — ` +
    `${formatRate(Math.round(a.previousRate))} → ${formatRate(Math.round(a.currentRate))} ` +
    `(**${formatMultiplier(a.ratio)}**)`
  );
}

/* ---------------------------------------------------------------------------
 * RAP swing alerts
 * ------------------------------------------------------------------------- */

async function checkRapAlerts(client, rapEntries, now) {
  const channels = getChannelsOfKind('rap');
  if (channels.length === 0) return;

  const moves = [];

  for (const entry of rapEntries.values()) {
    if (!ALERT_TIERS.has(entry.tier)) continue;

    // Compare against the value a day ago rather than the previous poll: RAP is
    // cached upstream for hours, so consecutive polls almost always show no
    // change at all.
    const before = getValueAt('rap', entry.petKey, now - 24 * HOUR);
    if (before == null || before <= 0 || entry.value <= 0) continue;

    const ratio = entry.value / before;
    if (ratio >= RAP_CHANGE_FACTOR || ratio <= 1 / RAP_CHANGE_FACTOR) {
      moves.push({ ...entry, before, ratio });
    }
  }

  if (moves.length === 0) return;

  moves.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));

  const embed = new EmbedBuilder()
    .setTitle('💰 RAP Swing Alert')
    .setColor(0x199e70)
    .setTimestamp()
    .setDescription(
      moves
        .slice(0, 12)
        .map(
          (m) =>
            `**${displayName(m.name, m.variant)}** [${m.tier}] — ` +
            `${formatNumber(m.before)} → ${formatNumber(m.value)} ` +
            `(${formatPercentChange(m.before, m.value)})`
        )
        .join('\n')
    )
    .setFooter({ text: 'Value tripled or fell to a third within 24h · Titanic/Gargantuan only' });

  await broadcast(client, channels, { embeds: [embed] });
}

/* ---------------------------------------------------------------------------
 * Discord plumbing
 * ------------------------------------------------------------------------- */

/**
 * Edit this channel's existing post if there is one, otherwise send a new one
 * and remember its id. Used for the recurring rate posts so a channel holds a
 * single message that updates in place instead of a new post every 10 minutes.
 */
async function postOrEdit(client, row, payload) {
  try {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[tracker] Channel ${row.channel_id} is gone; unregistering ${row.kind}.`);
      clearChannel(row.guild_id, row.kind);
      return;
    }

    if (row.message_id) {
      const existing = await channel.messages.fetch(row.message_id).catch(() => null);
      if (existing) {
        await existing.edit(payload);
        return;
      }
      // Deleted — fall through and post a replacement.
    }

    const sent = await channel.send(payload);
    setChannelMessageId(row.guild_id, row.kind, sent.id);
  } catch (err) {
    console.error(`[tracker] Failed to update ${row.kind} in ${row.channel_id}:`, err.message);
  }
}

/** Alerts always post a NEW message — an edited alert nobody saw is a lost alert. */
async function broadcast(client, rows, payload) {
  for (const row of rows) {
    try {
      const channel = await client.channels.fetch(row.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        clearChannel(row.guild_id, row.kind);
        continue;
      }
      await channel.send(payload);
    } catch (err) {
      console.error(`[tracker] Failed to post ${row.kind} alert to ${row.channel_id}:`, err.message);
    }
  }
}
