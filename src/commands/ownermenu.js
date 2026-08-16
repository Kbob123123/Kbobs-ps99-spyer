import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

  if (interaction.isModalSubmit()) return handleGuildModal(interaction);

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

  const embed = new EmbedBuilder()
    .setTitle('🔐 Owner console')
    .setColor(0x5865f2)
    .setDescription(
      [
        `🖥️ **Servers:** ${guilds.size}`,
        `✅ **Whitelist:** ${whitelisted === 0 ? '_empty — every server allowed_' : `${whitelisted} allowed, everything else blocked`}`,
        `📜 **Command logging:** ${logging ? '🟢 running' : '🔴 stopped'}`,
        `📊 **Commands recorded:** ${totalLogged.toLocaleString()}`,
      ].join('\n')
    )
    .setFooter({ text: 'Logging covers every server the bot is in.' })
    .setTimestamp();

  const rows = [
    new ActionRowBuilder().addComponents(
      button('servers', 'Servers', ButtonStyle.Primary, '🖥️'),
      button('whitelist', 'Whitelist', ButtonStyle.Primary, '✅'),
      button('logs', 'Logs', ButtonStyle.Primary, '📜')
    ),
    new ActionRowBuilder().addComponents(
      button(
        'toggle_logging',
        logging ? 'Stop logging' : 'Start logging',
        logging ? ButtonStyle.Danger : ButtonStyle.Success,
        logging ? '⏹️' : '▶️'
      )
    ),
  ];

  return { content: '', embeds: [embed], components: rows };
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
      text: enforcing ? '✅ allowed · ⛔ blocked' : '⚪ Whitelist empty — every server is allowed.',
    })
    .setTimestamp();

  return { content: '', embeds: [embed], components: [backRow()] };
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
