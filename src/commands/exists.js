import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllExists, getAllRap } from '../lib/ps99Api.js';
import { buildPetReply } from '../lib/petView.js';
import { formatNumber, formatCompact, capToFieldLimit } from '../lib/format.js';

/**
 * How many in existence — for ANYTHING, not just pets.
 *
 * /api/exists covers 26 categories and ~17,500 entries: eggs, potions,
 * enchants, charms, hoverboards, and a Currency category holding game-wide
 * totals. The old /pet could only ever answer for one of those, and this
 * replaces it.
 */

// Offered in the picker. The full list is 26 long, which is more than a choice
// list should carry, so these are the ones people actually look up; leaving
// the option unset searches everything anyway.
const CATEGORY_CHOICES = [
  { name: 'Pet', value: 'Pet' },
  { name: 'Egg', value: 'Egg' },
  { name: 'Enchant', value: 'Enchant' },
  { name: 'Potion', value: 'Potion' },
  { name: 'Charm', value: 'Charm' },
  { name: 'Hoverboard', value: 'Hoverboard' },
  { name: 'Currency', value: 'Currency' },
  { name: 'Booth', value: 'Booth' },
  { name: 'Card', value: 'Card' },
  { name: 'Misc', value: 'Misc' },
];

const CATEGORY_EMOJI = {
  Pet: '🐾',
  Egg: '🥚',
  Enchant: '✨',
  Potion: '🧪',
  Charm: '🍀',
  Hoverboard: '🛹',
  Currency: '💎',
};

export const data = new SlashCommandBuilder()
  .setName('exists')
  .setDescription('How many of any item exist: pets, eggs, potions, enchants, currency.')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Item name (partial is fine)').setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('category')
      .setDescription('Narrow the search to one category')
      .addChoices(...CATEGORY_CHOICES)
  );

/**
 * Resolve a query to one (category, id) pair.
 *
 * Exact match wins; otherwise the shortest partial, which is the
 * least-surprising choice — "cat" should find "Huge Cat", not
 * "Huge Cat Fish Deluxe".
 *
 * Pets win ties. The same id genuinely appears in several categories (there
 * is a Diamonds enchant, a Diamonds potion AND the Diamonds currency), and
 * without a deterministic preference the answer would depend on payload
 * order — the same query returning a different thing on different days.
 */
export function resolveItem(index, query, category = null) {
  const lower = query.toLowerCase();
  const pool = category ? index.filter((e) => e.category === category) : index;

  const exact = pool.filter((e) => e.id.toLowerCase() === lower);
  if (exact.length > 0) return pickPreferred(exact);

  const partial = pool.filter((e) => e.id.toLowerCase().includes(lower));
  if (partial.length === 0) return null;

  const shortest = Math.min(...partial.map((e) => e.id.length));
  return pickPreferred(partial.filter((e) => e.id.length === shortest));
}

function pickPreferred(matches) {
  return matches.find((m) => m.category === 'Pet') ?? matches[0];
}

/** Collapse the raw payload into one row per (category, id), summing values. */
export function buildIndex(existsRaw) {
  const map = new Map();

  for (const entry of existsRaw) {
    const id = entry.configData?.id;
    if (!entry.category || !id) continue;

    const key = `${entry.category}:${id}`;
    const existing = map.get(key);
    const value = Number(entry.value) || 0;

    if (existing) {
      existing.total += value;
      existing.rows += 1;
    } else {
      map.set(key, { category: entry.category, id: String(id), total: value, rows: 1 });
    }
  }

  return [...map.values()];
}

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('name', true).trim();
  const category = interaction.options.getString('category');

  if (rawQuery.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const existsRaw = await getAllExists();
  const index = buildIndex(existsRaw);
  const match = resolveItem(index, rawQuery, category);

  if (!match) {
    await interaction.editReply(
      `❌ Nothing found matching **${rawQuery}**${category ? ` in ${category}` : ''}.`
    );
    return;
  }

  // A pet gets the full treatment — variants, artwork and history charts —
  // rendered by lib/petView.js, which is the old /pet view kept intact.
  if (match.category === 'Pet') {
    await interaction.editReply(await buildPetReply(match.id));
    return;
  }

  await interaction.editReply({ embeds: [await buildItemEmbed(match, index, existsRaw)] });
}

async function buildItemEmbed(match, index, existsRaw) {
  const emoji = CATEGORY_EMOJI[match.category] ?? '📦';

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${match.id}`)
    .setColor(0x3987e5)
    .setTimestamp()
    .setFooter({ text: `${match.category} · game-wide total from the public API` });

  // Currency is a single game-wide pool, not a countable item, so "how many
  // exist" means something different and the wording has to follow.
  if (match.category === 'Currency') {
    embed.setDescription(
      `## ${formatCompact(match.total)}\n` +
        `**${formatNumber(match.total)}** ${match.id} in the entire game.`
    );
    return embed;
  }

  embed.setDescription(`## ${formatNumber(match.total)} in existence`);

  // Tiered items (enchants, potions, charms) carry a `tn` level, and the
  // per-level split is the interesting part — a tier-5 enchant is a different
  // thing from a tier-1 one even though they share an id.
  const tiers = new Map();
  for (const entry of existsRaw) {
    if (entry.category !== match.category || entry.configData?.id !== match.id) continue;
    const tn = entry.configData?.tn;
    if (tn == null) continue;
    tiers.set(tn, (tiers.get(tn) ?? 0) + (Number(entry.value) || 0));
  }

  if (tiers.size > 1) {
    embed.addFields({
      name: '🔢 By level',
      value: capToFieldLimit(
        [...tiers.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([tn, v]) => `**Level ${tn}** · ${formatNumber(v)}`)
      ),
    });
  }

  // RAP only exists for tradeable things; most categories have none, so this
  // is added only when there is genuinely a figure to show.
  const rapRaw = await getAllRap().catch(() => []);
  const rap = rapRaw
    .filter((e) => e.category === match.category && e.configData?.id === match.id)
    .reduce((sum, e) => sum + (Number(e.value) || 0), 0);

  if (rap > 0) {
    embed.addFields({ name: '💎 RAP', value: `**${formatNumber(rap)}**`, inline: true });
  }

  // Same-name items in other categories. This is the Diamonds trap made
  // visible: searching "Diamonds" lands on one of twenty-one entries, and
  // saying so beats silently answering for whichever one sorted first.
  const others = index.filter((e) => e.id === match.id && e.category !== match.category);
  if (others.length > 0) {
    embed.addFields({
      name: '🔎 Also called this',
      value: capToFieldLimit(
        others.map((o) => `**${o.category}** · ${formatCompact(o.total)}`),
        '_None._'
      ),
    });
  }

  return embed;
}
