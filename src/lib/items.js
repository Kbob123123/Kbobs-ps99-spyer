import { EmbedBuilder } from 'discord.js';
import {
  isKnownItemsEmpty,
  getKnownItemKeys,
  addKnownItems,
  getItemsSeenSince,
} from './db.js';
import { capToFieldLimit } from './format.js';

/**
 * Tracks every item id in /api/exists, across all 26 categories, so an update
 * can be described by what it actually shipped.
 *
 * This is the "what's new" half of update detection. gameWatcher.js knows an
 * update HAPPENED (the place was republished); this knows what appeared, and
 * the two are deliberately decoupled — new items usually land in the API
 * slightly before or after the republish, so tying the diff to the exact
 * moment of the update event would miss half of them. Instead every poll
 * records what is new, and the summary reports whatever showed up in the
 * surrounding window.
 */

// Categories worth naming in an update summary, in the order players care
// about. Anything else still counts toward the total but is not broken out —
// a summary listing 26 headings is a database dump, not a summary.
const HEADLINE_CATEGORIES = ['Pet', 'Egg', 'Enchant', 'Potion', 'Charm', 'Hoverboard'];

const CATEGORY_META = {
  Pet: { emoji: '🐾', label: 'Pets' },
  Egg: { emoji: '🥚', label: 'Eggs' },
  Enchant: { emoji: '✨', label: 'Enchants' },
  Potion: { emoji: '🧪', label: 'Potions' },
  Charm: { emoji: '🍀', label: 'Charms' },
  Hoverboard: { emoji: '🛹', label: 'Hoverboards' },
};

// How far back an update summary looks. Generous because the API and the
// republish do not land in lockstep, and because a poll is 10 minutes: a
// tight window would report an update as having shipped nothing.
const SUMMARY_WINDOW_SECONDS = 6 * 3600;

/**
 * Record every item id present, returning the ones that are new.
 *
 * First run records everything silently — 17,000+ items would otherwise be
 * announced as "new content" the first time this ever ran.
 */
export function detectNewItems(existsRaw, ts = Math.floor(Date.now() / 1000)) {
  const rows = [];
  const seen = new Set();

  for (const entry of existsRaw) {
    const id = entry.configData?.id;
    if (!entry.category || !id) continue;

    // A variant (golden/shiny/tier) is the same ITEM for this purpose. Without
    // this the six pet variants would each read as a separate new release and
    // one new pet would be reported as six.
    const key = `${entry.category}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ category: entry.category, itemId: String(id) });
  }

  if (isKnownItemsEmpty()) {
    // first_seen 0, NOT the current time. The summary reports "items first
    // seen in the last 6 hours", so stamping ~17,500 baseline items with now
    // means the first update to land within 6 hours of a fresh install
    // announces the entire game as new content. Zero puts them permanently
    // outside every window, which is the honest record anyway: we did not
    // see these appear, we found them already there.
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

/** Group everything first seen in the window by category. */
export function summariseRecentItems(windowSeconds = SUMMARY_WINDOW_SECONDS, now = Math.floor(Date.now() / 1000)) {
  const rows = getItemsSeenSince(now - windowSeconds);

  const byCategory = {};
  for (const row of rows) {
    (byCategory[row.category] ??= []).push(row.item_id);
  }

  return { total: rows.length, byCategory };
}

/**
 * Build the "what shipped" embed, or null when the update added nothing we
 * can see.
 *
 * Returning null matters: an update that only rebalances numbers adds no
 * items, and posting an empty "here is what's new" list under a real update
 * announcement reads as the bot being broken rather than the update being
 * small.
 */
export function buildUpdateSummaryEmbed(summary) {
  if (summary.total === 0) return null;

  const embed = new EmbedBuilder()
    .setTitle('🆕 What the update added')
    .setColor(0x2ee6c5)
    .setDescription(`**${summary.total}** new item(s) appeared in the game files.`)
    .setFooter({ text: 'Seen in the last 6 hours · from the public game data' })
    .setTimestamp();

  let listed = 0;
  for (const category of HEADLINE_CATEGORIES) {
    const items = summary.byCategory[category];
    if (!items || items.length === 0) continue;

    const meta = CATEGORY_META[category] ?? { emoji: '📦', label: category };
    embed.addFields({
      name: `${meta.emoji} ${meta.label} (${items.length})`,
      value: capToFieldLimit(items.map((i) => `• ${i}`)),
      inline: false,
    });
    listed += items.length;
  }

  const others = summary.total - listed;
  if (others > 0) {
    embed.addFields({
      name: '📦 Other categories',
      value: `${others} further item(s) across ${
        Object.keys(summary.byCategory).filter((c) => !HEADLINE_CATEGORIES.includes(c)).length
      } categories.`,
      inline: false,
    });
  }

  return embed;
}

/** Post the summary to the game-update channels after an update fires. */
export async function postUpdateSummary(client, channels) {
  const embed = buildUpdateSummaryEmbed(summariseRecentItems());
  if (!embed) return false;

  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;
    await channel
      .send({ embeds: [embed] })
      .catch((err) => console.warn(`[items] Could not post summary to ${row.channel_id}:`, err.message));
  }

  return true;
}
