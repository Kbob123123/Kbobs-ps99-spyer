import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setChannel, clearChannel } from '../lib/db.js';

const ALERT_LABELS = {
  exists: 'Hatch rate spike/drop',
  rap: 'RAP swing',
  store: 'Shop leak',
};

/**
 * What each alert actually does, shown back on confirmation.
 *
 * A map rather than a ternary. This was `type === 'exists' ? a : b`, so adding
 * a third type silently gave shop leaks the RAP description — the label said
 * "Shop leak" and the sentence underneath described pet prices. A lookup keyed
 * by type cannot drift that way: a missing entry shows nothing rather than
 * confidently showing the wrong thing.
 */
const ALERT_DETAILS = {
  exists:
    'Checked once an hour: fires when a Titanic/Gargantuan pet hatches at 2x or more, ' +
    'or half or less, of its previous hour. Needs ~2 hours of history first.',
  rap:
    "Checked once an hour: fires when a Titanic/Gargantuan pet's RAP triples or falls " +
    'to a third within 24 hours.',
  store:
    'Checked every 10 minutes: fires when a gamepass or developer product is added, ' +
    'renamed, or goes on sale in Pet Simulator 99. A placeholder name turning into a ' +
    'real one is flagged as a reveal.',
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
        { name: 'RAP swings', value: 'rap' },
        { name: 'Shop leaks (new gamepasses & products)', value: 'store' }
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

  await interaction.editReply(`✅ **${label}** alerts will post in ${channel}.\n_${ALERT_DETAILS[type]}_`);
}
