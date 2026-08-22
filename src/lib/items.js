import { EmbedBuilder } from 'discord.js';
import {
  isKnownItemsEmpty,
  getKnownItemKeys,
  addKnownItems,
  getChannelsOfKind,
} from './db.js';
import { getPetDetail, TIER_META } from './pets.js';
import { resolveArtwork } from './artwork.js';

/**
 * The new-item scanner: everything that appears in the game, in any of the
 * 26 categories /api/exists carries.
 *
 * This owns NEW CONTENT entirely — new pets included. Game updates
 * deliberately do NOT list items: an update announcement says the game
 * updated, and the scanner says what appeared, on its own schedule. Tying the
 * list to the update event was worse on both counts, because items land in
 * the API before or after the republish rather than with it, so the list was
 * always either early and empty or late and attributed to the wrong update.
 */

const CHANNEL_KIND = 'newitem';

// Categories worth announcing. The full 26 include internal bookkeeping rows
// (Misc, Card, Tower, HPillar and friends) that churn without meaning
// anything to a player, and announcing those buries the ones that matter.
const ANNOUNCED_CATEGORIES = new Set([
  'Pet',
  'Egg',
  'Enchant',
  'Potion',
  'Charm',
  'Hoverboard',
  'Booth',
]);

const CATEGORY_META = {
  Pet: { emoji: '🐾', label: 'Pet', color: 0x2ee6c5 },
  Egg: { emoji: '🥚', label: 'Egg', color: 0xfee75c },
  Enchant: { emoji: '✨', label: 'Enchant', color: 0x9b59b6 },
  Potion: { emoji: '🧪', label: 'Potion', color: 0x3498db },
  Charm: { emoji: '🍀', label: 'Charm', color: 0x2ecc71 },
  Hoverboard: { emoji: '🛹', label: 'Hoverboard', color: 0xe67e22 },
  Booth: { emoji: '🏪', label: 'Booth', color: 0x95a5a6 },
};

// Discord caps a message at 10 embeds and rejects the whole thing past that.
const EMBEDS_PER_MESSAGE = 10;

/**
 * Record every item id present, returning the ones that are new.
 *
 * First run records everything silently — ~4,200 items would otherwise be
 * announced as new content the first time this ever ran.
 */
export function detectNewItems(existsRaw, ts = Math.floor(Date.now() / 1000)) {
  const rows = [];
  const seen = new Set();

  for (const entry of existsRaw) {
    const id = entry.configData?.id;
    if (!entry.category || !id) continue;

    // A variant (golden/shiny/tier) is the same ITEM here. Without this the
    // six pet variants each read as a separate release and one new pet is
    // announced six times.
    const key = `${entry.category}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ category: entry.category, itemId: String(id) });
  }

  if (isKnownItemsEmpty()) {
    // first_seen 0, NOT the current time — see the note in db.js. Stamping the
    // baseline with now would make every one of these look brand new.
    addKnownItems(rows, 0);
    console.log(`[items] Baseline recorded: ${rows.length} item(s) across all categories.`);
    return [];
  }

  const known = getKnownItemKeys();
  const added = rows.filter((r) => !known.has(`${r.category}:${r.itemId}`));

  if (added.length > 0) {
    addKnownItems(added, ts);
    const byCategory = {};
    for (const a of added) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    console.log(
      `[items] ${added.length} new item(s): ` +
        Object.entries(byCategory).map(([c, n]) => `${c} x${n}`).join(', ')
    );
  }

  return added;
}

/**
 * Build the announcement for one new item.
 *
 * A pet gets its tier, rarity and flavour text because that is the
 * information people actually want about a new pet; everything else gets the
 * category and its picture. Both lead with a large image rather than a field
 * list — a new item is a thing you look at, not a row of statistics.
 */
export async function buildNewItemEmbed(item) {
  const meta = CATEGORY_META[item.category] ?? { emoji: '📦', label: item.category, color: 0x3987e5 };

  const embed = new EmbedBuilder().setColor(meta.color).setTimestamp();

  if (item.category === 'Pet') {
    const detail = await getPetDetail(item.itemId).catch(() => null);
    const tierMeta = detail?.tier ? TIER_META[detail.tier] : null;

    embed
      .setTitle(`${tierMeta?.emoji ?? meta.emoji} NEW ${(tierMeta?.label ?? 'PET').toUpperCase()}`)
      .setColor(tierMeta?.color ?? meta.color);

    const lines = [`## ${item.itemId}`];
    if (detail?.rarity != null) lines.push(`💠 **Rarity:** ${detail.rarity}`);
    if (detail?.obtainable === false) lines.push('🚫 **Unobtainable** — this cannot be hatched');
    if (detail?.description) lines.push(`\n_${detail.description}_`);
    embed.setDescription(lines.join('\n'));
  } else {
    embed
      .setTitle(`${meta.emoji} NEW ${meta.label.toUpperCase()}`)
      .setDescription(`## ${item.itemId}`);
  }

  embed.setFooter({ text: 'Spotted in the game data the moment it appeared.' });

  // Large image, not a thumbnail. Null is normal for potions and most
  // enchants, and the embed simply reads as text-only in that case.
  const art = await resolveArtwork(item.category, item.itemId).catch(() => null);
  if (art) embed.setImage(art);

  return embed;
}

/**
 * Announce new items.
 *
 * Batched into messages of ten rather than one message each: a game update
 * can add a whole egg's worth of pets at once, and that should be one
 * notification carrying ten pictures, not ten notifications.
 */
export async function postNewItemAlerts(client, added) {
  const worth = added.filter((i) => ANNOUNCED_CATEGORIES.has(i.category));
  if (worth.length === 0) return 0;

  const channels = getChannelsOfKind(CHANNEL_KIND);
  if (channels.length === 0) return 0;

  const embeds = [];
  for (const item of worth) embeds.push(await buildNewItemEmbed(item));

  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
      await channel
        .send({ embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE) })
        .catch((err) => console.warn(`[items] Could not post to ${row.channel_id}:`, err.message));
    }
  }

  return embeds.length;
}
