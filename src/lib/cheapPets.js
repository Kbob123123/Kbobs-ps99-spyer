import { EmbedBuilder } from 'discord.js';
import { getAllRap, getAllExists } from './ps99Api.js';
import { getTierMap, TIER_META } from './pets.js';
import { collectTieredPets } from './tracker.js';
import { resolveThumbnail } from './thumbnails.js';
import { getPetDetail } from './pets.js';
import { capToFieldLimit, formatNumber, formatCompact, displayName, DESCRIPTION_LIMIT } from './format.js';

/**
 * The cheapest pets in one tier, optionally filtered to a variant.
 *
 * Everything this needs is already in hand: getAllRap() and getAllExists() are
 * polled every ten minutes and served from the API client's cache, and
 * collectTieredPets() already does the grouping. This is a filter and a sort
 * over data we hold, not new fetching.
 */

// The exact strings describeVariant() produces. Verified against live RAP data
// rather than assumed — all six appear, and nothing else does.
export const VARIANTS = ['Normal', 'Golden', 'Rainbow', 'Shiny', 'Golden Shiny', 'Rainbow Shiny'];

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 25;

/**
 * THE trap in this whole feature: a large share of entries have RAP 0.
 *
 * Measured live: 197 of 4,440 huge variants, 106 of 915 titanic, and 29 of 102
 * gargantuan — over a quarter of the gargantuan tier. A RAP of 0 does not mean
 * "free", it means untraded or unpriced. Sorting ascending without dropping
 * them returns a page of worthless rows and hides every real answer, which for
 * gargantuan is most of the list.
 */
function isPriced(entry) {
  return Number(entry.value) > 0;
}

/**
 * Build the reply for one tier.
 *
 * @param {'huge'|'titanic'|'gargantuan'} tier
 * @param {string|null} variant  one of VARIANTS, or null for every variant
 * @param {number} limit
 */
export async function buildCheapEmbed(tier, variant, limit = DEFAULT_LIMIT) {
  const capped = Math.min(Math.max(1, limit), MAX_LIMIT);
  const meta = TIER_META[tier];

  const [rapRaw, existsRaw, tierMap] = await Promise.all([getAllRap(), getAllExists(), getTierMap()]);

  const rapEntries = collectTieredPets(rapRaw, tierMap);
  const existsEntries = collectTieredPets(existsRaw, tierMap);

  const inTier = [...rapEntries.values()].filter((e) => e.tier === tier);
  const priced = inTier.filter(isPriced);
  const matching = variant ? priced.filter((e) => e.variant === variant) : priced;

  if (matching.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`${meta.emoji} Cheapest ${meta.label}s`)
      .setColor(meta.color)
      .setDescription(
        variant
          ? `No **${variant}** ${meta.label.toLowerCase()} has a recorded RAP right now.`
          : `No ${meta.label.toLowerCase()} has a recorded RAP right now.`
      );
    return { embed };
  }

  const cheapest = [...matching].sort((a, b) => a.value - b.value).slice(0, capped);

  const lines = cheapest.map((entry, i) => {
    const exists = existsEntries.get(entry.petKey)?.value;
    const existsText = exists != null ? ` · 🥚 ${formatNumber(exists)} exist` : '';
    return (
      `\`#${String(i + 1).padStart(2, ' ')}\` **${displayName(entry.name, entry.variant)}**\n` +
      `└ 💰 ${formatNumber(entry.value)}${existsText}`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} Cheapest ${meta.label}s${variant ? ` — ${variant}` : ''}`)
    .setColor(meta.color)
    .setDescription(capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT))
    .setTimestamp();

  // A summary row for the cheapest entry, matching /rap. Fifteen lines of
  // near-identical formatting need something to anchor on, and the whole
  // point of the command is the top row.
  const cheapestExists = existsEntries.get(cheapest[0].petKey)?.value;
  embed.addFields(
    { name: 'Cheapest', value: `**${displayName(cheapest[0].name, cheapest[0].variant)}**`, inline: true },
    { name: 'RAP', value: `**${formatNumber(cheapest[0].value)}**`, inline: true },
    {
      name: 'In existence',
      value: cheapestExists != null ? `**${formatNumber(cheapestExists)}**` : '—',
      inline: true,
    }
  );

  // Say plainly what was excluded and why. A reader comparing this against the
  // in-game list will otherwise wonder where the zero-RAP entries went.
  const unpriced = inTier.length - priced.length;
  embed.setFooter({
    text:
      `${matching.length.toLocaleString()} priced ${meta.label.toLowerCase()}` +
      `${variant ? ` (${variant})` : ''} variant(s)` +
      (unpriced > 0 ? ` · ${unpriced.toLocaleString()} with no RAP excluded` : '') +
      ' · RAP refreshes every 10 minutes',
  });

  // The cheapest one's art, as the thumbnail. Decoration, so a failure is
  // swallowed rather than costing the reply.
  const art = await getPetDetail(cheapest[0].name)
    .then((d) => (/golden/i.test(cheapest[0].variant) ? d?.goldenThumbnail ?? d?.thumbnail : d?.thumbnail))
    .then((asset) => resolveThumbnail(asset))
    .catch(() => null);
  if (art) embed.setThumbnail(art);

  return { embed };
}

/**
 * The shared slash-command body for the three /cheap* commands.
 *
 * Three commands rather than one with a tier option: the tiers are what people
 * actually think in, and "/cheapgargs" is one action where "/cheap tier:garg"
 * is two. They share everything below so the three stay identical in
 * behaviour.
 */
export function addCheapOptions(builder) {
  return builder
    .addStringOption((opt) =>
      opt
        .setName('variant')
        .setDescription('Only show this variant (default: all)')
        .addChoices(...VARIANTS.map((v) => ({ name: v, value: v })))
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription(`How many to list (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`)
        .setMinValue(1)
        .setMaxValue(MAX_LIMIT)
    );
}

/** The shared execute body for the three /cheap* commands. */
export async function runCheapCommand(interaction, tier) {
  await interaction.deferReply();

  const variant = interaction.options.getString('variant');
  const limit = interaction.options.getInteger('limit') ?? DEFAULT_LIMIT;

  try {
    const { embed } = await buildCheapEmbed(tier, variant, limit);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.warn(`[cheap] ${tier} lookup failed:`, err.message);
    await interaction.editReply(
      "❌ Couldn't reach the PS99 API just now. Try again in a moment."
    );
  }
}
