import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllRap, getAllExists, describeVariant, variantKey } from '../lib/ps99Api.js';
import { getTierMap, getPetDetail } from '../lib/pets.js';
import { resolveThumbnail } from '../lib/thumbnails.js';
import { formatNumber, displayName } from '../lib/format.js';

const MAX_RESULTS = 15;

export const data = new SlashCommandBuilder()
  .setName('rap')
  .setDescription('Look up the Recent Average Price of an item or pet. Partial names work.')
  .addStringOption((opt) =>
    opt.setName('item').setDescription('Item or pet name (partial is fine)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('item', true).trim().toLowerCase();
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const [rap, exists, tierMap] = await Promise.all([getAllRap(), getAllExists(), getTierMap()]);

  // Index exists by variant key so each RAP row can show its scarcity next to
  // its price — the two numbers are far more useful together than apart.
  const existsByKey = new Map();
  for (const e of exists) {
    existsByKey.set(variantKey(e), (existsByKey.get(variantKey(e)) ?? 0) + (Number(e.value) || 0));
  }

  const matches = [];
  for (const entry of rap) {
    const name = entry.configData?.id;
    if (!name || !name.toLowerCase().includes(query)) continue;
    matches.push({
      name,
      variant: describeVariant(entry.configData ?? {}),
      category: entry.category,
      tier: tierMap.get(name) ?? null,
      value: Number(entry.value) || 0,
      exists: existsByKey.get(variantKey(entry)) ?? null,
    });
  }

  if (matches.length === 0) {
    await interaction.editReply(`❌ Nothing matching **${interaction.options.getString('item', true)}** has a RAP value.`);
    return;
  }

  matches.sort((a, b) => b.value - a.value);
  const shown = matches.slice(0, MAX_RESULTS);

  const lines = shown.map((m) => {
    const parts = [`**${displayName(m.name, m.variant)}** — 💎 ${formatNumber(m.value)}`];
    if (m.exists != null) parts.push(`· ${formatNumber(m.exists)} exist`);
    return parts.join(' ');
  });

  const embed = new EmbedBuilder()
    .setTitle(`RAP — "${interaction.options.getString('item', true)}"`)
    .setColor(0x199e70)
    .setDescription(lines.join('\n'))
    .setTimestamp()
    .setFooter({
      text:
        matches.length > MAX_RESULTS
          ? `Showing the ${MAX_RESULTS} highest-value of ${matches.length} matches — try a more specific name.`
          : `${matches.length} match${matches.length === 1 ? '' : 'es'}`,
    });

  // Art and a summary row for the most valuable match. The command already
  // knows which that is, so this costs one cached thumbnail lookup and gives
  // a list of near-identical lines something to anchor on.
  const top = shown[0];
  if (top) {
    embed.addFields(
      { name: '🏆 Top match', value: `**${displayName(top.name, top.variant)}**`, inline: true },
      { name: '💰 RAP', value: `**${formatNumber(top.value)}**`, inline: true },
      {
        name: '🥚 In existence',
        value: top.exists != null ? `**${formatNumber(top.exists)}**` : '—',
        inline: true,
      }
    );

    // Golden art when the top match is a golden variant — showing the normal
    // skin for a golden lookup is a small lie the picture tells louder than
    // the text does.
    const detail = await getPetDetail(top.name).catch(() => null);
    const art = await resolveThumbnail(
      /golden/i.test(top.variant) ? (detail?.goldenThumbnail ?? detail?.thumbnail) : detail?.thumbnail
    ).catch(() => null);
    if (art) embed.setThumbnail(art);
  }

  await interaction.editReply({ embeds: [embed] });
}
