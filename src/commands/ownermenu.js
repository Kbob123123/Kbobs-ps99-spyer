import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  addWhitelistedGuild,
  removeWhitelistedGuild,
  getWhitelistedGuilds,
  countWhitelistedGuilds,
  isGuildWhitelisted,
  getCommandLog,
  getCommandLogSummary,
  isCommandLoggingEnabled,
  setCommandLoggingEnabled,
} from '../lib/db.js';
import { isOwner, OWNER_ID } from '../lib/owner.js';
import { getLogChannelId, setLogChannelId, clearLogChannel, postLeaveNotice, createGuildInvite } from '../lib/commandLog.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/format.js';

// One command, one menu. Everything else happens through buttons on the reply
// rather than subcommands, so the owner types /ownermenu and clicks.
//
// Deliberately has NO setDefaultMemberPermissions: that gate is per-guild and
// every server admin satisfies it, which is the opposite of "one specific
// user". Ownership is checked at runtime, on the command AND on every button.
export const data = new SlashCommandBuilder()
  .setName('ownermenu')
  .setDescription('Bot owner console.');

// Prefix on every custom_id so index.js can route components back here without
// knowing anything about the individual buttons.
export const COMPONENT_PREFIX = 'ownermenu:';

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!isOwner(interaction.user.id)) {
    await interaction.editReply(
      '🔒 This command is restricted to the bot owner.\n' +
        `_Configured owner ID: \`${OWNER_ID}\`. Your ID: \`${interaction.user.id}\`._`
    );
    return;
  }

  await interaction.editReply(buildHomeView(interaction.client));
}

/**
 * Handle a button press or modal submit from the menu.
 *
 * Called from index.js. Re-checks ownership: a component custom_id is visible
 * to anyone who can see the message, and ephemeral replies are not a security
 * boundary, so trusting the original command's check would be wrong.
 */
export async function handleComponent(interaction) {
  if (!isOwner(interaction.user.id)) {
    const reply = { content: '🔒 Not your menu.', ephemeral: true };
    await (interaction.replied || interaction.deferred
      ? interaction.followUp(reply)
      : interaction.reply(reply)
    ).catch(() => {});
    return;
  }

  const action = interaction.customId.slice(COMPONENT_PREFIX.length);

  // Modals must be shown BEFORE any defer/update, so they are handled first.
  if (action === 'whitelist_add') return showGuildModal(interaction, 'add');
  if (action === 'whitelist_remove') return showGuildModal(interaction, 'remove');
  if (action === 'set_log_channel') return showLogChannelModal(interaction);

  if (interaction.isModalSubmit()) {
    if (action === 'modal_logchannel') return handleLogChannelModal(interaction);
    return handleGuildModal(interaction);
  }

  // Picking a server from the dropdown.
  if (action === 'pick_guild') {
    await interaction.deferUpdate();
    return interaction.editReply(buildGuildView(interaction.client, interaction.values[0]));
  }

  await interaction.deferUpdate();

  if (action === 'home') return interaction.editReply(buildHomeView(interaction.client));
  if (action === 'servers') return interaction.editReply(buildServersView(interaction.client));
  if (action === 'whitelist') return interaction.editReply(buildWhitelistView(interaction.client));
  if (action === 'logs') return interaction.editReply(buildLogsView(interaction.client, false));
  if (action === 'logs_summary') return interaction.editReply(buildLogsView(interaction.client, true));

  if (action === 'toggle_logging') {
    setCommandLoggingEnabled(!isCommandLoggingEnabled());
    return interaction.editReply(buildHomeView(interaction.client));
  }

  // Per-server actions carry their guild id in the custom_id.
  const [verb, guildId] = action.split(':');

  if (verb === 'guild') return interaction.editReply(buildGuildView(interaction.client, guildId));

  if (verb === 'wl') {
    if (isGuildWhitelisted(guildId)) removeWhitelistedGuild(guildId);
    else addWhitelistedGuild({ guildId, note: null, addedBy: interaction.user.id });
    return interaction.editReply(buildGuildView(interaction.client, guildId));
  }

  if (action === 'all_invites') return interaction.editReply(await buildAllInvitesView(interaction.client));

  if (verb === 'invite') return interaction.editReply(await buildInviteView(interaction.client, guildId));

  if (verb === 'leaveask') return interaction.editReply(buildLeaveConfirmView(interaction.client, guildId));

  if (verb === 'leavego') {
    const guild = interaction.client.guilds.cache.get(guildId);
    if (!guild) return interaction.editReply(buildServersView(interaction.client));

    const name = guild.name;
    try {
      // Tell them before going, not after — once the bot has left it has no
      // way to post anything in that server.
      const noticed = await postLeaveNotice(guild);
      await guild.leave();

      return interaction.editReply({
        content: '',
        embeds: [
          new EmbedBuilder()
            .setTitle('🚪 Left the server')
            .setColor(0xed4245)
            .setDescription(
              `The bot has left **${name}** (\`${guildId}\`).\n\n` +
                (noticed
                  ? '📨 A leaving message was posted there first.\n\n'
                  : '⚠️ No leaving message could be posted — nowhere the bot could send one.\n\n') +
                '_Only an admin of that server can invite it back — you cannot rejoin it yourself._'
            )
            .setTimestamp(),
        ],
        components: [backRow()],
      });
    } catch (err) {
      return interaction.editReply({
        content: '',
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Could not leave')
            .setColor(0xed4245)
            .setDescription(`Leaving **${name}** failed: ${err.message}`)
            .setTimestamp(),
        ],
        components: [backRow()],
      });
    }
  }
}

