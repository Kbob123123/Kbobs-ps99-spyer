import { EmbedBuilder, PermissionFlagsBits, AuditLogEvent, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getMeta, setMeta, isCommandLoggingEnabled, addWhitelistedGuild, countWhitelistedGuilds } from './db.js';
import { isOwner, OWNER_ID } from './owner.js';

// Prefix for the Accept/Decline buttons on an unapproved-join log post, so
// index.js can route them here without knowing anything about the join flow.
export const JOIN_REQUEST_PREFIX = 'joinreq:';

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
 * Create an invite to a guild, or null if the bot can't.
 *
 * Shared by the owner menu and the unapproved-join log. Plenty of servers add
 * a bot with minimal permissions, so "no invite possible" is a normal outcome
 * rather than an error.
 */
export async function createGuildInvite(guild, { maxAge = 3600, maxUses = 1, reason } = {}) {
  try {
    const me = guild.members.me;
    const channel = guild.channels.cache.find(
      (c) => c.isTextBased?.() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite)
    );
    if (!channel) return null;

    const invite = await channel.createInvite({ maxAge, maxUses, unique: true, reason });
    return { url: `https://discord.gg/${invite.code}`, channelName: channel.name };
  } catch (err) {
    console.warn(`[invite] Could not create an invite for ${guild?.id}:`, err.message);
    return null;
  }
}

/**
 * Who added the bot, if the audit log is readable.
 *
 * Needs View Audit Log, which a minimally-permissioned invite won't grant, so
 * this returns null far more often than not.
 */
async function findInviter(guild) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 });
    const entry = logs.entries.find((e) => e.target?.id === guild.client.user.id);
    return entry?.executor ?? null;
  } catch {
    return null;
  }
}

/**
 * Report a server the bot has just joined — approved or not — to the log
 * channel, with an invite link.
 *
 * For an unapproved server this must run BEFORE leaving: an invite belongs to
 * the server rather than to the bot, so a link made now still works after the
 * bot has gone, and it is the owner's only route in to look at a server that
 * tried to add the bot.
 */
export async function postGuildJoinLog(client, guild, { approved, onStartup = false } = {}) {
  const channelId = getLogChannelId();
  if (!channelId) return null;

  // Long-lived on purpose: this sits in a log channel waiting to be read,
  // possibly days later, and a link that expired first would be useless.
  const invite = await createGuildInvite(guild, {
    maxAge: 7 * 24 * 3600,
    maxUses: 0,
    reason: approved ? 'Owner access to a joined server' : 'Unapproved server — for the owner to review',
  });

  const inviter = await findInviter(guild);

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return invite;

    const title = approved
      ? '✅ Joined an approved server'
      : onStartup
        ? '🧹 Removed an unapproved server'
        : '🚫 Blocked an invite attempt';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(approved ? 0x57f287 : 0xc98500)
      .setDescription(
        [
          `**Server:** ${guild.name}`,
          `**ID:** \`${guild.id}\``,
          `**Members:** ${(guild.memberCount ?? 0).toLocaleString()}`,
          `**Added by:** ${inviter ? `<@${inviter.id}> · \`${inviter.id}\`` : '_unknown (no audit log access)_'}`,
          `**Invite:** ${invite ? invite.url : '_none — no permission to create one_'}`,
        ].join('\n')
      )
      .setFooter({
        text: approved
          ? 'Invite lasts 7 days.'
          : invite
            ? 'Invite lasts 7 days and still works after the bot leaves. Approve it in /ownermenu to let it back in.'
            : 'No invite could be created. Approve it in /ownermenu if you want it back.',
      })
      .setTimestamp();

    if (guild.iconURL()) embed.setThumbnail(guild.iconURL());

    // Accept/Decline only on the unapproved cases — an approved join needs no
    // decision, there is nothing to acknowledge. By the time this posts the
    // bot has typically already left (enforceGuildWhitelist logs before it
    // leaves, but the owner reads this later), so Accept can only whitelist
    // for NEXT time — it can't reopen the door on its own. Said plainly in the
    // button's own follow-up rather than left to be discovered.
    const components = approved
      ? []
      : [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${JOIN_REQUEST_PREFIX}accept:${guild.id}`)
              .setLabel('Approve')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅'),
            new ButtonBuilder()
              .setCustomId(`${JOIN_REQUEST_PREFIX}decline:${guild.id}`)
              .setLabel('Decline')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('✖️')
          ),
        ];

    await channel.send({ embeds: [embed], components });
  } catch (err) {
    console.warn('[log] Could not report a server join:', err.message);
  }

  return invite;
}

/**
 * Handle a click on the Approve/Decline buttons under an unapproved-join log
 * post — the "acknowledgements" shortcut for what /ownermenu's whitelist modal
 * already does by hand.
 *
 * Approve whitelists the guild for next time; it cannot make the bot rejoin by
 * itself (it has no invite to use), so the reply says so rather than implying
 * the server is back. Decline just records that the owner saw it — the guild
 * was never whitelisted, so there's nothing to undo.
 */
export async function handleJoinRequestButton(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: '🔒 Only the bot owner can act on this.', ephemeral: true }).catch(() => {});
    return;
  }

  const rest = interaction.customId.slice(JOIN_REQUEST_PREFIX.length);
  const [verb, guildId] = rest.split(':');

  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
    ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
  );

  if (verb === 'accept') {
    const wasEmpty = countWhitelistedGuilds() === 0;
    addWhitelistedGuild({ guildId, note: 'approved via join-request button', addedBy: interaction.user.id });

    await interaction.update({ components: [disabledRow] });
    await interaction.followUp({
      content:
        `✅ Whitelisted \`${guildId}\`.` +
        (wasEmpty ? '\n⚠️ That was the first entry — every other server is now blocked.' : '') +
        '\n\n_The bot has already left this server (or was never able to join), so this only ' +
        'approves it for next time — someone in that server needs to invite it again._',
      ephemeral: true,
    });
    return;
  }

  await interaction.update({ components: [disabledRow] });
  await interaction.followUp({ content: `✖️ Acknowledged — \`${guildId}\` stays blocked.`, ephemeral: true });
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
