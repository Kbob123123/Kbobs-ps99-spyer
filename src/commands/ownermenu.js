import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {
  addWhitelistedGuild,
  removeWhitelistedGuild,
  getWhitelistedGuilds,
  countWhitelistedGuilds,
  isGuildWhitelisted,
  getCommandLog,
  getCommandLogSummary,
} from '../lib/db.js';
import { isOwner, OWNER_ID } from '../lib/owner.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/format.js';

// Owner-only console: which servers have the bot, who may use it, and what
// they have been doing.
//
// Deliberately has NO setDefaultMemberPermissions. That gate is per-guild and
// any server admin satisfies it, which is the opposite of what is wanted here
// — this is restricted to one specific user, checked at runtime instead.
export const data = new SlashCommandBuilder()
  .setName('ownermenu')
  .setDescription('Bot owner console: servers, whitelist, and command log.')
  .addSubcommand((sub) =>
    sub.setName('servers').setDescription('Every server this bot is in, with whitelist status.')
  )
  .addSubcommand((sub) =>
    sub
      .setName('whitelist')
      .setDescription('Allow or block a server by its guild ID.')
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('What to do')
          .setRequired(true)
          .addChoices(
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'list', value: 'list' }
          )
      )
      .addStringOption((opt) => opt.setName('guild').setDescription('Guild ID (required for add/remove)'))
      .addStringOption((opt) => opt.setName('note').setDescription('Optional label, e.g. who asked for it'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('log')
      .setDescription('Recent command activity across servers.')
      .addStringOption((opt) => opt.setName('guild').setDescription('Only show this guild ID'))
      .addBooleanOption((opt) =>
        opt.setName('summary').setDescription('Show per-server totals instead of individual commands')
      )
      .addIntegerOption((opt) =>
        opt.setName('limit').setDescription('How many entries (default 20, max 50)').setMinValue(1).setMaxValue(50)
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  if (!isOwner(interaction.user.id)) {
    // Say nothing about what the command does. Also states the configured
    // owner id, because the most likely reason the real owner sees this is a
    // mistyped OWNER_ID rather than an actual intruder.
    await interaction.editReply(
      '🔒 This command is restricted to the bot owner.\n' +
        `_Configured owner ID: \`${OWNER_ID}\`. Your ID: \`${interaction.user.id}\`._`
    );
    return;
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'servers') return showServers(interaction);
  if (sub === 'whitelist') return manageWhitelist(interaction);
  return showLog(interaction);
}

async function showServers(interaction) {
  // Guilds the bot is actually in, straight from the gateway cache.
  const guilds = [...interaction.client.guilds.cache.values()].sort(
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
      text: enforcing
        ? '✅ whitelisted · ⛔ blocked. Change with /ownermenu whitelist.'
        : '⚪ Whitelist is empty, so every server is allowed. Add one to start enforcing.',
    })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function manageWhitelist(interaction) {
  const action = interaction.options.getString('action', true);
  const guildId = interaction.options.getString('guild')?.trim();
  const note = interaction.options.getString('note')?.trim();

  if (action === 'list') {
    const rows = getWhitelistedGuilds();
    if (rows.length === 0) {
      await interaction.editReply(
        'The whitelist is empty, so **every server is currently allowed**.\n' +
          'Add one guild to switch enforcement on — everything not listed is blocked from that moment.'
      );
      return;
    }

    const lines = rows.map((r) => {
      const name = interaction.client.guilds.cache.get(r.guild_id)?.name;
      return (
        `• \`${r.guild_id}\`${name ? ` — **${name}**` : ' — _bot not in this server_'}` +
        (r.note ? ` · ${r.note}` : '') +
        ` · added <t:${r.added_at}:R>`
      );
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ Whitelisted servers (${rows.length})`)
          .setColor(0x57f287)
          .setDescription(capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT))
          .setFooter({ text: 'Everything not listed here is blocked.' })
          .setTimestamp(),
      ],
    });
    return;
  }

  if (!guildId) {
    await interaction.editReply(`❌ \`guild:\` is required to ${action} a server.`);
    return;
  }

  if (!/^\d{15,25}$/.test(guildId)) {
    await interaction.editReply(
      `❌ \`${guildId}\` doesn't look like a guild ID — those are all digits.\n` +
        '_Enable Developer Mode in Discord, then right-click the server → Copy Server ID._'
    );
    return;
  }

  if (action === 'add') {
    const wasEmpty = countWhitelistedGuilds() === 0;
    addWhitelistedGuild({ guildId, note, addedBy: interaction.user.id });

    const name = interaction.client.guilds.cache.get(guildId)?.name;
    await interaction.editReply(
      `✅ Whitelisted \`${guildId}\`${name ? ` (**${name}**)` : ''}.` +
        (name ? '' : '\n_The bot is not in that server yet — this will apply when it joins._') +
        (wasEmpty
          ? '\n\n⚠️ **Enforcement is now active.** That was the first entry, so every other server is blocked from now on.'
          : '')
    );
    return;
  }

  const removed = removeWhitelistedGuild(guildId);
  const nowEmpty = countWhitelistedGuilds() === 0;
  await interaction.editReply(
    removed
      ? `🛑 Removed \`${guildId}\` from the whitelist.` +
          (nowEmpty
            ? '\n\n⚠️ The whitelist is now empty, so **every server is allowed again**.'
            : '')
      : `\`${guildId}\` wasn't on the whitelist.`
  );
}

async function showLog(interaction) {
  const guildId = interaction.options.getString('guild')?.trim() || null;
  const summary = interaction.options.getBoolean('summary') ?? false;
  const limit = interaction.options.getInteger('limit') ?? 20;

  if (summary) {
    const rows = getCommandLogSummary(limit);
    const lines = rows.map((r) => {
      const name = r.guild_name ?? interaction.client.guilds.cache.get(r.guild_id)?.name ?? 'unknown';
      return `• **${name}** \`${r.guild_id ?? 'DM'}\` · ${r.uses.toLocaleString()} uses · last <t:${r.last_used}:R>`;
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 Usage by server')
          .setColor(0x3987e5)
          .setDescription(capToFieldLimit(lines, '_Nothing logged yet._', DESCRIPTION_LIMIT))
          .setTimestamp(),
      ],
    });
    return;
  }

  const rows = getCommandLog({ guildId, limit });
  const lines = rows.map((r) => {
    const where = r.guild_name ?? r.guild_id ?? 'DM';
    const failed = r.outcome !== 'ok' ? ` ❌ ${r.outcome}` : '';
    return `<t:${r.ts}:t> **/${r.command}**${r.options ? ` ${r.options}` : ''}\n└ ${r.username ?? r.user_id} in _${where}_${failed}`;
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(guildId ? `📜 Command log — ${guildId}` : '📜 Command log')
        .setColor(0x3987e5)
        .setDescription(capToFieldLimit(lines, '_Nothing logged yet._', DESCRIPTION_LIMIT))
        .setFooter({ text: 'Newest first. Use summary:true for per-server totals.' })
        .setTimestamp(),
    ],
  });
}