/* ---------------------------------------------------------------------------
 * Views
 * ------------------------------------------------------------------------- */

function button(action, label, style, emoji) {
  return new ButtonBuilder()
    .setCustomId(COMPONENT_PREFIX + action)
    .setLabel(label)
    .setStyle(style)
    .setEmoji(emoji);
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    button('home', 'Back to menu', ButtonStyle.Secondary, '◀️')
  );
}

function buildHomeView(client) {
  const logging = isCommandLoggingEnabled();
  const guilds = client.guilds.cache;
  const whitelisted = countWhitelistedGuilds();
  const totalLogged = getCommandLogSummary(1000).reduce((n, r) => n + r.uses, 0);
  const logChannelId = getLogChannelId();

  const blocked = guilds.filter((g) => !isGuildWhitelisted(g.id)).size;

  const embed = new EmbedBuilder()
    .setTitle('🔐 Owner console')
    .setColor(0x5865f2)
    .setDescription(
      [
        `🖥️ **Servers:** ${guilds.size}` + (blocked > 0 ? ` · ⛔ ${blocked} not approved` : ''),
        `✅ **Approved:** ${whitelisted}` +
          (whitelisted === 0 ? ' — _nothing is approved, so the bot answers no one but you_' : ''),
        `📜 **Command logging:** ${logging ? '🟢 running' : '🔴 stopped'}`,
        `📨 **Log channel:** ${logChannelId ? `<#${logChannelId}>` : '_not set — nothing is being posted_'}`,
        `📊 **Commands recorded:** ${totalLogged.toLocaleString()}`,
      ].join('\n')
    )
    .setFooter({ text: 'Servers must be approved individually. You are never blocked.' })
    .setTimestamp();

  const rows = [
    new ActionRowBuilder().addComponents(
      button('servers', 'Servers', ButtonStyle.Primary, '🖥️'),
      button('whitelist', 'Approved', ButtonStyle.Primary, '✅'),
      button('logs', 'Logs', ButtonStyle.Primary, '📜')
    ),
    new ActionRowBuilder().addComponents(
      button(
        'toggle_logging',
        logging ? 'Stop logging' : 'Start logging',
        logging ? ButtonStyle.Danger : ButtonStyle.Success,
        logging ? '⏹️' : '▶️'
      ),
      button('set_log_channel', 'Set log channel', ButtonStyle.Secondary, '📨')
    ),
  ];

  return { content: '', embeds: [embed], components: rows };
}

