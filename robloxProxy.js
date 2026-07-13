import fetch from 'node-fetch';

// Roblox blocks direct server-to-server calls to some of its own API
// subdomains (games.roblox.com, apis.roblox.com) with "HttpService is not
// allowed to access ROBLOX resources" style errors from non-Roblox clients.
// roproxy.com / rprxy.xyz are long-standing, widely-used open mirrors that
// proxy those same endpoints 1:1 (same paths, same response shapes) without
// that block. See community confirmation:
// https://devforum.roblox.com/t/roproxy-endpoints-for-gamepasses/4316664
// https://devforum.roblox.com/t/roproxycom-a-free-rotating-proxy-for-roblox-apis/1508367

const GAMES_API = 'https://games.roproxy.com/v1/games';
const GAMEPASSES_API = 'https://apis.roproxy.com/game-passes/v1/universes';
const DEV_PRODUCTS_API = 'https://apis.roproxy.com/developer-products/v2/universes';

// Confirmed via two independent Roblox URLs showing the same placeId/universeId
// pairing for the live "Pet Simulator 99!" experience.
export const PS99_UNIVERSE_ID = '3317771874';
export const PS99_PLACE_ID = '8737899170';

const cache = new Map();
async function getJsonCached(url, ttlMs) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < ttlMs) return cached.data;

  const res = await fetch(url, { headers: { 'User-Agent': 'ps99-discord-bot/1.0' } });
  if (!res.ok) throw new Error(`Roblox proxy request failed (${res.status}) for ${url}`);

  const json = await res.json();
  cache.set(url, { data: json, time: Date.now() });
  return json;
}

// Returns the game's live metadata, including `updated` (ISO timestamp of
// the last place/game update) — used to detect a new game update/restart
// by diffing against the last-seen value.
// CONFIRMED real response shape (verified via community-posted example):
// { id, name, description, creator, rootPlace, created, updated, placeVisits }
export async function getGameDetails() {
  const json = await getJsonCached(`${GAMES_API}?universeIds=${PS99_UNIVERSE_ID}`, 5 * 60 * 1000);
  return json?.data?.[0] ?? null;
}

// Returns the full list of gamepasses for the PS99 universe.
// CONFIRMED real response shape (verified via community-posted example):
// { gamePasses: [{ id, productId, name, isForSale, displayName,
//   displayDescription, displayIconImageAssetId, created, updated }],
//   nextPageToken }
// NOTE: this differs from the games API's data/nextPageCursor shape — the
// gamepasses endpoint uses gamePasses/nextPageToken instead.
export async function getAllGamepasses() {
  const results = [];
  let cursor = '';

  for (let page = 0; page < 20; page++) {
    const url = `${GAMEPASSES_API}/${PS99_UNIVERSE_ID}/game-passes?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const json = await getJsonCached(url, 10 * 60 * 1000);

    const items = json?.gamePasses ?? [];
    results.push(...items);

    if (!json?.nextPageToken) break;
    cursor = json.nextPageToken;
  }

  return results; // [{ id, productId, name, isForSale, displayName, ... }]
}

// Returns the full list of developer products for the PS99 universe.
// Endpoint confirmed via user-provided link + Roblox's own official
// deprecation announcement documenting this as the current replacement API
// (limit/cursor pagination): apis.roblox.com/developer-products/v2/universes/{id}/developerproducts
// CAUTION: at least one community bug report (March 2025) describes this
// exact v2 endpoint intermittently returning "This endpoint is no longer
// available" — treat failures here as non-fatal (already the pattern below)
// since this endpoint's reliability isn't fully certain.
export async function getAllDeveloperProducts() {
  const results = [];
  let cursor = '';

  for (let page = 0; page < 20; page++) {
    const url = `${DEV_PRODUCTS_API}/${PS99_UNIVERSE_ID}/developerproducts?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const json = await getJsonCached(url, 10 * 60 * 1000);

    // Exact response field name for the items array isn't independently
    // confirmed — try the most likely candidates defensively.
    const items = json?.developerProducts ?? json?.data ?? [];
    results.push(...items);

    const nextCursor = json?.nextPageCursor ?? json?.nextPageToken ?? null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return results; // [{ id/productId, name, priceInRobux, ... }] — exact field names not fully confirmed
}

// --- Username resolution ---
// Clan member data from the PS99 API only includes numeric Roblox UserIDs
// (no usernames) — see /api/clan/{name}'s Members/Contribution arrays.
// This resolves IDs to display names via Roblox's batch users endpoint.
// NOTE: the exact response shape here ({ data: [{ id, name, displayName,
// hasVerifiedBadge, requestedUsername }] }) is based on this endpoint's
// long-documented, stable public shape, but has not been independently
// re-verified against a live response in this session. If names come back
// wrong/missing, check the raw response shape first.
const USERS_API = 'https://users.roproxy.com/v1/users';
const usernameCache = new Map(); // userId -> { name, time }
const USERNAME_CACHE_TTL = 60 * 60 * 1000; // usernames rarely change; cache 1hr

export async function resolveUsernames(userIds) {
  const results = new Map(); // userId -> name (falls back to "User <id>" on failure)
  const toFetch = [];

  for (const id of userIds) {
    const cached = usernameCache.get(id);
    if (cached && Date.now() - cached.time < USERNAME_CACHE_TTL) {
      results.set(id, cached.name);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return results;

  // Roblox's batch endpoint accepts up to 200 IDs per request; keep well
  // under that for safety margin.
  const BATCH_SIZE = 100;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(USERS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ps99-discord-bot/1.0' },
        body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
      });

      if (!res.ok) {
        console.error(`[robloxProxy] Username batch resolve failed (${res.status})`);
        for (const id of batch) results.set(id, `User ${id}`);
        continue;
      }

      const json = await res.json();
      const byId = new Map((json?.data ?? []).map((u) => [u.id, u]));

      for (const id of batch) {
        const user = byId.get(Number(id)) ?? byId.get(id);
        const name = user?.displayName ?? user?.name ?? `User ${id}`;
        usernameCache.set(id, { name, time: Date.now() });
        results.set(id, name);
      }
    } catch (err) {
      console.error('[robloxProxy] Username batch resolve error:', err.message);
      for (const id of batch) results.set(id, `User ${id}`);
    }
  }

  return results;
}
