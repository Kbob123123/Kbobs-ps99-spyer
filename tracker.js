import { EmbedBuilder } from 'discord.js';
import { getAllExists, getAllRap, getPetTierMap, getClans, getClan, getPetThumbnailMap, getPetsCollection, getPetsCollectionFresh, getActiveClanBattle } from './ps99Api.js';
import { formatNumber, formatCompact } from './format.js';
import {
  recordClanSnapshot,
  recordPetExistsSnapshot,
  getPetExistsPreviousSnapshot,
  getPetExistsHourlyDelta,
  resetClanChartHistory,
} from './history.js';
import { getAllGuildConfigs, CHANNEL_KEYS, getAllClanTrackers, getAllClanInactivityTrackers, getPingRole } from './config.js';
import { buildClanTop10Embed, buildLeagueTop10Embed } from './top10Embeds.js';
import { resolveThumbnail } from './thumbnails.js';
import { buildDeltaBarChartUrl } from './charts.js';
import { getGameDetails, getAllGamepasses, getAllDeveloperProducts, resolveUsernames } from './robloxProxy.js';

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const RAP_CHANGE_THRESHOLD = 2.0; // 200% = value tripled (or dropped to 1/3), see isBigRapChange
const EXISTS_MULTIPLIER_THRESHOLD = 2.0; // x2 = doubled

// RAP and exists SPIKE ALERTS only watch Titanic/Gargantuan — Huge was
// excluded per explicit request (too noisy at Huge volume). The hourly
// hatch-rate tracker posts (postTierUpdates) still cover all three tiers.
const ALERT_TIERS = new Set(['titanic', 'gargantuan']);

const TIER_CONFIG = {
  huge: { key: CHANNEL_KEYS.huge, label: 'Huge', color: 0xf1c40f },
  titanic: { key: CHANNEL_KEYS.titanic, label: 'Titanic', color: 0xe67e22 },
  gargantuan: { key: CHANNEL_KEYS.gargantuan, label: 'Gargantuan', color: 0xe74c3c },
};

// key -> last-seen RAP value (only updates when RAP actually changes, since
// upstream RAP itself is cached ~4hr and polling every 10min will mostly see no change)
let previousRapSnapshot = new Map();

function entryKey(entry) {
  const cfg = entry.configData ?? {};
  return `${cfg.id}|${cfg.pt ?? 0}|${cfg.sh ? 1 : 0}`;
}

function variantLabel(cfg) {
  const parts = [];
  if (cfg.pt === 1) parts.push('Golden');
  if (cfg.pt === 2) parts.push('Rainbow');
  if (cfg.sh) parts.push('Shiny');
  return parts.length ? parts.join(' ') : 'Normal';
}

// "+/-200% change" is interpreted as: new value is >=200% higher (>=3x) or
// >=200% lower relative to old (i.e. dropped by >=200% of... doesn't apply below zero,
// so for a decrease we treat -200% as value falling to <=1/3 of the old value,
// the symmetric counterpart of tripling). This is a judgment call since "-200%"
// isn't literally possible on a positive-only value.
function percentChange(oldVal, newVal) {
  if (oldVal === 0) return null;
  return ((newVal - oldVal) / oldVal) * 100;
}

function isBigRapChange(oldVal, newVal) {
  const pct = percentChange(oldVal, newVal);
  if (pct === null) return false;
  return Math.abs(pct) >= RAP_CHANGE_THRESHOLD * 100;
}