async function showLogChannelModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(`${COMPONENT_PREFIX}modal_logchannel`)
    .setTitle('Command log channel')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('channelId')
          .setLabel('Channel ID (blank to turn off)')
          .setPlaceholder('right-click a channel → Copy Channel ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      )
    );

  await interaction.showModal(modal);
}

async function handleLogChannelModal(interaction) {
  const raw = interaction.fields.getTextInputValue('channelId').trim();

  if (!raw) {
    clearLogChannel();
    await interaction.reply({ content: '📨 Log channel cleared — nothing will be posted.', ephemeral: true });
    return;
  }

  // Accept a raw ID or a #channel mention, since both are easy to paste.
  const channelId = raw.replace(/[<#>]/g, '');

  if (!/^\d{15,25}$/.test(channelId)) {
    await interaction.reply({
      content: `❌ \`${raw}\` isn't a channel ID. Right-click the channel → Copy Channel ID.`,
      ephemeral: true,
    });
    return;
  }

  // Prove the bot can actually post there before saving, so a typo surfaces
  // now rather than as silence when the first command is run.
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      await interaction.reply({ content: `❌ <#${channelId}> isn't a text channel.`, ephemeral: true });
      return;
    }

    setLogChannelId(channelId);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('📨 Command log enabled')
          .setColor(0x57f287)
          .setDescription('Every command run in any server will be posted here.')
          .setTimestamp(),
      ],
    });

    await interaction.reply({
      content: `✅ Logging to <#${channelId}>. A test message has been posted there.`,
      ephemeral: true,
    });
  } catch (err) {
    await interaction.reply({
      content: `❌ Couldn't use <#${channelId}>: ${err.message}\n_The bot needs to see the channel and have permission to post._`,
      ephemeral: true,
    });
  }
}

