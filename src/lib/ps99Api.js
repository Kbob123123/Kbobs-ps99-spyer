import fetch from 'node-fetch';

// Pet-only slice of the PS99 public API. Anything clan- or league-shaped was
// removed in the 2.0 rewrite — those live in the sibling ps99-clan-bot and
// ps99-league-bot projects now.

const BASE = 'https://ps99.biggamesapi.io';

class Ps99ApiError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'Ps99ApiError';
    this.status = status;
  }
}

// Simple URL-keyed response cache. The upstream RAP/exists figures only move
// every few hours, so re-fetching them on a 10-minute poll is wasted work.
const cache = new Map(); // url -> { data, expiresAt }

async function getJson(pathAndQuery, ttlMs = 0) {
  const url = `${BASE}${pathAndQuery}`;

  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
  }

  const res = await fetch(url, { headers: { 'User-Agent': 'ps99-pet-spyer/2.0' } });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Ps99ApiError(`PS99 API returned non-JSON (HTTP ${res.status})`, { status: res.status });
  }

  if (body.status !== 'ok') {
    throw new Ps99ApiError(body?.error?.message || `PS99 API error (HTTP ${res.status})`, { status: res.status });
  }

  if (ttlMs > 0) cache.set(url, { data: body.data, expiresAt: Date.now() + ttlMs });
  return body.data;
}

const RAP_TTL_MS = 5 * 60 * 1000;
const EXISTS_TTL_MS = 5 * 60 * 1000;

/**
 * Every tracked item's Recent Average Price.
 * Entries: { category, configData: {id, pt?, sh?}, value }
 */
export async function getAllRap() {
  return getJson('/api/rap', RAP_TTL_MS);
}

/**
 * Every tracked item's exists count (how many are in the game).
 * Same entry shape as RAP.
 */
export async function getAllExists() {
  return getJson('/api/exists', EXISTS_TTL_MS);
}

// The Pets collection changes only when the game ships new pets, so a long
// cache is fine for tier classification and thumbnails.
const PETS_TTL_MS = 6 * 60 * 60 * 1000;

export async function getPetsCollection() {
  // Note the /api prefix — /collection/Pets without it returns
  // "Endpoint not valid".
  return getJson('/api/collection/Pets', PETS_TTL_MS);
}

/**
 * Any collection by name, e.g. 'Eggs', 'Enchants', 'Hoverboards'.
 *
 * Same long TTL as Pets and for the same reason: a collection only changes
 * when the game ships content. Used to find artwork for categories other than
 * pets, which is why it exists at all — /api/exists gives an id and a count
 * and no picture.
 */
export async function getCollection(name) {
  return getJson(`/api/collection/${name}`, PETS_TTL_MS);
}

/**
 * The Pets collection, bypassing the long cache above.
 *
 * The 6-hour TTL is right for tier classification (a pet's huge/titanic flag
 * never changes) but wrong for detecting newly released pets, which the
 * tracker wants to catch close to when they appear. The distinct query string
 * gives this its own cache key so the two TTL policies don't fight over one
 * shared URL-keyed entry.
 */
export async function getPetsCollectionFresh() {
  return getJson('/api/collection/Pets?_fresh=1', 10 * 60 * 1000);
}

/**
 * Variant label for a RAP/exists entry.
 *
 * `pt` is the "pet type" flag (1 = Golden, 2 = Rainbow) and `sh` marks Shiny.
 * A pet can be both, e.g. Shiny Rainbow.
 */
export function describeVariant(configData = {}) {
  const parts = [];
  if (configData.pt === 1) parts.push('Golden');
  if (configData.pt === 2) parts.push('Rainbow');
  if (configData.sh) parts.push('Shiny');
  return parts.length ? parts.join(' ') : 'Normal';
}

/**
 * Stable key for one specific pet variant, so exists/RAP readings for
 * "Huge Cat" and "Golden Huge Cat" never collide in the history table.
 */
export function variantKey(entry) {
  const cfg = entry.configData ?? {};
  return `${cfg.id}|${cfg.pt ?? 0}|${cfg.sh ? 1 : 0}`;
}

/**
 * Resolve a user's search text to a single pet name.
 * Prefers an exact (case-insensitive) match; otherwise the shortest partial
 * match, which in practice is the least-surprising choice — searching "cat"
 * should find "Huge Cat" rather than "Huge Cat Fish Deluxe".
 */
export function resolvePetName(names, query) {
  const lower = query.toLowerCase();
  let bestPartial = null;

  for (const name of names) {
    const nameLower = name.toLowerCase();
    if (nameLower === lower) return name;
    if (nameLower.includes(lower)) {
      if (!bestPartial || name.length < bestPartial.length) bestPartial = name;
    }
  }

  return bestPartial;
}

export { Ps99ApiError };
