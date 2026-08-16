import { EmbedBuilder } from 'discord.js';
import { getMeta, setMeta, isCommandLoggingEnabled } from './db.js';
import { OWNER_ID } from './owner.js';

// Where command activity is posted, Dyno-style: one message per command, in a
// channel the owner picks. Stored rather than held in memory so a deploy does
// not quietly stop the feed.
const LOG_CHANNEL_KEY = 'log_channel_id';

export function getLogChannelId() {
  return getMeta(LOG_CHANNEL_KEY);
}

export function setLogChannelId(channelId) {
  setMeta(LOG_CHANNEL_KEY, channelId ?? '');
}

export function clearLogChannel() {
  setMeta(LOG_CHANNEL_KEY, '');
}

/**
 * Post one command invocation to the log channel.
 *
 * Fire-and-forget by design — this is observability, and it must never be the
 * reason a user's command fails. Every failure path swallows.
 *
 * The channel is fetched fresh each time rather than cached: it can be
 * deleted, or the bot's access to it revoked, at any point.
 */
export async function postCommandLog(client, entry) {
  if (!isCommandLoggingEnabled()) return;

  const channelId = getLogChannelId();
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const failed = entry.outcome !== 'ok';
    const blocked = entry.outcome === 'blocked';

    const embed = new EmbedBuilder()
      .setColor(blocked ? 0xc98500 : failed ? 0xed4245 : 0x57f287)
      .setAuthor({ name: `${entry.username ?? entry.userId}`, iconURL: entry.avatarUrl ?? undefined })
      .setDescription(
        [
          `**Command:** \`/${entry.command}${entry.options ? ' ' + entry.options : ''}\``,
          `**Server:** ${entry.guildName ?? 'Direct message'}${entry.guildId ? ` (\`${entry.guildId}\`)` : ''}`,
          `**User:** <@${entry.userId}> · \`${entry.userId}\``,
          `**Result:** ${blocked ? '🔒 blocked (server not approved)' : failed ? `❌ ${entry.outcome}` : '✅ ok'}`,
        ].join('\n')
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    // A missing channel or lost permission should not spam the console on
    // every single command, so this stays at debug volume.
    console.warn('[log] Could not post to the log channel:', err.message);
  }
}

/**
 * Tell a server the bot is leaving, before it actually goes.
 *
 * Sent on an owner-initiated removal so the server sees an explanation rather
 * than the bot silently vanishing. Best-effort: if there is nowhere it can
 * post, the departure just happens quietly.
 */
export async function postLeaveNotice(guild, { reason } = {}) {
  try {
    const me = guild.members.me;
    const channel =
      guild.systemChannel?.permissionsFor(me)?.has('SendMessages')
        ? guild.systemChannel
        : guild.channels.cache.find(
            (c) => c.isTextBased?.() && c.permissionsFor(me)?.has('SendMessages')
          );

    if (!channel) return false;

    const embed = new EmbedBuilder()
      .setTitle('👋 Leaving this server')
      .setColor(0xed4245)
      .setDescription(
        (reason ? `${reason}\n\n` : '') +
          'The bot is leaving, so it will stop responding here and any tracking ' +
          'set up in this server has ended.\n\n' +
          // A plain mention rather than just a name: it renders as a clickable
          // pill, which is the shortest path from "we lost the bot" to actually
          // asking for access.
          `📩 **Want access?** DM <@${OWNER_ID}> to request whitelist approval.\n` +
          `_You'll need this server's ID:_ \`${guild.id}\``
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.warn(`[leave] Could not post a leaving notice in ${guild?.id}:`, err.message);
    return false;
  }
}