function buildServersView(client) {
  const guilds = [...client.guilds.cache.values()].sort(
    (a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0)
  );
  const enforcing = countWhitelistedGuilds() > 0;

  const lines = guilds.map((g) => {
    const mark = !enforcing ? '⚪' : isGuildWhitelisted(g.id) ? '✅' : '⛔';
    return `${mark} **${g.name}** · \`${g.id}\` · ${(g.memberCount ?? 0).toLocaleString()} members`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🖥️ Servers (${guilds.length})`)
    .setColor(0x5865f2)
    .setDescription(capToFieldLimit(lines, '_The bot is not in any servers._', DESCRIPTION_LIMIT))
    .setFooter({
      text:
        (enforcing ? '✅ allowed · ⛔ blocked' : '⚪ Whitelist empty — every server is allowed.') +
        ' · Pick one below to get an invite or remove the bot.',
    })
    .setTimestamp();

  const components = [];

  if (guilds.length > 0) {
    // Discord caps a select menu at 25 options. Showing the biggest servers
    // first means the truncated tail is the least interesting end of the list.
    const options = guilds.slice(0, 25).map((g) => ({
      label: g.name.slice(0, 100),
      description: `${(g.memberCount ?? 0).toLocaleString()} members · ${g.id}`.slice(0, 100),
      value: g.id,
    }));

    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(COMPONENT_PREFIX + 'pick_guild')
          .setPlaceholder(
            guilds.length > 25 ? 'Pick a server (showing the 25 largest)' : 'Pick a server to manage'
          )
          .addOptions(options)
      )
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      button('all_invites', 'Invites for all servers', ButtonStyle.Primary, '🔗'),
      button('home', 'Back to menu', ButtonStyle.Secondary, '◀️')
    )
  );

  return { content: '', embeds: [embed], components };
}

/**
 * An invite to every server the bot is in, in one place.
 *
 * Serial rather than parallel: this is N invite creations against the Discord
 * API, and firing them all at once is the fastest way to get rate-limited on
 * an owner-only convenience.
 */
async function buildAllInvitesView(client) {
  const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];
  for (const guild of guilds) {
    const invite = await createGuildInvite(guild, {
      maxAge: 7 * 24 * 3600,
      maxUses: 0,
      reason: 'Bot owner requested access to every server',
    });

    const mark = isGuildWhitelisted(guild.id) ? '✅' : '⛔';
    lines.push(
      `${mark} **${guild.name}** · \`${guild.id}\`\n` +
        `└ ${invite ? invite.url : '_no invite — the bot lacks Create Invite there_'}`
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔗 Invites — ${guilds.length} server(s)`)
    .setColor(0x5865f2)
    .setDescription(capToFieldLimit(lines, '_The bot is not in any servers._', DESCRIPTION_LIMIT))
    .setFooter({ text: 'All links last 7 days. ✅ approved · ⛔ not approved' })
    .setTimestamp();

  return { content: '', embeds: [embed], components: [backRow()] };
}

/** One server: what it is, and what can be done about it. */
function buildGuildView(client, guildId) {
  const guild = client.guilds.cache.get(guildId);

  if (!guild) {
    return {
      content: '',
      embeds: [
        new EmbedBuilder()
          .setTitle('❔ Not found')
          .setColor(0xc98500)
          .setDescription(`The bot is no longer in \`${guildId}\`.`),
      ],
      components: [backRow()],
    };
  }

  const whitelisted = isGuildWhitelisted(guildId);
  const enforcing = countWhitelistedGuilds() > 0;

  const embed = new EmbedBuilder()
    .setTitle(`🖥️ ${guild.name}`)
    .setColor(0x5865f2)
    .setDescription(
      [
        `🆔 \`${guild.id}\``,
        `👥 **Members:** ${(guild.memberCount ?? 0).toLocaleString()}`,
        `📅 **Bot joined:** ${guild.joinedTimestamp ? `<t:${Math.floor(guild.joinedTimestamp / 1000)}:R>` : 'unknown'}`,
        `🔐 **Access:** ${!enforcing ? '⚪ allowed (whitelist empty)' : whitelisted ? '✅ whitelisted' : '⛔ blocked'}`,
      ].join('\n')
    )
    .setTimestamp();

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL());

  const row = new ActionRowBuilder().addComponents(
    button(`invite:${guildId}`, 'Get invite', ButtonStyle.Primary, '🔗'),
    button(
      `wl:${guildId}`,
      whitelisted ? 'Un-whitelist' : 'Whitelist',
      whitelisted ? ButtonStyle.Secondary : ButtonStyle.Success,
      whitelisted ? '⛔' : '✅'
    ),
    button(`leaveask:${guildId}`, 'Remove bot', ButtonStyle.Danger, '🚪'),
    button('servers', 'Back', ButtonStyle.Secondary, '◀️')
  );

  return { content: '', embeds: [embed], components: [row] };
}

/**
 * Create a one-use invite so the owner can look at a server themselves.
 *
 * The bot can only do this where it holds Create Instant Invite, which is not
 * guaranteed — plenty of servers add a bot with minimal permissions. The
 * failure is reported plainly rather than silently returning nothing.
 */
