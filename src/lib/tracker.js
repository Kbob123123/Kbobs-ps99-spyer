import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getAllExists, getAllRap, variantKey, describeVariant } from './ps99Api.js';
import { getTierMap, detectNewPets, TIERS, TIER_META, getPetDetail } from './pets.js';
import {
  recordReadings,
  upsertPetMetaBatch,
  getValueAt,
  getLatestValue,
  pruneHistory,
  getChannelsOfKind,
  getMeta,
  setMeta,
  clearChannel,
  countRows,
} from './db.js';
import { renderTierRateChart, TIER_COLORS } from './graph.js';
import { resolveThumbnail } from './thumbnails.js';
import { runStoreWatch } from './storeWatcher.js';
import { runGameWatch } from './gameWatcher.js';
import {
  formatNumber,
  formatCompact,
  formatRate,
  formatMultiplier,
  formatPercentChange,
  displayName,
} from './format.js';

const HOUR = 3600;

// Two years. /pet now charts all-time, so the retention window IS the chart's
// horizon. Affordable because storage is change-only: a pet whose exists count
// moves a few times a day costs a handful of rows a day, not one per poll.
const HISTORY_KEEP_SECONDS = 730 * 24 * HOUR;

// How many pets the hatch-rate text list names before summarising the rest.
//
// Huge has ~4,400 tracked variants against Titanic's ~900, so an unbounded
// list floods the channel on that tier specifically. Capping keeps every post
// the same readable size, and the remainder is still counted in the summary
// line so nothing silently disappears.
const MAX_LISTED_PER_POST = 20;

// Exists-rate alerts compare THIS hour's hatch rate against LAST hour's, so
// the bot needs ~2 hours of readings before they can fire at all.
const RATE_SPIKE_FACTOR = 2; // hatching >=2x last hour's pace
const RATE_DROP_FACTOR = 0.5; // hatching <=half last hour's pace

// Below this many hatches/hour the numbers are too small for a ratio to mean
// anything — a pet going from 1/h to 4/h is not news.
//
// Per tier, because a single flat number cannot fit both ends of the game.
// Measured against live data: the MEDIAN titanic variant has 39 in existence
// in total, and the median gargantuan has 5 — so their hourly hatch rates are
// single digits. A flat floor of 40/hour meant the titanic and gargantuan
// alerts could essentially never fire, which is why a titanic sliding from
// 25/hr to 5/hr passed silently. Huge keeps a high floor; it hatches in
// volume and would otherwise alert constantly.
const MIN_BASELINE_RATE_BY_TIER = { gargantuan: 2, titanic: 5, huge: 40 };

function minBaselineRate(tier) {
  return MIN_BASELINE_RATE_BY_TIER[tier] ?? 40;
}

// RAP alerts: percentage movement over 24 hours. 15% is a real move in a day
// without being noise, and it catches a pet that is *starting* to climb rather
// than only one that has already doubled.
const RAP_CHANGE_PCT = 0.15;

// Ignore pets below this RAP — percentage noise lives at the cheap end.
//
// Calibrated against live data rather than guessed: median Huge RAP is ~323M
// and the 25th percentile ~87M, so an earlier 100k floor excluded essentially
// nothing (96% of pets still qualified). 10M actually trims the bottom of the
// Huge range while leaving every pet anyone trades seriously.
const RAP_MIN_VALUE = 10_000_000;

// ...and ignore moves whose absolute size is trivial, so a large percentage on
// a cheap pet doesn't crowd out a smaller percentage on something valuable.
const RAP_MIN_ABSOLUTE = 5_000_000;

// RAP is now a once-a-day summary covering Titanic and above.
//
// It used to fire hourly across all three tiers including Huge. Huges are the
// bulk of the market, so that produced a steady stream of alerts that people
// stopped reading — and an alert nobody reads is worse than no alert, because
// it buries the ones that matter. Titanic+ once a day is the signal without
// the noise.
const RAP_SUMMARY_TIERS = new Set(['titanic', 'gargantuan']);

// UTC hour at which the daily summary posts.
const RAP_SUMMARY_HOUR_UTC = Number(process.env.RAP_SUMMARY_HOUR_UTC ?? 17);

// Hatch-rate spike/drop alerts stay Titanic/Gargantuan only: Huge pets hatch in
// such volume that their alerts fire constantly and stop being signal. The
// hourly rate CHANNELS still cover all three tiers.
const ALERT_TIERS = new Set(['titanic', 'gargantuan']);

