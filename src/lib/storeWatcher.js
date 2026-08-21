import { EmbedBuilder } from 'discord.js';
import { getStoreItems as fetchStoreItems, isPlaceholderName } from './robloxStore.js';
import {
  getStoreItems as readStoredItems,
  upsertStoreItems,
  isStoreBaselineEmpty,
  getChannelsOfKind,
} from './db.js';
import { resolveThumbnail } from './thumbnails.js';
import { formatNumber } from './format.js';

/**
 * Watches a Roblox universe's shop for anything new or changed.
 *
 * The point is unreleased content. A studio builds a gamepass or product
 * before it announces it, and both are readable through public, unauthenticated
 * endpoints — so a new row appearing, or a placeholder name turning into a real
 * one, is a leak in the plainest sense.
 *
 * Four events, in descending order of how interesting they are:
 *
 *   revealed  — a placeholder name became a real one. THE signal.
 *   onsale    — something not for sale went on sale.
 *   new       — an item we have never seen before.
 *   renamed   — any other name change.
 *
 * Price changes are tracked but deliberately NOT announced: PS99 reprices
 * routinely and it would drown the three events above.
 */

// The universes worth watching. The live game is where new items actually
// appear — the dev game holds a single product from 2025 and no gamepasses,
// so it is included only as a cheap extra, not as the primary source.
export const WATCHED_UNIVERSES = [
  { id: '3317771874', label: 'Pet Simulator 99', emoji: '🐾' },
  { id: '5349377275', label: 'PS99 Dev Game', emoji: '🛠️' },
];

const CHANNEL_KIND = 'store';

// Discord caps a message at 10 embeds, and a studio publishing a product
// family (1 / 3 / 10 / 100 of a thing) makes that a real case, not a
// theoretical one — the Lucky Noob Eggs landed as four products in two minutes.
const EMBEDS_PER_MESSAGE = 10;

// A first run against a universe we hold nothing for would otherwise announce
// all ~530 products at once. The baseline pass records them silently.
const BASELINE_SILENT = true;

/**
 * Compare live items against what we hold, and return the events worth posting.
 *
 * Pure: it reads the stored rows and returns events, and does not write. The
 * caller writes AFTER posting so a crash mid-post cannot silently swallow a
 * leak by advancing the baseline past it.
 */
export function diffStoreItems(stored, live) {
  const events = [];

  for (const item of live) {
    const key = `${item.kind}:${item.itemId}`;
    const previous = stored.get(key);

    if (!previous) {
      events.push({ type: 'new', item });
      continue;
    }

    const wasPlaceholder = isPlaceholderName(previous.name);
    const isPlaceholder = isPlaceholderName(item.name);
    const renamed = previous.name !== item.name;

    // The reveal: something that was hiding under a placeholder now has a
    // real name. Checked before the generic rename so it wins the framing.
    if (renamed && wasPlaceholder && !isPlaceholder) {
      events.push({ type: 'revealed', item, previousName: previous.name });
    } else if (renamed) {
      events.push({ type: 'renamed', item, previousName: previous.name });
    }

    // Going on sale is a separate event from being renamed, and both can
    // happen in the same pass — a pass revealed AND put on sale is two facts.
    if (!previous.is_for_sale && item.isForSale) {
      events.push({ type: 'onsale', item });
    }
  }

  return events;
}

const EVENT_META = {
  revealed: { title: '🎭 Name Revealed', color: 0xeb459e },
  onsale: { title: '🟢 Now On Sale', color: 0x57f287 },
  new: { title: '🆕 New Item', color: 0x2ee6c5 },
  renamed: { title: '✏️ Renamed', color: 0xfee75c },
};

const KIND_LABEL = { product: '🛒 Developer product', gamepass: '🎟️ Gamepass' };

/**
 * A public page for the item, or null.
 *
 * Gamepasses have one. Developer products genuinely do not — they are only
 * purchasable in-game — so linking the game itself is the honest fallback
 * rather than a URL that 404s.
 */
function itemLink(item, universe) {
  if (item.kind === 'gamepass') return `https://www.roblox.com/game-pass/${item.itemId}`;
  return universe?.rootPlaceId ? `https://www.roblox.com/games/${universe.rootPlaceId}` : null;
}

