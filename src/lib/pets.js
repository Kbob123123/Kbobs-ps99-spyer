import { getPetsCollection, getPetsCollectionFresh } from './ps99Api.js';

// Pet names matching these are dev/test/placeholder entries that occasionally
// leak into the public collection data. They're excluded from tier
// classification entirely, so they never appear in rate posts or alerts.
const EXCLUDE_PATTERNS = [/\bprototype\b/i, /\btest\b/i, /\bplaceholder\b/i, /\bwip\b/i, /\bdebug\b/i];

// Specific names to exclude that the patterns above don't catch.
const EXCLUDED_NAMES = new Set(['titanic pixel m-2 prototype']);

export const TIERS = ['huge', 'titanic', 'gargantuan'];

export const TIER_META = {
  huge: { label: 'Huge', color: 0xf1c40f, emoji: '🟡' },
  titanic: { label: 'Titanic', color: 0xe67e22, emoji: '🟠' },
  gargantuan: { label: 'Gargantuan', color: 0xe74c3c, emoji: '🔴' },
};

export function isExcluded(name) {
  if (!name) return true;
  if (EXCLUDED_NAMES.has(name.toLowerCase())) return true;
  return EXCLUDE_PATTERNS.some((p) => p.test(name));
}

/**
 * Classify one pet from its collection entry.
 *
 * The configData booleans are authoritative and are checked first; the name
 * prefix is only a fallback for entries missing those flags. Doing it in that
 * order matters — matching on the name alone would misclassify any pet whose
 * name merely contains "Huge".
 */
function classify(cfg, name) {
  if (cfg.gargantuan) return 'gargantuan';
  if (cfg.titanic) return 'titanic';
  if (cfg.huge) return 'huge';

  if (/^gargantuan\s/i.test(name)) return 'gargantuan';
  if (/^titanic\s/i.test(name)) return 'titanic';
  if (/^huge\s/i.test(name)) return 'huge';

  return null;
}

/** Map of pet name -> 'huge' | 'titanic' | 'gargantuan'. Excludes untiered pets. */
export async function getTierMap() {
  const pets = await getPetsCollection();
  const map = new Map();

  for (const pet of pets) {
    const cfg = pet.configData ?? {};
    const name = cfg.name ?? pet.configName;
    if (!name || isExcluded(name)) continue;

    const tier = classify(cfg, name);
    if (tier) map.set(name, tier);
  }

  return map;
}

/** Map of pet name -> { thumbnail, goldenThumbnail } (rbxassetid:// strings, either may be null). */
export async function getThumbnailMap() {
  const pets = await getPetsCollection();
  const map = new Map();

  for (const pet of pets) {
    const cfg = pet.configData ?? {};
    const name = cfg.name ?? pet.configName;
    if (!name) continue;
    map.set(name, {
      thumbnail: cfg.thumbnail || null,
      goldenThumbnail: cfg.goldenThumbnail || null,
    });
  }

  return map;
}

/** Every known pet name (including untiered), for /pet and /rap name resolution. */
export async function getAllPetNames() {
  const pets = await getPetsCollection();
  const names = [];
  for (const pet of pets) {
    const name = pet.configData?.name ?? pet.configName;
    if (name && !isExcluded(name)) names.push(name);
  }
  return names;
}

/** Full detail for one pet by exact name, or null. */
export async function getPetDetail(name) {
  const pets = await getPetsCollection();
  const lower = name.toLowerCase();
  const found = pets.find((p) => (p.configData?.name ?? p.configName ?? '').toLowerCase() === lower);
  if (!found) return null;

  const cfg = found.configData ?? {};
  return {
    name: cfg.name ?? found.configName,
    tier: classify(cfg, cfg.name ?? found.configName ?? ''),
    // `rarity` is an OBJECT ({RarityNumber, DisplayName, _id, Color, ...}),
    // not a string — interpolating it straight into an embed renders the
    // literal text "[object Object]".
    rarity: cfg.rarity?.DisplayName ?? cfg.rarity?._id ?? null,
    description: cfg.indexDesc ?? null,
    obtainable: cfg.indexObtainable ?? null,
    thumbnail: cfg.thumbnail || null,
    goldenThumbnail: cfg.goldenThumbnail || null,
  };
}

/** Names present in the fresh collection — used to detect newly released pets. */
export async function getFreshPetNames() {
  const pets = await getPetsCollectionFresh();
  const names = [];
  for (const pet of pets) {
    const name = pet.configData?.name ?? pet.configName;
    if (name && !isExcluded(name)) names.push(name);
  }
  return names;
}
