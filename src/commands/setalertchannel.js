import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setChannel, clearChannel } from '../lib/db.js';

const ALERT_LABELS = {
  exists: 'Hatch rate spike/drop',
  rap: 'RAP swing',
};

// One command for both alert types, same reasoning as /setratechannel.
export const data = new SlashCommandBuilder()
  .setName('setalertchannel')
  .setDescription('Choose where pet alerts post.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('type')
      .setDescription('Which alert type')
      .setRequired(true)
      .addChoices(
        { name: 'Hatch rate spikes & drops', value: 'exists' },
        { name: 'RAP swings', value: 'rap' }
      )
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to post in. Omit to turn this alert off.')
      .addChannelTypes(ChannelType.GuildText)
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const type = interaction.options.getString('type', true);
  const channel = interaction.options.getChannel('channel');
  const label = ALERT_LABELS[type];

  if (!channel) {
    clearChannel(interaction.guildId, type);
    await interaction.editReply(`✅ Turned off **${label}** alerts.`);
    return;
  }

  setChannel(interaction.guildId, type, channel.id);

  const detail =
    type === 'exists'
      ? 'Checked once an hour: fires when a Titanic/Gargantuan pet hatches at 2x or more, or half or less, of its previous hour. Needs ~2 hours of history first.'
      : "Checked once an hour: fires when a Titanic/Gargantuan pet's RAP triples or falls to a third within 24 hours.";

  await interaction.editReply(`✅ **${label}** alerts will post in ${channel}.\n_${detail}_`);
}