async function buildInviteView(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();
  const back = new ActionRowBuilder().addComponents(
    button(`guild:${guildId}`, 'Back', ButtonStyle.Secondary, '◀️')
  );

  if (!guild) {
    embed.setTitle('❔ Not found').setDescription(`The bot is no longer in \`${guildId}\`.`);
    return { content: '', embeds: [embed], components: [back] };
  }

  const me = guild.members.me;
  const channel = guild.channels.cache.find(
    (c) => c.isTextBased?.() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite)
  );

  if (!channel) {
    embed
      .setTitle('🔗 No invite possible')
      .setColor(0xc98500)
      .setDescription(
        `The bot has no channel in **${guild.name}** where it is allowed to create an invite.\n\n` +
          '_It needs the **Create Invite** permission somewhere in that server. ' +
          'Without it, only a member of that server can invite you._'
      );
    return { content: '', embeds: [embed], components: [back] };
  }

  try {
    // Short-lived and single-use: this is for the owner to look in, not a link
    // to hand around, and a stale permanent invite is a small liability.
    const invite = await channel.createInvite({
      maxAge: 3600,
      maxUses: 1,
      unique: true,
      reason: 'Bot owner requested access via /ownermenu',
    });

    embed
      .setTitle(`🔗 Invite to ${guild.name}`)
      .setDescription(
        `https://discord.gg/${invite.code}\n\n` +
          '⏱️ Expires in **1 hour**, usable **once**.\n' +
          `_Created in #${channel.name}. Joining is visible to that server like any other member._`
      );
  } catch (err) {
    embed
      .setTitle('❌ Invite failed')
      .setColor(0xed4245)
      .setDescription(`Could not create an invite for **${guild.name}**: ${err.message}`);
  }

  return { content: '', embeds: [embed], components: [back] };
}

function buildLeaveConfirmView(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  const name = guild?.name ?? guildId;

  const embed = new EmbedBuilder()
    .setTitle('🚪 Remove the bot?')
    .setColor(0xed4245)
    .setDescription(
      `This makes the bot leave **${name}** (\`${guildId}\`) immediately.\n\n` +
        '**This cannot be undone from here.** Only an admin of that server can invite it back — ' +
        'you cannot rejoin it on the bot\'s behalf.\n\n' +
        '_Any tracking configured there stops. If you only want to block the server ' +
        'while staying in it, un-whitelist it instead._'
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    button(`leavego:${guildId}`, 'Yes, leave', ButtonStyle.Danger, '🚪'),
    button(`guild:${guildId}`, 'Cancel', ButtonStyle.Secondary, '✖️')
  );

  return { content: '', embeds: [embed], components: [row] };
}

