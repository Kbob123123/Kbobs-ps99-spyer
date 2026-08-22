import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { getGuildChannels, countRows } from '../lib/db.js';
import { TIER_META } from '../lib/pets.js';
import { formatNumber } from '../lib/format.js';

const KIND_LABELS = {
  huge: `${TIER_META.huge.emoji} Huge hatch rates`,
  titanic: `${TIER_META.titanic.emoji} Titanic hatch rates`,
  gargantuan: `${TIER_META.gargantuan.emoji} Gargantuan hatch rates`,
  exists: '⚡ Hatch rate spikes, drops & leaderboard payouts',
  rap: '💰 RAP swings & crashes',
  store: '🛒 Shop leaks (new gamepasses & products)',
  newpet: '✨ New pets & first hatches',
  game: '🚀 Game updates & restarts',
  economy: '💎 Diamond economy (daily)',
};

export const data = new SlashCommandBuilder()
  .setName('spyerconfig')
  .setDescription("Show this server's channel setup and how much history has been collected.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const configured = new Map(getGuildChannels(interaction.guildId).map((r) => [r.kind, r]));

  const lines = Object.entries(KIND_LABELS).map(([kind, label]) => {
    const row = configured.get(kind);
    return row ? `${label} → <#${row.channel_id}>` : `${label} → _not set_`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🔧 Spyer configuration')
    .setColor(0x3987e5)
    .setDescription(lines.join('\n'))
    .addFields({
      name: '📦 History collected',
      value:
        `${formatNumber(countRows('exists'))} exists readings · ` +
        `${formatNumber(countRows('rap'))} RAP readings\n` +
        '_Readings are stored only when a value changes, so this grows slowly by design._',
    })
    .setFooter({ text: 'Change with /setratechannel and /setalertchannel' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
