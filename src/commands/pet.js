import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getAllRap, getAllExists, describeVariant, variantKey, resolvePetName } from '../lib/ps99Api.js';
import { getAllPetNames, getPetDetail, TIER_META } from '../lib/pets.js';
import { getSeries } from '../lib/db.js';
import { renderHistoryChart, TIER_COLORS } from '../lib/graph.js';
import { resolveThumbnail } from '../lib/thumbnails.js';
import { formatNumber, displayName } from '../lib/format.js';

const CHART_WINDOW_SECONDS = 7 * 24 * 3600;

export const data = new SlashCommandBuilder()
  .setName('pet')
  .setDescription('Look up one pet: exists, RAP, tier, and history charts.')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Pet name (partial is fine)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('name', true).trim();
  if (rawQuery.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const names = await getAllPetNames();
  const resolved = resolvePetName(names, rawQuery);

  if (!resolved) {
    await interaction.editReply(`❌ No pet found matching **${rawQuery}**.`);
    return;
  }

  const [detail, rap, exists] = await Promise.all([getPetDetail(resolved), getAllRap(), getAllExists()]);

  // Gather every variant of this pet (Normal / Golden / Rainbow / Shiny).
  const variants = new Map();
  const addTo = (entry, field) => {
    if (entry.configData?.id !== resolved) return;
    const key = variantKey(entry);
    if (!variants.has(key)) {
      variants.set(key, { key, variant: describeVariant(entry.configData ?? {}), exists: null, rap: null });
    }
    const v = variants.get(key);
    v[field] = (v[field] ?? 0) + (Number(entry.value) || 0);
  };
  for (const e of exists) addTo(e, 'exists');
  for (const e of rap) addTo(e, 'rap');

  const tierMeta = detail?.tier ? TIER_META[detail.tier] : null;

  const embed = new EmbedBuilder()
    .setTitle(`${tierMeta ? tierMeta.emoji + ' ' : ''}${resolved}`)
    .setColor(detail?.tier ? parseInt(TIER_COLORS[detail.tier].slice(1), 16) : 0x3987e5)
    .setTimestamp();

  const headerLines = [];
  if (tierMeta) headerLines.push(`**Tier:** ${tierMeta.label}`);
  if (detail?.rarity != null) headerLines.push(`**Rarity:** ${detail.rarity}`);
  if (detail?.obtainable === false) headerLines.push('**Obtainable:** No (unobtainable)');
  if (detail?.description) headerLines.push(`_${detail.description}_`);
  if (headerLines.length > 0) embed.setDescription(headerLines.join('\n'));

  const ordered = [...variants.values()].sort((a, b) => (b.exists ?? 0) - (a.exists ?? 0));
  if (ordered.length > 0) {
    embed.addFields({
      name: 'Variants',
      value: ordered
        .map((v) => {
          const bits = [`**${v.variant}**`];
          bits.push(v.exists != null ? `${formatNumber(v.exists)} exist` : 'exists N/A');
          bits.push(v.rap != null ? `💎 ${formatNumber(v.rap)}` : 'RAP N/A');
          return bits.join(' · ');
        })
        .join('\n'),
      inline: false,
    });
  }

  // Thumbnail: prefer the golden art when the top variant is a golden one.
  const thumbUrl = await resolveThumbnail(
    ordered[0]?.variant?.includes('Golden') ? detail?.goldenThumbnail : detail?.thumbnail
  );
  if (thumbUrl) embed.setThumbnail(thumbUrl);

  // Charts track the Normal variant — it's the one people mean by default, and
  // plotting every variant on one pair of axes would mix wildly different scales.
  const normal = ordered.find((v) => v.variant === 'Normal') ?? ordered[0];
  const files = [];

  if (normal) {
    const label = displayName(resolved, normal.variant);
    const existsSeries = getSeries('exists', normal.key, CHART_WINDOW_SECONDS);
    const rapSeries = getSeries('rap', normal.key, CHART_WINDOW_SECONDS);

    const [existsChart, rapChart] = await Promise.all([
      renderHistoryChart(label, 'exists', existsSeries).catch(() => null),
      renderHistoryChart(label, 'rap', rapSeries).catch(() => null),
    ]);

    if (existsChart) {
      files.push(new AttachmentBuilder(existsChart, { name: 'exists.png' }));
      embed.setImage('attachment://exists.png');
    }
    if (rapChart) {
      files.push(new AttachmentBuilder(rapChart, { name: 'rap.png' }));
    }

    if (!existsChart && !rapChart) {
      embed.setFooter({
        text: 'Not enough history for charts yet — they fill in as the tracker records readings.',
      });
    }
  }

  // Exists and RAP go in two embeds rather than one, because they are different
  // measures on different scales and must never share a pair of axes.
  const embeds = [embed];
  if (files.length > 1) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0x199e70)
        .setImage('attachment://rap.png')
        .setFooter({ text: 'RAP history · charts cover the last 7 days' })
    );
  }

  await interaction.editReply({ embeds, files });
}
