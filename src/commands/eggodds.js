import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getCollection } from '../lib/ps99Api.js';
import { resolveThumbnail } from '../lib/thumbnails.js';
import { capToFieldLimit, formatNumber } from '../lib/format.js';

const MAX_CANDIDATES = 15;

export const data = new SlashCommandBuilder()
  .setName('eggodds')
  .setDescription("Exact pet drop odds for an egg, straight from the game's own weight table.")
  .addStringOption((opt) =>
    opt.setName('egg').setDescription('Egg name (partial is fine, e.g. "royal")').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('egg', true).trim().toLowerCase();
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const eggs = await getCollection('Eggs');
  const matches = eggs.filter((e) => e.configData?.name?.toLowerCase().includes(query));

  if (matches.length === 0) {
    await interaction.editReply(`❌ No egg matching **${interaction.options.getString('egg', true)}** was found.`);
    return;
  }

  // The collection carries every egg ever shipped, and a display name can be
  // reused across events with a completely different pet pool (e.g. "Pot of
  // Gold Egg" names 5 distinct configs) — never assume a name is unique.
  const byName = new Map();
  for (const e of matches) {
    const name = e.configData.name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(e);
  }

  if (byName.size > 1) {
    await interaction.editReply({ embeds: [buildPickerEmbed(interaction.options.getString('egg', true), byName)] });
    return;
  }

  const [name, versions] = [...byName.entries()][0];
  // Multiple versions of the same name: the current one is the one the game
  // last touched. Older ones are noted, not silently dropped, since their odds
  // genuinely differed and someone could still be asking about last year's run.
  const sorted = [...versions].sort((a, b) => (dateOf(b) ?? 0) - (dateOf(a) ?? 0));
  const current = sorted[0];
  const older = sorted.slice(1);

  await interaction.editReply({ embeds: [await buildOddsEmbed(name, current, older)] });
}

function dateOf(entry) {
  return entry.dateModified ? new Date(entry.dateModified).getTime() : null;
}

function buildPickerEmbed(rawQuery, byName) {
  const names = [...byName.keys()].sort();
  const embed = new EmbedBuilder()
    .setTitle(`🥚 Egg odds — "${rawQuery}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = names
    .slice(0, MAX_CANDIDATES)
    .map((n) => `• **${n}**${byName.get(n).length > 1 ? ` _(${byName.get(n).length} versions)_` : ''}`);

  embed.setDescription(
    `**${names.length}** eggs match — be more specific.\n\n${capToFieldLimit(lines, '_None._', 3800)}`
  );
  return embed;
}

/**
 * Pet weights aren't normalized to 100 — Royal Egg's sum to ~100.05, but
 * others don't. Odds are each weight over the SUM of that egg's own weights,
 * not the raw number itself.
 */
async function buildOddsEmbed(name, egg, olderVersions) {
  const cfg = egg.configData;
  const pets = Array.isArray(cfg.pets) ? cfg.pets : [];
  const totalWeight = pets.reduce((sum, [, weight]) => sum + (Number(weight) || 0), 0);

  const ranked = [...pets].sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));

  const lines = ranked.map(([petName, weight, rarity]) => {
    const pct = totalWeight > 0 ? ((Number(weight) || 0) / totalWeight) * 100 : 0;
    const oneIn = pct > 0 ? formatNumber(100 / pct) : '∞';
    const tag = rarity ? ` _(${rarity})_` : '';
    return `**${petName}**${tag} — ${formatOddsPct(pct)} _(1 in ${oneIn})_`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🥚 ${name}`)
    .setColor(0x3987e5)
    .setTimestamp()
    .setDescription(
      `Exact drop odds from the game's own weight table — not an estimate.\n\n` +
        capToFieldLimit(lines, '_No pets listed._', 3600)
    );

  const iconUrl = await resolveThumbnail(cfg.icon).catch(() => null);
  if (iconUrl) embed.setThumbnail(iconUrl);

  const modifierFields = [];
  if (cfg.goldChance > 0) modifierFields.push(`🟡 Golden: **${cfg.goldChance}%**`);
  if (cfg.rainbowChance > 0) modifierFields.push(`🌈 Rainbow: **${cfg.rainbowChance}%**`);
  if (cfg.shinyChance > 0) modifierFields.push(`✨ Shiny: **${cfg.shinyChance}%**`);
  if (modifierFields.length > 0) {
    embed.addFields({ name: 'Modifier chance (independent of the pet rolled)', value: modifierFields.join(' · ') });
  }

  const footerParts = [];
  if (olderVersions.length > 0) {
    footerParts.push(
      `${olderVersions.length} older version${olderVersions.length > 1 ? 's' : ''} of this egg existed with different odds.`
    );
  }
  footerParts.push('Odds = weight ÷ this egg\'s total weight, straight from /api/collection/Eggs.');
  embed.setFooter({ text: footerParts.join(' ') });

  return embed;
}

function formatOddsPct(pct) {
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(4)}%`;
  return `${pct.toExponential(2)}%`;
}