/** Build the embed for one event. */
export async function buildStoreEmbed(event, universe) {
  const { item } = event;
  const meta = EVENT_META[event.type] ?? EVENT_META.new;

  const embed = new EmbedBuilder()
    .setTitle(meta.title)
    .setColor(meta.color)
    .setTimestamp();

  // Prose first, so the reader gets the story before the reference data.
  // Deliberately not a stacked label column — same house rule as the clan bot.
  const story = [];
  if (event.type === 'revealed') {
    story.push(`**${item.name}**\n_was_ \`${event.previousName}\` — the real name just went live.`);
  } else if (event.type === 'renamed') {
    story.push(`**${item.name}**\n_was_ \`${event.previousName}\``);
  } else if (event.type === 'onsale') {
    story.push(`**${item.name}** is now purchasable.`);
  } else {
    story.push(`**${item.name}**`);
    if (isPlaceholderName(item.name)) {
      story.push('_Placeholder name — this is unreleased. You will get another alert when it is named._');
    }
  }
  if (item.description) story.push(`\n${item.description.slice(0, 300)}`);
  embed.setDescription(story.join('\n'));

  embed.addFields(
    { name: '🎮 Game', value: `${universe.emoji} ${universe.label}`, inline: true },
    {
      name: '💰 Price',
      value: item.priceInRobux != null ? `**${formatNumber(item.priceInRobux)}** R$` : '_not set_',
      inline: true,
    },
    { name: '🏷️ Type', value: KIND_LABEL[item.kind] ?? item.kind, inline: true },
    { name: '🆔 ID', value: `\`${item.itemId}\``, inline: true },
    { name: '🛒 On sale', value: item.isForSale ? '✅ Yes' : '⛔ Not yet', inline: true },
    {
      name: '📅 Created',
      // Discord's relative timestamp beats a date string: "2 minutes ago" is
      // what tells you whether you are early.
      value: item.created ? `<t:${Math.floor(new Date(item.created).getTime() / 1000)}:R>` : '—',
      inline: true,
    }
  );

  const link = itemLink(item, universe);
  if (link) embed.addFields({ name: '🔗 Link', value: `[Open on Roblox](${link})`, inline: false });

  // The item's own icon. Decoration, so a failure costs nothing.
  if (item.iconAssetId) {
    const art = await resolveThumbnail(`rbxassetid://${item.iconAssetId}`).catch(() => null);
    if (art) embed.setThumbnail(art);
  }

  return embed;
}

/**
 * One pass over every watched universe.
 *
 * Each universe is isolated: a failure on one must not stop the others, and a
 * Roblox outage should cost a pass rather than the whole poll.
 */
export async function runStoreWatch(client) {
  const channels = getChannelsOfKind(CHANNEL_KIND);

  for (const universe of WATCHED_UNIVERSES) {
    try {
      await watchOneUniverse(client, universe, channels);
    } catch (err) {
      console.warn(`[store] Pass failed for ${universe.label}:`, err.message);
    }
  }
}

async function watchOneUniverse(client, universe, channels) {
  const live = await fetchStoreItems(universe.id);
  if (live.length === 0) return; // an empty response is far likelier to be an outage than a wiped shop

  const firstEver = isStoreBaselineEmpty(universe.id);
  const stored = readStoredItems(universe.id);
  const events = diffStoreItems(stored, live);

  // First pass records everything silently. Without this, switching the
  // feature on would announce ~530 products in one go.
  if (firstEver && BASELINE_SILENT) {
    upsertStoreItems(live);
    console.log(`[store] Baseline recorded for ${universe.label}: ${live.length} item(s), nothing announced.`);
    return;
  }

  if (events.length === 0) {
    upsertStoreItems(live);
    return;
  }

  console.log(`[store] ${universe.label}: ${events.length} event(s) — ${events.map((e) => e.type).join(', ')}`);

  // Newest first: when a product family lands at once, the reader wants the
  // headline item at the top.
  const embeds = [];
  for (const event of events) {
    embeds.push(await buildStoreEmbed(event, universe));
  }

  for (const row of channels) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased()) continue;

    for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
      await channel
        .send({ embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE) })
        .catch((err) => console.warn(`[store] Could not post to ${row.channel_id}:`, err.message));
    }
  }

  // Written only after posting. Advancing the baseline first would mean a
  // failed send silently loses the leak forever.
  upsertStoreItems(live);
}