/**
 * One poll (every 10 minutes): read exists + RAP, store what changed, and
 * refresh the hatch-rate channels.
 *
 * Alerts deliberately do NOT run here — see runHourlyAlerts below.
 */
export async function runPoll(client) {
  const tierMap = await getTierMap();
  const newPets = detectNewPets(tierMap);
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

  // Must happen BEFORE recordReadings, which overwrites the stored value that
  // "previous" is measured against. Reversing these two lines would make every
  // gargantuan look unchanged and the announcement would never fire.
  const gargHatches = findNewGargantuanHatches(existsEntries);

  // Same ordering requirement, same reason: this reads the PREVIOUS stored
  // value, which recordReadings below is about to replace.
  const firstHatches = findFirstHatches(existsEntries);

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

  await postRateUpdates(client, existsEntries, now, gargHatches);

  // New releases and first hatches share a channel: both answer "something
  // exists now that did not before". Each is isolated so one failing cannot
  // cost the other, and neither can cost the poll.
  try {
    await postNewPetAlerts(client, newPets);
  } catch (err) {
    console.warn('[pets] New-pet alert failed:', err.message);
  }

  try {
    await postFirstHatchAlerts(client, firstHatches);
  } catch (err) {
    console.warn('[pets] First-hatch alert failed:', err.message);
  }

  // Shop watch rides the same 10-minute poll. Isolated so a Roblox outage
  // costs the leak feed, never the pet tracking that is the bot's main job.
  try {
    await runStoreWatch(client);
  } catch (err) {
    console.warn('[store] Watch failed:', err.message);
  }

  // Same deal for the game update/restart watch: separate Roblox host, its
  // own try/catch, so an outage there cannot take the poll down either.
  try {
    await runGameWatch(client);
  } catch (err) {
    console.warn('[game] Watch failed:', err.message);
  }

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

  // RAP is a DAILY digest, not an hourly alert. This runs on the hourly tick,
  // so it has to decide for itself whether today's has already gone out.
  //
  // The "already sent" marker is stored rather than held in memory: the bot
  // restarts on every deploy, and an in-memory flag would let a few deploys in
  // one afternoon post the same summary several times.
  if (shouldPostRapSummary(now)) {
    await checkRapAlerts(client, rapEntries, now);
    setMeta('rap_summary_last_day', utcDayKey(now));
  }
}

/** YYYY-MM-DD in UTC, the granularity the daily summary is keyed on. */
function utcDayKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function shouldPostRapSummary(now) {
  const hourUtc = new Date(now * 1000).getUTCHours();
  if (hourUtc < RAP_SUMMARY_HOUR_UTC) return false;

  // Once past the target hour, post if today's hasn't gone out. Using ">=" and
  // a day marker rather than "=== the hour" means a bot that was asleep or
  // mid-deploy at exactly 17:00 still sends the digest late instead of
  // skipping the day entirely.
  return getMeta('rap_summary_last_day') !== utcDayKey(now);
}

/**
 * Reduce a raw /api/exists or /api/rap payload to tiered pets only.
 *
 * Duplicate rows for the same variant are SUMMED rather than overwritten.
 * The upstream payload can carry more than one row for a single variant, and
 * letting a later row replace an earlier one made totals jump around, which
 * previously showed up as implausible spikes.
 */
