import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import {
  addBotUpdateChannel,
  removeBotUpdateChannel,
  getBotUpdateChannelsForGuild,
} from '../lib/db.js';
import { RUNNING_VERSION } from '../lib/botUpdates.js';

export const data = new SlashCommandBuilder()
  .setName('botupdchannel')
  .setDescription("Choose where the bot posts its own update notes.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel for update notes. Omit to turn announcements off.')
      .addChannelTypes(ChannelType.GuildText)
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.options.getChannel('channel');

  // No channel given: turn it off. Which channel to remove is ambiguous once a
  // server has registered more than one, so this clears every one of them and
  // says how many — quieter to be explicit than to guess.
  if (!channel) {
    const existing = getBotUpdateChannelsForGuild(interaction.guildId);
    if (existing.length === 0) {
      await interaction.editReply('ℹ️ Update announcements were not switched on here.');
      return;
    }

    let removed = 0;
    for (const row of existing) {
      if (removeBotUpdateChannel(row.channel_id)) removed += 1;
    }
    await interaction.editReply(`✅ Turned off update announcements (${removed} channel(s) cleared).`);
    return;
  }

  addBotUpdateChannel({
    channelId: channel.id,
    guildId: interaction.guildId,
    addedBy: interaction.user.id,
  });

  // Saying "nothing retroactive" up front matters. Registering a changelog
  // channel and watching it stay empty reads as broken otherwise, when it is
  // the feature working exactly as designed.
  await interaction.editReply(
    `✅ Update notes will post in ${channel}.\n` +
      `_Currently running **v${RUNNING_VERSION ?? '?'}**. Past releases are not re-posted — ` +
      `the next new version is this channel's first announcement._`
  );
}
