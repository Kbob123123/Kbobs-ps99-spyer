import fetch from 'node-fetch';
import { EmbedBuilder } from 'discord.js';
import { getGameState, setGameState, getChannelsOfKind } from './db.js';
import { formatNumber } from './format.js';

/**
 * Watches the live Roblox game for updates and restarts.
 *
 * One unauthenticated endpoint carries everything needed:
 *
 *   games.roproxy.com/v1/games?universeIds=3317771874
 *
 * verified live on 2026-08-22, returning `updated`, `playing`, `name` and
 * `rootPlaceId`. Two events fall out of it:
 *
 *   update  — the `updated` timestamp moves. BIG Games republishes the place
 *             when they ship, so this is the update itself, not a proxy for
 *             it. The name usually changes in the same moment because the
 *             current event is a tag in the title ("[PIÑATA MAZE]"), which is
 *             what makes the announcement worth reading.
 *   restart  — `playing` collapses. A rolling server restart empties the game
 *             within a couple of minutes, and nothing else does.
 */

const GAMES_API = 'https://games.roproxy.com/v1/games';

// The live game only. The dev game's player count is single digits, where a
// "collapse" is two people logging off and every restart rule is meaningless.
export const WATCHED_UNIVERSE = {
  id: '3317771874',
  rootPlaceId: '8737899170',
  label: 'Pet Simulator 99',
};

const CHANNEL_KIND = 'game';

/**
 * A restart is a drop to this fraction of the recent peak, or below.
 *
 * Measured against a live reading of ~50,000 concurrent players. Ordinary
 * churn between two 10-minute polls is low single-digit percent; the daily
 * trough is a slow slide, not a step. 40% of peak is far outside normal
 * movement while still catching a restart that is already recovering by the
 * time we look.
 */
const RESTART_DROP_FRACTION = 0.4;

/**
 * Below this many players, ignore drops entirely.
 *
 * Percentages are meaningless on small numbers, and a game genuinely sitting
 * at a few hundred players is either having an outage we cannot diagnose or
 * being read mid-glitch. Either way it is not a clean "restart" signal.
 */
const MIN_PEAK_FOR_RESTART = 5000;

/**
 * How much of the previous peak survives into the next comparison.
 *
 * The peak has to decay or it ratchets: one holiday spike would set a high
 * water mark that makes every ordinary evening look like a restart forever.
 * Decaying toward the current reading keeps "peak" meaning "recently normal".
 */
const PEAK_DECAY = 0.9;

/** Fetch the live game record, or null if the API is unhappy. */
export async function fetchGameInfo(universeId = WATCHED_UNIVERSE.id) {
  const res = await fetch(`${GAMES_API}?universeIds=${universeId}`, {
    headers: { 'User-Agent': 'ps99-pet-spyer/2.1' },
  });

  if (!res.ok) throw new Error(`Roblox games API returned HTTP ${res.status}`);

  const body = await res.json();
  const game = body?.data?.[0];
  if (!game) return null;

  return {
    universeId: String(game.id),
    name: game.name ?? null,
    updated: game.updated ?? null,
    playing: Number(game.playing ?? 0),
    rootPlaceId: game.rootPlaceId != null ? String(game.rootPlaceId) : null,
  };
}

/**
 * Compare a live reading against the stored one and return the events.
 *
 * Pure, so the thresholds above are testable without a network or a database.
 */
export function diffGameState(previous, live) {
  const events = [];

  if (!previous) return events;

  if (previous.updated && live.updated && previous.updated !== live.updated) {
    events.push({
      type: 'update',
      previousName: previous.name,
      name: live.name,
      // A tag change is the player-visible half of an update. Called out
      // separately so the embed can lead with it when it happened.
      renamed: previous.name !== live.name,
    });
  }

  const peak = Number(previous.peak_playing ?? previous.playing ?? 0);
  if (peak >= MIN_PEAK_FOR_RESTART && live.playing <= peak * RESTART_DROP_FRACTION) {
    events.push({ type: 'restart', from: peak, to: live.playing });
  }

  return events;
}

/** The peak to carry into the next comparison. */
export function nextPeak(previousPeak, playing) {
  const decayed = Math.round(Number(previousPeak ?? 0) * PEAK_DECAY);
  return Math.max(playing, decayed);
}

