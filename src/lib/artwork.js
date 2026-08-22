import { getCollection } from './ps99Api.js';
import { resolveThumbnail } from './thumbnails.js';

/**
 * Finds the picture for any item, in any category.
 *
 * /api/exists gives an id and a number and nothing else, so artwork has to
 * come from the matching /api/collection/* endpoint. Each category stores it
 * under a DIFFERENT key — verified live on 2026-08-23:
 *
 *   Pets         thumbnail / goldenThumbnail   3037 entries, all have art
 *   Eggs         icon                          819 of 902
 *   Charms       Icon                          13 of 13
 *   Hoverboards  Icon                          129 of 129
 *   Booths       Icon                          138 of 138
 *   Enchants     PageIcon                      only 9 of 55
 *   Potions      —                             no artwork field at all
 *
 * The last two are why every caller must treat a null as normal rather than
 * an error. A potion has no picture to find, and most enchants share one
 * generic page icon; an embed that assumes art exists would render an empty
 * frame for them.
 */

// category (as it appears in /api/exists) -> collection endpoint + art field.
const SOURCES = {
  Pet: { collection: 'Pets', field: 'thumbnail' },
  Egg: { collection: 'Eggs', field: 'icon' },
  Charm: { collection: 'Charms', field: 'Icon' },
  Hoverboard: { collection: 'Hoverboards', field: 'Icon' },
  Booth: { collection: 'Booths', field: 'Icon' },
  Enchant: { collection: 'Enchants', field: 'PageIcon' },
};

// collection name -> Map(normalised id -> rbxassetid string)
const indexCache = new Map();

/**
 * Strip the category prefix from a collection's configName.
 *
 * Collections name their entries "Charm | Strength" and "Hoverboard |
 * Original", while /api/exists calls the same things "Strength" and
 * "Original". Without this every non-pet lookup misses and every non-pet
 * alert silently loses its picture — the exact failure mode the dead
 * thumbnail URLs had, where nothing errors and the image is just absent.
 */
export function normaliseId(name) {
  if (!name) return '';
  const cut = name.indexOf('|');
  return (cut === -1 ? name : name.slice(cut + 1)).trim().toLowerCase();
}

async function indexFor(collection, field) {
  if (indexCache.has(collection)) return indexCache.get(collection);

  const map = new Map();
  try {
    for (const entry of await getCollection(collection)) {
      const cfg = entry.configData ?? {};
      const art = cfg[field];
      if (!art) continue;

      // Index under every name the entry answers to. DisplayName and name are
      // often friendlier than configName and are what some categories match
      // /api/exists on.
      for (const key of [entry.configName, cfg.name, cfg.DisplayName]) {
        const id = normaliseId(key);
        if (id && !map.has(id)) map.set(id, art);
      }
    }
  } catch (err) {
    console.warn(`[artwork] Could not load ${collection}:`, err.message);
  }

  indexCache.set(collection, map);
  return map;
}

/**
 * A resolved, ready-to-embed image URL for one item, or null.
 *
 * Null is a normal outcome — see the coverage table above.
 */
export async function resolveArtwork(category, id) {
  const source = SOURCES[category];
  if (!source) return null;

  try {
    const index = await indexFor(source.collection, source.field);
    const asset = index.get(normaliseId(id));
    if (!asset) return null;
    return await resolveThumbnail(asset);
  } catch (err) {
    console.warn(`[artwork] Lookup failed for ${category}:${id}:`, err.message);
    return null;
  }
}

/** Whether artwork is even possible for a category, for copy decisions. */
export function categoryHasArtwork(category) {
  return category in SOURCES;
}
