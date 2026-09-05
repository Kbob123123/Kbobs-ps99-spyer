import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { nextUpdateUnix } from '../lib/updateTimer.js';

export const data = new SlashCommandBuilder()
  .setName('nextupdate')
  .setDescription("Countdown to PS99's next expected weekly update.");

export async function execute(interaction) {
  const ts = nextUpdateUnix();

  const embed = new EmbedBuilder()
    .setTitle('🚀 Next update')
    .setColor(0x3987e5)
    .setDescription(
      `Due <t:${ts}:R> (<t:${ts}:F>).\n\n` +
        '_PS99 updates on no published schedule — this is a fixed weekly target ' +
        '(Sunday 2am AEST), not a guarantee. Updates can land early, late, or skip a week._'
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