/** Extract the event tag from a game name, e.g. "[PIÑATA MAZE]". */
export function extractTag(name) {
  return name?.match(/\[([^\]]+)\]/)?.[1]?.trim() ?? null;
}

function buildUpdateEmbed(event, live) {
  const tag = extractTag(live.name);
  const previousTag = extractTag(event.previousName);

  const embed = new EmbedBuilder()
    .setTitle('🚀 GAME UPDATE')
    .setColor(0x57f287)
    .setTimestamp();

  const story = [];
  if (event.renamed && tag && tag !== previousTag) {
    story.push(`## ${tag}`);
    story.push(`Pet Simulator 99 just updated${previousTag ? ` — was **${previousTag}**` : ''}.`);
  } else {
    story.push('## Pet Simulator 99 just updated');
    if (event.renamed) story.push(`Renamed to **${live.name?.trim()}**.`);
  }
  embed.setDescription(story.join('\n'));

  embed.addFields(
    { name: '🎮 Now playing', value: `**${formatNumber(live.playing)}**`, inline: true },
    {
      name: '🕒 Published',
      value: live.updated ? `<t:${Math.floor(new Date(live.updated).getTime() / 1000)}:R>` : '—',
      inline: true,
    },
    {
      name: '🔗 Link',
      value: `[Play ${WATCHED_UNIVERSE.label}](https://www.roblox.com/games/${WATCHED_UNIVERSE.rootPlaceId})`,
      inline: false,
    }
  );

  return embed;
}

function buildRestartEmbed(event, live) {
  return new EmbedBuilder()
    .setTitle('🔄 SERVERS RESTARTING')
    .setColor(0xfee75c)
    .setDescription(
      '## Pet Simulator 99 is restarting\n' +
        'Player count just collapsed, which is what a rolling server restart looks like. ' +
        'This usually means an update is landing — rejoin in a couple of minutes.'
    )
    .addFields(
      { name: '📉 Players now', value: `**${formatNumber(event.to)}**`, inline: true },
      { name: '⏪ Recent peak', value: formatNumber(event.from), inline: true }
    )
    .setTimestamp();
}

/**
 * One pass. Called from the 10-minute poll.
 *
 * Never throws at the caller: the game watch is a side feature and must not
 * be able to cost a poll that is also doing the bot's main job.
 *
 * Returns the events it announced, so the caller can follow an update with a
 * summary of what the update actually added. Returning them rather than
 * building that summary here keeps this file about ONE question — did the
 * game change — instead of also owning the item catalogue.
 */
export async function runGameWatch(client) {
  let live;
  try {
    live = await fetchGameInfo();
  } catch (err) {
    console.warn('[game] Could not read the games API:', err.message);
    return [];
  }

  if (!live) return [];

  const previous = getGameState(live.universeId);
  const events = diffGameState(previous, live);

  const peakPlaying = nextPeak(previous?.peak_playing ?? previous?.playing, live.playing);

  // First run records the baseline silently — there is nothing to compare
  // against, and announcing "the game updated" on our own first boot would be
  // a lie about the game.
  if (!previous) {
    setGameState({ ...live, peakPlaying });
    console.log(`[game] Baseline recorded: "${live.name?.trim()}", ${live.playing} playing.`);
    return [];
  }

  if (events.length === 0) {
    setGameState({ ...live, peakPlaying });
    return [];
  }

  console.log(`[game] ${events.length} event(s): ${events.map((e) => e.type).join(', ')}`);

  const channels = getChannelsOfKind(CHANNEL_KIND);

  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    for (const event of events) {
      const embed = event.type === 'update' ? buildUpdateEmbed(event, live) : buildRestartEmbed(event, live);
      await channel
        .send({ embeds: [embed] })
        .catch((err) => console.warn(`[game] Could not post to ${row.channel_id}:`, err.message));
    }
  }

  // Written after posting, so a crash mid-post cannot advance the baseline
  // past an update nobody was told about.
  //
  // On a restart specifically the peak is RESET to the current reading rather
  // than the decayed maximum. Keeping the old peak would re-fire the same
  // restart on every poll until the game refilled — one event, a dozen alerts.
  const hadRestart = events.some((e) => e.type === 'restart');
  setGameState({ ...live, peakPlaying: hadRestart ? live.playing : peakPlaying });

  return events;
}