function buildWhitelistView(client) {
  const rows = getWhitelistedGuilds();

  const lines = rows.map((r) => {
    const name = client.guilds.cache.get(r.guild_id)?.name;
    return (
      `• \`${r.guild_id}\`${name ? ` — **${name}**` : ' — _bot not in this server_'}` +
      (r.note ? ` · ${r.note}` : '') +
      ` · added <t:${r.added_at}:R>`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle(`✅ Whitelist (${rows.length})`)
    .setColor(rows.length === 0 ? 0xc98500 : 0x57f287)
    .setDescription(
      rows.length === 0
        ? '**Empty — every server is currently allowed.**\n\n' +
            'Adding the first server switches enforcement on, and everything not listed ' +
            'is blocked from that moment.'
        : capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT)
    )
    .setTimestamp();

  const controls = new ActionRowBuilder().addComponents(
    button('whitelist_add', 'Add server', ButtonStyle.Success, '➕'),
    button('whitelist_remove', 'Remove server', ButtonStyle.Danger, '➖'),
    button('home', 'Back', ButtonStyle.Secondary, '◀️')
  );

  return { content: '', embeds: [embed], components: [controls] };
}

function buildLogsView(client, summary) {
  const logging = isCommandLoggingEnabled();

  // Always across ALL servers — this is a global monitor, not a per-server one.
  const embed = new EmbedBuilder()
    .setColor(0x3987e5)
    .setTimestamp()
    .setFooter({
      text: logging ? 'Logging is running across every server.' : '⚠️ Logging is stopped — nothing new is being recorded.',
    });

  if (summary) {
    const rows = getCommandLogSummary(25);
    const lines = rows.map((r) => {
      const name = r.guild_name ?? client.guilds.cache.get(r.guild_id)?.name ?? 'unknown';
      return `• **${name}** · ${r.uses.toLocaleString()} uses · last <t:${r.last_used}:R>`;
    });
    embed
      .setTitle('📊 Usage by server')
      .setDescription(capToFieldLimit(lines, '_Nothing recorded yet._', DESCRIPTION_LIMIT));
  } else {
    const rows = getCommandLog({ limit: 20 });
    const lines = rows.map((r) => {
      const where = r.guild_name ?? r.guild_id ?? 'DM';
      const failed = r.outcome !== 'ok' ? ` ❌ ${r.outcome}` : '';
      return (
        `<t:${r.ts}:t> **/${r.command}**${r.options ? ` ${r.options}` : ''}${failed}\n` +
        `└ 👤 ${r.username ?? r.user_id} · 🖥️ ${where}`
      );
    });
    embed
      .setTitle('📜 Command log — all servers')
      .setDescription(capToFieldLimit(lines, '_Nothing recorded yet._', DESCRIPTION_LIMIT));
  }

  const controls = new ActionRowBuilder().addComponents(
    button(summary ? 'logs' : 'logs_summary', summary ? 'Recent commands' : 'Per-server totals', ButtonStyle.Primary, summary ? '📜' : '📊'),
    button(
      'toggle_logging',
      logging ? 'Stop logging' : 'Start logging',
      logging ? ButtonStyle.Danger : ButtonStyle.Success,
      logging ? '⏹️' : '▶️'
    ),
    button('home', 'Back', ButtonStyle.Secondary, '◀️')
  );

  return { content: '', embeds: [embed], components: [controls] };
}

/* ---------------------------------------------------------------------------
 * Whitelist add/remove, via a modal
 * ------------------------------------------------------------------------- */

async function showGuildModal(interaction, mode) {
  const modal = new ModalBuilder()
    .setCustomId(`${COMPONENT_PREFIX}modal_${mode}`)
    .setTitle(mode === 'add' ? 'Whitelist a server' : 'Remove a server')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('guildId')
          .setLabel('Server ID')
          .setPlaceholder('e.g. 1517031232050036756')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

  if (mode === 'add') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Note (optional)')
          .setPlaceholder('who asked for it')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      )
    );
  }

  await interaction.showModal(modal);
}

async function handleGuildModal(interaction) {
  const mode = interaction.customId.endsWith('_add') ? 'add' : 'remove';
  const guildId = interaction.fields.getTextInputValue('guildId').trim();

  if (!/^\d{15,25}$/.test(guildId)) {
    await interaction.reply({
      content:
        `❌ \`${guildId}\` doesn't look like a server ID — those are all digits.\n` +
        '_Enable Developer Mode, then right-click the server → Copy Server ID._',
      ephemeral: true,
    });
    return;
  }

  if (mode === 'add') {
    const wasEmpty = countWhitelistedGuilds() === 0;
    const note = interaction.fields.fields.has('note')
      ? interaction.fields.getTextInputValue('note').trim() || null
      : null;

    addWhitelistedGuild({ guildId, note, addedBy: interaction.user.id });

    const name = interaction.client.guilds.cache.get(guildId)?.name;
    await interaction.reply({
      content:
        `✅ Whitelisted \`${guildId}\`${name ? ` (**${name}**)` : ''}.` +
        (name ? '' : '\n_The bot is not in that server yet — this applies when it joins._') +
        (wasEmpty
          ? '\n\n⚠️ **Enforcement is now active.** That was the first entry, so every other server is blocked.'
          : ''),
      ephemeral: true,
    });
    return;
  }

  const removed = removeWhitelistedGuild(guildId);
  const nowEmpty = countWhitelistedGuilds() === 0;
  await interaction.reply({
    content: removed
      ? `🛑 Removed \`${guildId}\`.` +
        (nowEmpty ? '\n\n⚠️ The whitelist is now empty, so **every server is allowed again**.' : '')
      : `\`${guildId}\` wasn't on the whitelist.`,
    ephemeral: true,
  });
}
