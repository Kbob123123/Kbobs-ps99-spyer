import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';
import { CHANGELOG, entriesNewerThan, compareVersions } from './changelog.js';
import { getMeta, setMeta, getBotUpdateChannels } from './db.js';

/**
 * Posts the bot's own changelog to registered channels when a new version
 * deploys.
 *
 * The whole feature turns on ONE decision: what it keys off. Railway restarts
 * these services constantly — a redeploy, an OOM, a platform blip — so "did I
 * just boot" would re-post the same notes several times a week and train
 * everyone to mute the channel. It keys off the VERSION instead, stored once
 * globally, so a hundred restarts on the same build announce exactly nothing.
 *
 * Two more consequences of that marker being GLOBAL rather than per channel:
 *
 *   - A channel registered today gets the NEXT release, never the back
 *     catalogue. Per-channel markers would replay the entire history into
 *     every newly registered channel, which is the same bug wearing a hat.
 *   - A release that ships while no channel is registered is simply missed.
 *     That follows directly from the above and is the intended trade.
 */

const MARKER_KEY = 'last_announced_version';

// Discord caps a message at 10 embeds. Only reachable if several releases go
// unannounced at once (the bot was down across two deploys), but the cap is
// cheap to respect and a rejected message would lose the lot.
const EMBEDS_PER_MESSAGE = 10;

const COLOR_UPDATE = 0x2ee6c5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The version actually running, read from package.json.
 *
 * Deliberately not a constant duplicated in code: the deployed build IS
 * package.json's version, so reading it there means the announcement can never
 * claim a version that was not shipped. Read once at module load — it cannot
 * change under a running process.
 */
export const RUNNING_VERSION = readRunningVersion();

function readRunningVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? null;
  } catch (err) {
    console.warn('[updates] Could not read version from package.json:', err.message);
    return null;
  }
}

/** One embed per release. */
export function buildUpdateEmbed(entry) {
  const embed = new EmbedBuilder()
    .setTitle(`📢 Bot Update — v${entry.version}`)
    .setColor(COLOR_UPDATE)
    .setDescription(entry.lines.map((line) => `• ${line}`).join('\n\n').slice(0, 4096));

  if (entry.date) embed.setFooter({ text: `Released ${entry.date}` });

  return embed;
}

/**
 * Announce anything newer than the stored marker.
 *
 * Called once on startup. Safe to call again; the marker makes it idempotent.
 *
 * @param {import('discord.js').Client} client
 * @param {object} [options]
 * @param {Array} [options.entries] Changelog to use. Injected by the tests.
 * @returns {Promise<{announced: string[], posted: number, reason?: string}>}
 */
export async function announceUpdates(client, { entries = CHANGELOG } = {}) {
  const previous = getMeta(MARKER_KEY);

  // First ever run. Record where we are and post NOTHING: the alternative is
  // dumping the entire history into a channel the moment the feature ships,
  // which is exactly the noise the "nothing retroactive" rule exists to stop.
  if (previous == null) {
    setMeta(MARKER_KEY, RUNNING_VERSION ?? '0.0.0');
    console.log(`[updates] First run — marker set to v${RUNNING_VERSION}; nothing announced.`);
    return { announced: [], posted: 0, reason: 'first-run' };
  }

  const pending = entriesNewerThan(previous, RUNNING_VERSION, entries);

  if (pending.length === 0) {
    // Still advance to the running version. Without this, a release carrying
    // no changelog entry leaves the marker behind it forever, and any entry
    // written for an older version later would announce retroactively.
    if (RUNNING_VERSION && compareVersions(RUNNING_VERSION, previous) > 0) {
      setMeta(MARKER_KEY, RUNNING_VERSION);
    }
    return { announced: [], posted: 0, reason: 'nothing-new' };
  }

  const channels = getBotUpdateChannels();
  const embeds = pending.map(buildUpdateEmbed);

  let posted = 0;
  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    // A new message per release batch, never an edit: an update IS an event,
    // and the house rule is that events get their own message.
    for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
      const sent = await channel
        .send({ embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE) })
        .catch((err) => {
          console.warn(`[updates] Could not post to ${row.channel_id}:`, err.message);
          return null;
        });
      if (sent) posted += 1;
    }
  }

  // Advance the marker whether or not every channel took the message. A
  // channel the bot was kicked from would otherwise hold the marker back and
  // re-announce the same release to every OTHER channel on every restart —
  // one broken server spamming everybody else.
  const newest = pending[pending.length - 1].version;
  setMeta(MARKER_KEY, newest);

  console.log(
    `[updates] Announced ${pending.length} release(s) (${pending.map((e) => 'v' + e.version).join(', ')}) ` +
      `to ${channels.length} channel(s); ${posted} message(s) sent.`
  );

  return { announced: pending.map((e) => e.version), posted };
}