// Sends one embed to every guild that has configured `channelKey`, deduping
// by channel ID in case multiple guild entries somehow point at the same channel.
// Sends one embed to every guild that has configured `channelKey`, prefixed
// with a role ping if that guild has one set for this type via
// /setpingrole. Dedupes by (guildId, channelId) pair rather than just
// channelId, since ping roles are per-guild and two guilds could in theory
// point different configs at values that collide if not paired correctly.
async function broadcastToConfiguredGuilds(client, channelKey, embed) {
  const configs = getAllGuildConfigs();
  const targets = []; // [{ guildId, channelId }]
  const seen = new Set();

  for (const guildId of Object.keys(configs)) {
    const channelId = configs[guildId]?.[channelKey];
    if (!channelId) continue;
    const dedupeKey = `${guildId}:${channelId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({ guildId, channelId });
  }

  if (targets.length === 0) return 0;

  let sent = 0;
  for (const { guildId, channelId } of targets) {
    try {
      const channel = await client.channels.fetch(channelId);
      const roleId = getPingRole(guildId, channelKey);
      const content = roleId ? `<@&${roleId}>` : undefined;
      await channel.send({ content, embeds: [embed] });
      sent++;
    } catch (err) {
      console.error(`[tracker] Failed to post to channel ${channelId}:`, err.message);
    }
  }
  return sent;
}

async function checkRapAlerts(client, tierMap) {
  let rapData;
  try {
    rapData = await getAllRap();
  } catch (err) {
    console.error('[tracker] Failed to fetch RAP for alert check:', err.message);
    return;
  }

  // Unlike exists counts, RAP is a price average, not a quantity — it should
  // never be summed across duplicate rows. If the same key appears more than
  // once with different values, that's a genuine data inconsistency (not the
  // sum case fixed in takeSnapshotAndReport for exists), so keep the first
  // value seen and log a warning rather than silently picking one.
  const currentSnapshot = new Map();
  const alerts = [];

  for (const entry of rapData) {
    const cfg = entry.configData ?? {};
    const name = cfg.id;
    if (!name) continue;
    if (!ALERT_TIERS.has(tierMap.get(name))) continue; // Titanic/Gargantuan only for this alert

    const key = entryKey(entry);

    if (currentSnapshot.has(key) && currentSnapshot.get(key) !== entry.value) {
      console.warn(
        `[tracker] RAP data has conflicting values for "${key}": ${currentSnapshot.get(key)} vs ${entry.value}. Keeping first seen.`
      );
      continue;
    }
    if (currentSnapshot.has(key)) continue; // exact duplicate, skip silently

    currentSnapshot.set(key, entry.value);

    const prev = previousRapSnapshot.get(key);
    if (prev !== undefined && prev !== entry.value && isBigRapChange(prev, entry.value)) {
      alerts.push({
        name,
        variant: variantLabel(cfg),
        tier: tierMap.get(name),
        previous: prev,
        current: entry.value,
        pct: percentChange(prev, entry.value),
      });
    }
  }

  const isFirstRun = previousRapSnapshot.size === 0;
  previousRapSnapshot = currentSnapshot;
  if (isFirstRun || alerts.length === 0) return;

  const embed = new EmbedBuilder()
    .setTitle('🚨 Major RAP Change Alert')
    .setColor(0x9b59b6)
    .setDescription(
      alerts
        .map((a) => {
          const arrow = a.pct > 0 ? '📈' : '📉';
          return `${arrow} **${a.name}** (${a.variant}) [${a.tier}] — ${formatNumber(
            a.previous
          )} → ${formatNumber(a.current)} (${a.pct > 0 ? '+' : ''}${a.pct.toFixed(0)}%)`;
        })
        .join('\n')
    )
    .setFooter({ text: `Threshold: ±${RAP_CHANGE_THRESHOLD * 100}% · Titanic/Gargantuan only` })
    .setTimestamp();

  const chartUrl = await buildDeltaBarChartUrl(
    'RAP % Change',
    alerts.map((a) => ({ name: `${a.name} (${a.variant})`, value: Math.round(a.pct) })),
    { valueLabel: '% change' }
  );
  if (chartUrl) embed.setImage(chartUrl);

  await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.rapAlert, embed);
}

async function checkExistsAlerts(client, tenMinDeltas) {
  const alerts = tenMinDeltas
    .filter((d) => ALERT_TIERS.has(d.tier)) // Titanic/Gargantuan only for this alert
    .filter((d) => {
    if (d.previous <= 0) return false; // can't compute a multiplier from zero
    const ratio = d.current / d.previous;
    if (ratio < EXISTS_MULTIPLIER_THRESHOLD) return false;

    // Secondary safeguard only — the actual root cause of implausible deltas
    // (duplicate /api/exists rows being overwritten instead of summed) was
    // fixed upstream in takeSnapshotAndReport's aggregation step. This guard
    // stays as a backstop in case a different data issue crops up later; it
    // should rarely if ever fire now. If it does fire repeatedly, that's a
    // signal something new is wrong, not expected noise.
    const SANITY_MAX_RATIO = 20;
    if (ratio > SANITY_MAX_RATIO) {
      console.warn(
        `[tracker] Exists delta exceeded sanity threshold for ${d.name} (${d.variant}): ` +
          `${d.previous} -> ${d.current} (${ratio.toFixed(1)}x). Suppressed as likely bad data.`
      );
      return false;
    }

    return true;
  });

  if (alerts.length === 0) return;

  const embed = new EmbedBuilder()
    .setTitle('⚡ Exists Spike Alert (2x+ in 10 min)')
    .setColor(0x00d1ff)
    .setDescription(
      alerts
        .map(
          (a) =>
            `**${a.name}** (${a.variant}) [${a.tier}] — ${formatNumber(a.previous)} → ${formatNumber(
              a.current
            )} (${(a.current / a.previous).toFixed(2)}x)`
        )
        .join('\n')
    )
    .setFooter({ text: `Threshold: ${EXISTS_MULTIPLIER_THRESHOLD}x vs previous 10-min snapshot · Titanic/Gargantuan only` })
    .setTimestamp();

  const chartUrl = await buildDeltaBarChartUrl(
    'Exists Multiplier',
    alerts.map((a) => ({ name: `${a.name} (${a.variant})`, value: Number((a.current / a.previous).toFixed(2)) })),
    { valueLabel: 'multiplier (x)' }
  );
  if (chartUrl) embed.setImage(chartUrl);

  await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.existsAlert, embed);
}

// Battle _id last seen — in-memory only, first check just establishes a
// baseline (doesn't wipe chart history on the very first cycle after a
// restart, since we don't actually know if the battle just changed or has
// been running a while).
let previousBattleId = null;

async function checkClanBattleChange() {
  try {
    const battle = await getActiveClanBattle();
    const battleId = battle?._id ?? battle?.configName ?? null;
    if (!battleId) return;

    const isFirstCheck = previousBattleId === null;
    const changed = !isFirstCheck && battleId !== previousBattleId;
    previousBattleId = battleId;

    if (changed) {
      console.log(`[tracker] New clan battle detected (${battleId}) — resetting clan chart history.`);
      resetClanChartHistory();
    }
  } catch (err) {
    console.error('[tracker] Failed to check for clan battle change:', err.message);
  }
}

async function recordClanHistory() {
  try {
    // Grab a generous page of top clans by Points so /clantop10 has rate data
    // beyond just the visible top 10 (needed to compute "gap to next").
    const clans = await getClans({ page: 1, pageSize: 25, sort: 'Points', sortOrder: 'desc' });
    for (const clan of clans) {
      if (clan.Name && typeof clan.Points === 'number') {
        recordClanSnapshot(clan.Name, clan.Points);
      }
    }
  } catch (err) {
    console.error('[tracker] Failed to record clan history:', err.message);
  }
}

async function postTierUpdates(client, hourlyRates, tierMap) {
  let thumbnailMap;
  try {
    thumbnailMap = await getPetThumbnailMap();
  } catch (err) {
    console.error('[tracker] Failed to load pet thumbnail map:', err.message);
    thumbnailMap = new Map();
  }

  for (const [tier, config] of Object.entries(TIER_CONFIG)) {
    const tierRates = hourlyRates
      .filter((d) => d.tier === tier)
      .sort((a, b) => b.hourlyDelta - a.hourlyDelta); // biggest gainers first

    if (tierRates.length === 0) continue;

    const gaining = tierRates.filter((d) => d.hourlyDelta > 0).slice(0, 15);
    const lines = gaining.map((d) => {
      return `**${d.name}** (${d.variant}) — ${formatCompact(d.current)} total · +${formatNumber(
        d.hourlyDelta
      )} in the last hour`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`${config.label} Hatch Rates — Trailing 1 Hour`)
      .setColor(config.color)
      .setDescription(
        lines.length
          ? lines.join('\n')
          : 'No new pets of this tier hatched in the last hour.'
      )
      .setFooter({
        text: `Exact count over the last 60 minutes, recalculated every 10 min · ${tierRates.length} ${config.label.toLowerCase()} pets tracked`,
      })
      .setTimestamp();

    // Thumbnail: the top gainer's pet image, if resolvable
    const topGainer = gaining[0];
    if (topGainer) {
      const thumb = thumbnailMap.get(topGainer.name);
      const rbxId = thumb?.thumbnail || thumb?.goldenThumbnail;
      if (rbxId) {
        const iconUrl = await resolveThumbnail(rbxId, '150x150');
        if (iconUrl) embed.setThumbnail(iconUrl);
      }
    }

    // Chart: hourly deltas for the top gainers in this tier
    const chartUrl = await buildDeltaBarChartUrl(
      `${config.label} — Hatched Last Hour`,
      gaining.map((d) => ({ name: `${d.name} (${d.variant})`, value: d.hourlyDelta })),
      { valueLabel: 'hatched' }
    );
    if (chartUrl) embed.setImage(chartUrl);

    await broadcastToConfiguredGuilds(client, config.key, embed);
  }
}

async function postTop10Updates(client) {
  try {
    const clanEmbed = await buildClanTop10Embed();
    if (clanEmbed) await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.clanTop10, clanEmbed);
  } catch (err) {
    console.error('[tracker] Failed to build/post Clan Top 10:', err.message);
  }

  try {
    const leagueEmbed = await buildLeagueTop10Embed();
    if (leagueEmbed) await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.leagueTop10, leagueEmbed);
  } catch (err) {
    console.error('[tracker] Failed to build/post League Top 10:', err.message);
  }
}

// key -> last-seen `updated` timestamp string from the Roblox games API.
// In-memory only; on bot restart this resets, so the first check after a
// restart just establishes a baseline (no alert) rather than assuming
// every restart coincides with a game update.
let previousGameUpdatedAt = null;

async function checkGameUpdate(client) {
  let game;
  try {
    game = await getGameDetails();
  } catch (err) {
    console.error('[tracker] Failed to fetch game details for update check:', err.message);
    return;
  }
  if (!game?.updated) {
    console.warn('[tracker] Game details response missing "updated" field — cannot check for updates.');
    return;
  }

  const isFirstCheck = previousGameUpdatedAt === null;
  const changed = !isFirstCheck && game.updated !== previousGameUpdatedAt;
  previousGameUpdatedAt = game.updated;

  if (isFirstCheck || !changed) return;

  const embed = new EmbedBuilder()
    .setTitle('🔄 Pet Simulator 99 Updated')
    .setColor(0x2ecc71)
    .setDescription(
      `The game was just updated (a new place publish was detected).\n` +
        `Current player count: ${formatNumber(game.playing ?? 0)}`
    )
    .setFooter({ text: 'Detected via Roblox games API · may lag the real update by a few minutes' })
    .setTimestamp();

  await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.gameUpdate, embed);
}

// Set of gamepass IDs already seen — in-memory only, so the first run after
// a restart establishes a baseline without falsely reporting every existing
// gamepass as "new".
let knownGamepassIds = null;
// Set of developer product IDs already seen — same pattern.
let knownDevProductIds = null;
// Set of pet names already seen in the Pets collection — same pattern.
let knownPetNames = null;

async function checkNewItems(client) {
  // --- New gamepasses ---
  try {
    const gamepasses = await getAllGamepasses();
    const currentIds = new Set(gamepasses.map((g) => g.id));

    if (knownGamepassIds === null) {
      knownGamepassIds = currentIds;
    } else {
      const newOnes = gamepasses.filter((g) => !knownGamepassIds.has(g.id));
      knownGamepassIds = currentIds;

      if (newOnes.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle('🆕 New Gamepass Detected')
          .setColor(0x9b59b6)
          .setDescription(
            newOnes
              .slice(0, 15)
              .map((g) => `**${g.displayName ?? g.name}** — ${g.isForSale ? 'for sale' : 'not for sale'}`)
              .join('\n')
          )
          .setFooter({ text: 'Detected via Roblox game-passes API' })
          .setTimestamp();

        await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.newItem, embed);
      }
    }
  } catch (err) {
    console.error('[tracker] Failed to check gamepasses:', err.message);
  }

  // --- New developer products ---
  // Field names here aren't fully confirmed (see robloxProxy.js caveat), so
  // this reads defensively across a few plausible id/name field variants.
  try {
    const devProducts = await getAllDeveloperProducts();
    const currentIds = new Set(devProducts.map((p) => p.id ?? p.productId));

    if (knownDevProductIds === null) {
      knownDevProductIds = currentIds;
    } else {
      const newOnes = devProducts.filter((p) => !knownDevProductIds.has(p.id ?? p.productId));
      knownDevProductIds = currentIds;

      if (newOnes.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle('🆕 New Developer Product Detected')
          .setColor(0xe67e22)
          .setDescription(
            newOnes
              .slice(0, 15)
              .map((p) => {
                const name = p.name ?? p.displayName ?? 'Unknown product';
                const price = p.priceInRobux ?? p.price;
                return price !== undefined ? `**${name}** — ${formatNumber(price)} R$` : `**${name}**`;
              })
              .join('\n')
          )
          .setFooter({ text: 'Detected via Roblox developer-products API' })
          .setTimestamp();

        await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.newItem, embed);
      }
    }
  } catch (err) {
    console.error('[tracker] Failed to check developer products:', err.message);
  }

  // --- New pets/items (via the Pets collection, same source as tier classification) ---
  try {
    const pets = await getPetsCollectionFresh();
    const currentNames = new Set();
    for (const pet of pets) {
      const name = pet.configData?.name ?? pet.configName;
      if (name) currentNames.add(name);
    }

    if (knownPetNames === null) {
      knownPetNames = currentNames;
    } else {
      const newNames = [...currentNames].filter((n) => !knownPetNames.has(n));
      knownPetNames = currentNames;

      if (newNames.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle('🆕 New Pet Detected')
          .setColor(0x3498db)
          .setDescription(newNames.slice(0, 20).map((n) => `**${n}**`).join('\n'))
          .setFooter({ text: 'Detected via Pets collection · excludes tier-filtered/prototype entries' })
          .setTimestamp();

        await broadcastToConfiguredGuilds(client, CHANNEL_KEYS.newItem, embed);
      }
    }
  } catch (err) {
    console.error('[tracker] Failed to check new pets:', err.message);
  }
}

// Per-clan-name last-seen member points: clanName -> Map(userId -> points).
// Keyed by clan name (not guild) since multiple servers could track the
// same clan — no need to duplicate the fetch/state per guild.
const previousClanMemberPoints = new Map();
// Per-clan-name last-seen battle ID, so a battle change (new clan war
// starting) resets the points baseline instead of comparing new-battle
// points against old-battle totals — which would show every member with a
// huge false NEGATIVE gain on the first cycle of a new war.
const previousClanBattleId = new Map();

async function checkClanMemberGains(client) {
  const trackers = getAllClanTrackers();
  if (trackers.length === 0) return;

  // Group by clan name so we only fetch each tracked clan once even if
  // multiple servers are tracking it.
  const clanNames = [...new Set(trackers.map((t) => t.clanName))];

  for (const clanName of clanNames) {
    let clan;
    try {
      clan = await getClan(clanName);
    } catch (err) {
      console.error(`[tracker] Failed to fetch clan "${clanName}" for member tracking:`, err.message);
      continue;
    }

    // CONFIRMED real shape (verified against a live response for "UN0"):
    // - clan.Members is the full roster: [{ UserID, PermissionLevel, JoinTime }]
    // - There is NO clan.Contribution.Battle field (the earlier version of
    //   this code assumed one that doesn't exist — real bug, fixed here).
    // - Per-member points live under clan.Battles.{BattleID}.PointContributions,
    //   which is an ARRAY THAT ONLY INCLUDES MEMBERS WHO CONTRIBUTED — a
    //   75-member clan's real PointContributions array can have as few as
    //   3-16 entries. Members not in it aren't "0 points", they're just
    //   absent from the array entirely.
    //
    // Pick the "active" battle. Primary signal: ProcessedAwards === false
    // (the battle hasn't been awarded/closed out yet). REAL BUG FIXED HERE:
    // the old version gave up entirely (posted nothing) if no battle had
    // ProcessedAwards:false — which happens during the transition window
    // right as a new clan war starts and the API hasn't caught up yet (old
    // battle already processed, new one not yet reflected). That silence
    // was indistinguishable from "the bot is broken" from the outside.
    // Fallback: if no ProcessedAwards:false battle exists, use whichever
    // battle key isn't in our own "already posted this battle" memory yet —
    // and if that's also inconclusive, just take the battle with the
    // highest BattleID insertion order (Object.entries preserves insertion
    // order for string keys, and Roblox/PS99 battle objects are typically
    // appended in chronological order) as a last resort, clearly logged.
    const battles = clan?.Battles ?? {};
    const battleEntries = Object.entries(battles);
    let activeBattleEntry = battleEntries.find(([, b]) => b?.ProcessedAwards === false);

    if (!activeBattleEntry && battleEntries.length > 0) {
      activeBattleEntry = battleEntries[battleEntries.length - 1]; // last-inserted = most recent
      console.warn(
        `[tracker] Clan "${clanName}": no battle with ProcessedAwards:false found (likely mid-transition ` +
          `to a new clan war and the API hasn't caught up). Falling back to the most recently listed battle: ` +
          `"${activeBattleEntry[0]}". If this looks wrong, the fallback heuristic may need revisiting.`
      );
    }

    if (!activeBattleEntry) {
      console.warn(`[tracker] Clan "${clanName}" has no battle data at all — skipping this cycle.`);
      continue;
    }

    const [battleId, battleData] = activeBattleEntry;
    const contributions = battleData?.PointContributions ?? [];
    const roster = Array.isArray(clan.Members) ? clan.Members : [];

    if (roster.length === 0) {
      console.warn(`[tracker] Clan "${clanName}" has no Members roster — skipping this cycle.`);
      continue;
    }

    // Build a full points-per-member map from the roster, defaulting
    // contributors not in PointContributions to 0 (they exist, they just
    // haven't scored yet this battle).
    const pointsByUserId = new Map(roster.map((m) => [m.UserID, 0]));
    for (const c of contributions) {
      if (pointsByUserId.has(c.UserID)) pointsByUserId.set(c.UserID, c.Points);
    }

    // If the battle changed since last cycle (new clan war started), the
    // old points baseline is meaningless for a delta — reset it so the
    // next cycle re-establishes a clean baseline instead of reporting huge
    // false negative "gains" from comparing new-battle points against the
    // previous war's totals.
    const lastBattleId = previousClanBattleId.get(clanName);
    const battleChanged = lastBattleId !== undefined && lastBattleId !== battleId;
    previousClanBattleId.set(clanName, battleId);

    const previous = battleChanged ? null : previousClanMemberPoints.get(clanName);
    previousClanMemberPoints.set(clanName, new Map(pointsByUserId));

    if (battleChanged) {
      console.log(`[tracker] Clan "${clanName}": battle changed from "${lastBattleId}" to "${battleId}" — resetting points baseline.`);
    }

    if (!previous) {
      console.log(`[tracker] First snapshot for clan "${clanName}" member tracking (battle: ${battleId}) — baseline established.`);
      continue; // no delta possible yet
    }

    // Resolve usernames for the full roster so the post shows real names.
    const userIds = [...pointsByUserId.keys()];
    let names;
    try {
      names = await resolveUsernames(userIds);
    } catch (err) {
      console.error('[tracker] Username resolution failed, falling back to raw IDs:', err.message);
      names = new Map();
    }

    const gains = userIds
      .map((userId) => {
        const currentPoints = pointsByUserId.get(userId);
        // If this member wasn't tracked last cycle (joined mid-tracking),
        // treat their gain as 0 rather than showing a false spike from
        // their whole battle total.
        const prevPoints = previous.has(userId) ? previous.get(userId) : currentPoints;
        return {
          userId,
          name: names.get(userId) ?? `User ${userId}`,
          current: currentPoints,
          gain: currentPoints - prevPoints,
        };
      })
      .sort((a, b) => b.gain - a.gain);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${clanName} — Member Points (Last 10 Minutes)`)
      .setColor(0xf1c40f)
      .setDescription(
        gains
          .slice(0, 25) // Discord embed description limits — 25 members covers a full clan roster comfortably
          .map((g) => `**${g.name}** — ${formatCompact(g.current)} total (${g.gain >= 0 ? '+' : ''}${formatNumber(g.gain)})`)
          .join('\n')
      )
      .setFooter({ text: `${battleId} · ${gains.length} members tracked · updates every 10 minutes` })
      .setTimestamp();

    // Post to every server tracking this clan
    for (const tracker of trackers.filter((t) => t.clanName === clanName)) {
      try {
        const channel = await client.channels.fetch(tracker.channelId);
        const roleId = getPingRole(tracker.guildId, 'clanTracker');
        await channel.send({ content: roleId ? `<@&${roleId}>` : undefined, embeds: [embed] });
      } catch (err) {
        console.error(`[tracker] Failed to post clan member gains to channel ${tracker.channelId}:`, err.message);
      }
    }

    // Separate standalone inactivity alert — only for servers that both
    // track this clan AND have inactivity alerts turned on. Reuses the same
    // gains list computed above rather than re-fetching.
    const inactiveMembers = gains.filter((g) => g.gain === 0);
    if (inactiveMembers.length > 0) {
      const inactivityEmbed = new EmbedBuilder()
        .setTitle(`💤 ${clanName} — Inactive Members (0 gain, last 10 min)`)
        .setColor(0xe74c3c)
        .setDescription(inactiveMembers.map((g) => `**${g.name}** — ${formatCompact(g.current)} total`).join('\n'))
        .setFooter({ text: `${inactiveMembers.length} of ${gains.length} members gained 0 points this cycle` })
        .setTimestamp();

      const inactivityTrackers = getAllClanInactivityTrackers().filter((t) => t.clanName === clanName);
      for (const tracker of inactivityTrackers) {
        try {
          const channel = await client.channels.fetch(tracker.channelId);
          const roleId = getPingRole(tracker.guildId, 'clanInactivity');
          await channel.send({ content: roleId ? `<@&${roleId}>` : undefined, embeds: [inactivityEmbed] });
        } catch (err) {
          console.error(`[tracker] Failed to post inactivity alert to channel ${tracker.channelId}:`, err.message);
        }
      }
    }
  }
}

async function takeSnapshotAndReport(client) {
  let existsData, tierMap;
  try {
    [existsData, tierMap] = await Promise.all([getAllExists(), getPetTierMap()]);
  } catch (err) {
    console.error('[tracker] Failed to fetch data:', err.message);
    return;
  }

  // IMPORTANT: /api/exists can return multiple rows that resolve to the same
  // pet+variant key (id|pt|sh) — e.g. split across different internal
  // categories. Treating each row as a separate independent snapshot (the
  // previous behavior) meant whichever row was processed last silently
  // overwrote the others, corrupting the "previous" value used for delta
  // math and producing physically-impossible jumps (e.g. 170 -> 20,000 in
  // 10 minutes) — confirmed via captured logs showing the same duplicate
  // keys firing every single cycle. Fix: SUM all rows sharing a key into one
  // true total before doing any comparison, so each pet+variant is only
  // ever recorded once per cycle.
  const aggregated = new Map(); // key -> { name, cfg, total }
  for (const entry of existsData) {
    const cfg = entry.configData ?? {};
    const name = cfg.id;
    if (!name) continue;

    const tier = tierMap.get(name);
    if (!tier) continue; // only track Huge/Titanic/Gargantuan

    const key = entryKey(entry);
    const existing = aggregated.get(key);
    if (existing) {
      existing.total += entry.value;
    } else {
      aggregated.set(key, { name, cfg, tier, total: entry.value });
    }
  }

  const tenMinDeltas = []; // { name, variant, tier, previous, current } — for the 2x/10min alert
  const hourlyRates = []; // { name, variant, tier, current, hourlyDelta } — exact trailing-60min count

  let anyKeySeenBefore = false;

  for (const [key, agg] of aggregated) {
    const previousSnapshot = getPetExistsPreviousSnapshot(key);

    if (previousSnapshot) {
      anyKeySeenBefore = true;
      tenMinDeltas.push({
        name: agg.name,
        variant: variantLabel(agg.cfg),
        tier: agg.tier,
        previous: previousSnapshot.value,
        current: agg.total,
      });
    }

    // Record BEFORE reading the hourly delta so the getter (called just after)
    // sees this entry included — matches getClanRate's own pattern where the
    // "last" point is the one just recorded.
    recordPetExistsSnapshot(key, agg.total);

    const hourly = getPetExistsHourlyDelta(key);
    if (hourly) {
      hourlyRates.push({
        name: agg.name,
        variant: variantLabel(agg.cfg),
        tier: agg.tier,
        current: agg.total,
        hourlyDelta: hourly.delta,
      });
    }
  }

  const isFirstRun = !anyKeySeenBefore;

  // Run RAP + clan-history side jobs regardless of whether this is the first
  // exists snapshot — they maintain their own independent history.
  await checkClanBattleChange(); // must run BEFORE recordClanHistory so a reset doesn't wipe this cycle's point
  await Promise.all([checkRapAlerts(client, tierMap), recordClanHistory()]);

  if (isFirstRun) {
    console.log('[tracker] First snapshot taken, baseline established. Rates will post next cycle.');
    return;
  }

  await checkExistsAlerts(client, tenMinDeltas);

  if (hourlyRates.length > 0) {
    await postTierUpdates(client, hourlyRates, tierMap);
  } else {
    console.log('[tracker] Not enough history yet for a full trailing-hour window — skipping tier posts this cycle.');
  }

  await postTop10Updates(client);
  await checkGameUpdate(client);
  await checkNewItems(client);
  await checkClanMemberGains(client);
}

export function startTracker(client) {
  console.log('[tracker] Starting hourly-rate tracker (10 min interval)...');
  // Take an initial snapshot immediately so we have a baseline without waiting 10 min.
  takeSnapshotAndReport(client);
  setInterval(() => takeSnapshotAndReport(client), SNAPSHOT_INTERVAL_MS);
}
