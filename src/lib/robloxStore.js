import fetch from 'node-fetch';

/**
 * Gamepasses and developer products for a Roblox universe.
 *
 * Both endpoints are on apis.roblox.com and both work WITHOUT authentication —
 * verified live against PS99's universe. That matters: it means monitoring a
 * game you do not own is possible at all, which is not true of most of the
 * Open Cloud surface.
 *
 * The gamepass route is NOT the one you would guess. The commonly-cited
 * `games.roblox.com/v1/games/{universeId}/game-passes` returns 404 with an
 * empty error body — it looks like a bad universe id rather than a dead route,
 * which is a good way to waste an afternoon. The working one is below.
 */

const DEV_PRODUCTS = (universeId, limit, cursor) =>
  `https://apis.roblox.com/developer-products/v2/universes/${universeId}/developerproducts` +
  `?limit=${limit}` +
  (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

const GAME_PASSES = (universeId, limit, cursor) =>
  `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes` +
  `?limit=${limit}` +
  (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

// 100 is the documented maximum for both. The live universe holds ~530 dev
// products, so a full pass is about six requests.
const PAGE_SIZE = 100;

// A runaway cursor loop would hammer Roblox forever; 40 pages is far more than
// the real data needs and turns a bug into a bounded one.
const MAX_PAGES = 40;

const REQUEST_TIMEOUT_MS = 15000;

// Roblox rate-limits these, and a full pass is a handful of calls, so a small
// gap between pages costs nothing and keeps us clearly under any threshold.
const PAGE_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'User-Agent': 'ps99-spyer/1.0' },
  });
  if (!res.ok) {
    const err = new Error(`Roblox store API returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Walk every page of a cursor-paginated endpoint. */
async function pageAll(urlFor, key) {
  const out = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(urlFor(PAGE_SIZE, cursor));
    out.push(...(body?.[key] ?? []));

    cursor = body?.nextPageCursor ?? null;
    if (!cursor) return out;
    await sleep(PAGE_DELAY_MS);
  }

  console.warn(`[store] Hit the ${MAX_PAGES}-page ceiling; results may be truncated.`);
  return out;
}

/**
 * Every developer product in a universe, normalised.
 *
 * The API returns PascalCase here and camelCase for gamepasses, which is a
 * genuine inconsistency in Roblox's own surface — both are flattened to one
 * shape so the differ downstream does not have to care which it is looking at.
 */
export async function getDeveloperProducts(universeId) {
  const raw = await pageAll((limit, cursor) => DEV_PRODUCTS(universeId, limit, cursor), 'developerProducts');

  return raw.map((p) => ({
    kind: 'product',
    universeId: String(universeId),
    itemId: String(p.ProductId),
    name: p.Name ?? p.displayName ?? '',
    description: p.Description ?? '',
    priceInRobux: p.PriceInRobux ?? null,
    isForSale: Boolean(p.IsForSale),
    iconAssetId: p.IconImageAssetId ?? p.displayIcon ?? null,
    created: p.Created ?? null,
    updated: p.Updated ?? null,
  }));
}

/** Every gamepass in a universe, in the same normalised shape. */
export async function getGamePasses(universeId) {
  const raw = await pageAll((limit, cursor) => GAME_PASSES(universeId, limit, cursor), 'gamePasses');

  return raw.map((p) => ({
    kind: 'gamepass',
    universeId: String(universeId),
    itemId: String(p.id),
    name: p.name ?? p.displayName ?? '',
    description: p.displayDescription ?? '',
    // Gamepasses only carry a price when they are on sale; absent is not zero.
    priceInRobux: p.price ?? null,
    isForSale: Boolean(p.isForSale),
    iconAssetId: p.displayIconImageAssetId ?? null,
    created: p.created ?? null,
    updated: p.updated ?? null,
  }));
}

/** Both kinds for one universe, in one list. */
export async function getStoreItems(universeId) {
  const [products, passes] = await Promise.all([
    getDeveloperProducts(universeId),
    getGamePasses(universeId),
  ]);
  return [...products, ...passes];
}

/**
 * Names that mean "this is not finished yet".
 *
 * The reveal is the interesting event, not the creation: PS99 shipped a
 * gamepass literally called "TEMPORARY NAME!" and a product called "???", and
 * the moment those get a real name is the moment the content is announced.
 * Matched loosely because the studio's placeholder vocabulary is theirs, not
 * ours, and a missed placeholder only costs us the "renamed from a
 * placeholder" framing — the rename still alerts either way.
 */
const PLACEHOLDER_PATTERNS = [
  /^\?+$/,
  /temporary/i,
  /^test\b/i,
  /placeholder/i,
  /\btbd\b/i,
  /^untitled/i,
  /^new (product|pass|gamepass)/i,
];

export function isPlaceholderName(name) {
  const trimmed = String(name ?? '').trim();
  if (trimmed === '') return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}