export function collectTieredPets(raw, tierMap) {
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

/**
 * Gargantuans that gained at least one exists count since the previous poll.
 *
 * MUST be called before recordReadings() overwrites the stored value for this
 * poll, otherwise the "previous" reading is the current one and nothing ever
 * looks newly hatched.
 */
export function findNewGargantuanHatches(existsEntries) {
  const hatched = [];

  for (const entry of existsEntries.values()) {
    if (entry.tier !== 'gargantuan') continue;

    // getLatestValue returns { value, ts }, NOT a bare number — subtracting the
    // object directly yields NaN and every comparison silently fails.
    const previous = getLatestValue('exists', entry.petKey);

    // No prior reading: this is the first time we have seen the pet, which is
    // not the same as it having just been hatched. Staying quiet here is why
    // a restart doesn't announce every gargantuan in the game.
    if (previous == null) continue;

    const previousValue = Number(previous.value);
    const gained = entry.value - previousValue;
    if (gained > 0) hatched.push({ ...entry, gained, previous: previousValue });
  }

  return hatched;
}

/**
 * Variants whose exists count just went from zero to something — the first
 * one of that pet ever hatched.
 *
 * The `previous.value === 0` test is doing real work. A zero exists count is
 * COMMON and means untraded/unhatched, not absent: 197 of 4,440 huge variants
 * sit at zero. So "0 -> 1" is a genuine world-first, and it is the only
 * transition that qualifies.
 *
 * A missing previous reading is deliberately NOT a first hatch. That is us
 * seeing the pet for the first time, which says nothing about the game — and
 * treating it as one would make every fresh database announce thousands of
 * "first hatches" on its opening poll.
 */
export function findFirstHatches(existsEntries) {
  const hatched = [];

  for (const entry of existsEntries.values()) {
    // getLatestValue returns { value, ts }, NOT a bare number.
    const previous = getLatestValue('exists', entry.petKey);
    if (previous == null) continue;

    if (Number(previous.value) === 0 && entry.value > 0) {
      hatched.push({ ...entry, gained: entry.value });
    }
  }

  return hatched;
}

const NEWPET_KIND = 'newpet';

/**
 * Announce pets that just appeared in the game's collection.
 *
 * One message each, not a digest. A new pet is the single most interesting
 * thing this bot can report, and batching them into a list is what turns an
 * event into a changelog nobody reads.
 */
export async function postNewPetAlerts(client, newPets) {
  if (newPets.length === 0) return;

  const channels = getChannelsOfKind(NEWPET_KIND);
  if (channels.length === 0) return;

  for (const pet of newPets) {
    const meta = TIER_META[pet.tier] ?? {};
    const detail = await getPetDetail(pet.name).catch(() => null);
    const art = await resolveThumbnail(detail?.thumbnail).catch(() => null);

    const details = [];
    if (detail?.rarity != null) details.push(`💠 **Rarity:** ${detail.rarity}`);
    if (detail?.obtainable === false) {
      details.push('🚫 **Unobtainable** — this cannot be hatched');
    }

    const embed = new EmbedBuilder()
      .setTitle(`${meta.emoji ?? '✨'} NEW ${(meta.label ?? 'PET').toUpperCase()} RELEASED`)
      .setColor(meta.color ?? 0x2ee6c5)
      .setDescription(
        `## ${pet.name}\n` +
          (details.length ? `\n${details.join('\n')}\n` : '') +
          (detail?.description ? `\n_${detail.description}_` : '')
      )
      .setFooter({ text: 'Spotted in the game files the moment it appeared.' })
      .setTimestamp();

    if (art) embed.setImage(art);

    await broadcast(client, channels, { embeds: [embed] });
  }
}

/**
 * Announce the first ever hatch of a pet variant.
 *
 * Separate message from the release alert above even when both fire for the
 * same pet in the same pass: "this exists in the game now" and "someone has
 * actually pulled one" are different facts, and the second is the rarer one.
 */
export async function postFirstHatchAlerts(client, hatches) {
  if (hatches.length === 0) return;

  const channels = getChannelsOfKind(NEWPET_KIND);
  if (channels.length === 0) return;

  for (const hatch of hatches) {
    const meta = TIER_META[hatch.tier] ?? {};
    const detail = await getPetDetail(hatch.name).catch(() => null);

    // Golden art for a golden hatch — same reasoning as the gargantuan alert.
    const wantGolden = /golden/i.test(hatch.variant);
    const art = await resolveThumbnail(
      wantGolden ? detail?.goldenThumbnail ?? detail?.thumbnail : detail?.thumbnail
    ).catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle(`🥇 FIRST EVER ${(meta.label ?? 'PET').toUpperCase()} HATCHED`)
      .setColor(meta.color ?? 0xfee75c)
      .setDescription(
        `## ${hatch.name}\n` +
          `\`${hatch.variant}\`\n` +
          `\nNobody had one of these until now.` +
          (detail?.description ? `\n\n_${detail.description}_` : '')
      )
      .addFields({
        name: '🌍 Now in existence',
        value: `**${formatNumber(hatch.value)}**`,
        inline: true,
      })
      .setFooter({ text: 'Fires once, on the very first one to exist.' })
      .setTimestamp();

    if (art) embed.setImage(art);

    await broadcast(client, channels, { embeds: [embed] });
  }
}

async function postRateUpdates(client, existsEntries, now, gargHatches = []) {
  for (const tier of TIERS) {
    const channels = getChannelsOfKind(tier);
    if (channels.length === 0) continue;

    // Gargantuans are rare enough that an hourly "here are the rates" post is
    // almost always an empty post saying nothing happened. Announce the actual
    // event instead, and stay silent otherwise.
    if (tier === 'gargantuan') {
      if (gargHatches.length > 0) await postGargantuanHatch(client, channels, gargHatches);
      continue;
    }

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
      .setTitle(`${meta.label} Hatch Rates — Trailing Hour`)
      .setColor(parseInt(TIER_COLORS[tier].slice(1), 16))
      .setTimestamp();

    const files = [];
    const tierTotal = [...existsEntries.values()].filter((e) => e.tier === tier).length;

    if (ranked.length === 0) {
      embed.setDescription(
        'Collecting data — hatch rates appear once a full hour of readings exists ' +
          '(about an hour after the bot starts).'
      );
    } else {
      // The text list carries BOTH the running total and the hour's delta.
      // The chart alone can't show totals, and the totals are what make a buff
      // or nerf visible when comparing two posts an hour apart.
      const lines = [];
      let used = 0;
      for (const r of ranked.slice(0, MAX_LISTED_PER_POST)) {
        const line =
          `**${r.name}** (${r.variant}) — ${formatCompact(r.value)} total · ` +
          `+${formatNumber(r.rate)} in the last hour`;
        // Discord caps a description at 4096 characters.
        if (used + line.length + 1 > 3800) break;
        lines.push(line);
        used += line.length + 1;
      }

      // Always account for what isn't listed, so a capped post never reads as
      // "these are all the pets that hatched".
      const remaining = ranked.length - lines.length;
      const hatched = ranked.reduce((sum, r) => sum + r.rate, 0);

      const summary =
        `_**${formatNumber(hatched)}** hatched across **${ranked.length}** variants` +
        (remaining > 0 ? ` — top ${lines.length} shown, ${remaining} more not listed._` : '._');

      embed.setDescription(`${lines.join('\n')}\n\n${summary}`);

      // Art for the tier's top pet, watermarked behind the plot. Resolved
      // here rather than in graph.js because the pet detail lookup is this
      // module's concern, and a failure must not cost us the chart.
      const topPet = ranked[0];
      const topArt = topPet
        ? await getPetDetail(topPet.name)
            .then((d) => (/golden/i.test(topPet.variant) ? d?.goldenThumbnail ?? d?.thumbnail : d?.thumbnail))
            .catch(() => null)
        : null;

      const chart = await renderTierRateChart(
        tier,
        meta.label,
        ranked.map((r) => ({ name: r.name, variant: r.variant, value: r.rate })),
        { art: topArt }
      ).catch((err) => {
        console.warn(`[tracker] Chart render failed for ${tier}:`, err.message);
        return null;
      });

      if (chart) {
        files.push(new AttachmentBuilder(chart, { name: `${tier}-rates.png` }));
        embed.setImage(`attachment://${tier}-rates.png`);
      }
    }

    embed.setFooter({
      text:
        `Exact count over the last 60 minutes, recalculated every 10 min · ` +
        `${formatNumber(tierTotal)} ${meta.label.toLowerCase()} pets tracked`,
    });

    // A NEW message each cycle, deliberately — not an edit in place.
    //
    // The scrollback IS the feature: comparing two posts an hour apart is how
    // you spot a buff or a nerf, and an edited message destroys that history.
    // (The top-10 leaderboard boards still edit in place, because there the
    // point is a single always-current standing rather than a timeline.)
    await broadcast(client, channels, { embeds: [embed], files });
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
    if (previousRate < minBaselineRate(entry.tier)) continue;

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

/**
 * Alert on meaningful RAP movement over 24 hours.
 *
 * This used to require the value to TRIPLE (or fall to a third). For an
 * established pet that essentially never happens, so the alert was dead in
 * practice — it could fire in theory and never did.
 *
 * A percentage threshold catches what actually matters for trading: a pet
 * starting to climb steadily. 15% in a day is a real move without being noise,
 * and it surfaces a trend early rather than only after it has already run.
 *
 * Two guards keep it useful rather than spammy:
 *   - a minimum RAP, because a 20% move on a near-worthless pet is not a
 *     signal and low-value items are where percentage noise lives;
 *   - a minimum absolute change, so a large-but-cheap swing doesn't crowd out
 *     a smaller percentage move on something genuinely valuable.
 */
async function checkRapAlerts(client, rapEntries, now) {
  const channels = getChannelsOfKind('rap');
  if (channels.length === 0) return;

  const risers = [];
  const fallers = [];

  for (const entry of rapEntries.values()) {
    if (!RAP_SUMMARY_TIERS.has(entry.tier)) continue;
    if (entry.value < RAP_MIN_VALUE) continue;

    // Compare against a day ago rather than the previous poll: RAP is cached
    // upstream for hours, so consecutive polls almost always show no change.
    const before = getValueAt('rap', entry.petKey, now - 24 * HOUR);
    if (before == null || before <= 0 || entry.value <= 0) continue;

    const change = entry.value - before;
    const pct = change / before;
    if (Math.abs(pct) < RAP_CHANGE_PCT) continue;
    if (Math.abs(change) < RAP_MIN_ABSOLUTE) continue;

    const record = { ...entry, before, change, pct };
    if (change > 0) risers.push(record);
    else fallers.push(record);
  }

  if (risers.length === 0 && fallers.length === 0) return;

  risers.sort((a, b) => b.pct - a.pct);
  fallers.sort((a, b) => a.pct - b.pct);

  const line = (m) =>
    `**${displayName(m.name, m.variant)}** [${m.tier}] — ` +
    `${formatCompact(m.before)} → ${formatCompact(m.value)} ` +
    `(**${formatPercentChange(m.before, m.value)}**)`;

  const embed = new EmbedBuilder()
    .setTitle('💰 RAP Movement — last 24h')
    .setColor(0x199e70)
    .setTimestamp()
    .setFooter({
      text:
        `Moves of ${Math.round(RAP_CHANGE_PCT * 100)}%+ over 24h · ` +
        `checked hourly · min RAP ${formatCompact(RAP_MIN_VALUE)}`,
    });

  if (risers.length > 0) {
    embed.addFields({
      name: `📈 Rising (${risers.length})`,
      value: risers.slice(0, 12).map(line).join('\n').slice(0, 1024),
    });
  }
  if (fallers.length > 0) {
    embed.addFields({
      name: `📉 Falling (${fallers.length})`,
      value: fallers.slice(0, 12).map(line).join('\n').slice(0, 1024),
    });
  }

  await broadcast(client, channels, { embeds: [embed] });
}

/* ---------------------------------------------------------------------------
 * Discord plumbing
 * ------------------------------------------------------------------------- */

/**
 * Everything the tracker posts sends a NEW message.
 *
 * For alerts that's obvious — an edited alert nobody saw is a lost alert. For
 * the hourly rate posts it's the whole point: the channel becomes a timeline
 * you can scroll back through to compare one hour against another, which is
 * how a buff or nerf becomes visible. Editing one message in place would erase
 * exactly the history that makes these posts worth reading.
 */
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

/**
 * Announce a gargantuan hatch as its own event.
 *
 * Posts a NEW message rather than editing one in place: a hatch is an event
 * with a moment attached, and the record of it is the point. Rate boards edit
 * themselves because "what is the rate right now" has no history worth
 * keeping — this is the opposite case.
 *
 * One embed per pet rather than one combined list, so each hatch carries its
 * own artwork. Two gargantuans hatching inside the same ten-minute window is
 * rare enough that the extra messages are not a flood.
 */
export async function postGargantuanHatch(client, channels, hatches) {
  const meta = TIER_META.gargantuan;

  for (const hatch of hatches) {
    const detail = await getPetDetail(hatch.name).catch(() => null);

    // Golden art when a golden one hatched — showing the normal skin for a
    // golden hatch is a small lie the picture tells louder than the text does.
    const wantGolden = /golden/i.test(hatch.variant);
    const art = await resolveThumbnail(
      wantGolden ? detail?.goldenThumbnail ?? detail?.thumbnail : detail?.thumbnail
    ).catch(() => null);

    const headline = hatch.gained > 1
      ? `${meta.emoji} ${hatch.gained} GARGANTUANS HATCHED`
      : `${meta.emoji} GARGANTUAN HATCHED`;

    const details = [];
    if (detail?.rarity != null) details.push(`💠 **Rarity:** ${detail.rarity}`);
    if (detail?.obtainable === false) {
      details.push('🚫 **Unobtainable** — this can no longer be hatched');
    }

    const embed = new EmbedBuilder()
      .setTitle(headline)
      .setColor(meta.color)
      .setDescription(
        `## ${hatch.name}\n` +
          `\`${hatch.variant}\`\n` +
          (details.length ? `\n${details.join('\n')}\n` : '') +
          (detail?.description ? `\n_${detail.description}_` : '')
      )
      .addFields(
        { name: '🌍 Now in existence', value: `**${formatNumber(hatch.value)}**`, inline: true },
        { name: '⏪ Before', value: formatNumber(hatch.previous), inline: true },
        { name: '✨ Hatched', value: `+${formatNumber(hatch.gained)}`, inline: true }
      )
      .setFooter({ text: 'Posted only when one actually hatches — no hourly filler.' })
      .setTimestamp();

    if (art) embed.setImage(art);

    await broadcast(client, channels, { embeds: [embed] });
  }
}
