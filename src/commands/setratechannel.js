import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setChannel, clearChannel } from '../lib/db.js';
import { TIER_META } from '../lib/pets.js';

// One command covers all three tiers via an option, rather than three separate
// /sethuge /settitanic /setgargantuan commands.
export const data = new SlashCommandBuilder()
  .setName('setratechannel')
  .setDescription('Choose where hourly hatch-rate updates post for a pet tier.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('tier')
      .setDescription('Which pet tier')
      .setRequired(true)
      .addChoices(
        { name: 'Huge', value: 'huge' },
        { name: 'Titanic', value: 'titanic' },
        { name: 'Gargantuan', value: 'gargantuan' }
      )
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to post in. Omit to turn this tier off.')
      .addChannelTypes(ChannelType.GuildText)
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const tier = interaction.options.getString('tier', true);
  const channel = interaction.options.getChannel('channel');
  const label = TIER_META[tier].label;

  if (!channel) {
    clearChannel(interaction.guildId, tier);
    await interaction.editReply(`✅ Turned off **${label}** hatch-rate updates.`);
    return;
  }

  setChannel(interaction.guildId, tier, channel.id);
  await interaction.editReply(
    `✅ **${label}** hatch rates will post in ${channel}, updating the same message every 10 minutes.\n` +
      `_The first post appears once a full hour of readings exists._`
  );
}
