import fetch from 'node-fetch';
import { isPetExcluded } from './petExclusions.js';

const LEGACY_BASE = 'https://ps99.biggamesapi.io/api';
const V1_BASE = 'https://ps99.biggamesapi.io/v1';

// Simple in-memory cache. RAP/exists are large lists cached for a while server-side
// anyway (60s normal data, 4hr for RAP), so we mirror that to avoid hammering the API.
const cache = new Map();
async function getJson(url, ttlMs = 60_000) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < ttlMs) {
    return cached.data;
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'ps99-discord-bot/1.0 (github.com/BIG-Games-LLC/ps99-public-api-docs)' }
  });

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }

  const json = await res.json();
  if (json.status !== 'ok') {
    // The API's error.message field isn't always a plain string in every
    // error case we've seen — be defensive so callers always get a real
    // string to display instead of "[object Object]" or similar leaking
    // into a Discord reply and causing a confusing secondary failure.
    const rawMessage = json.error?.message;
    const message =
      typeof rawMessage === 'string' && rawMessage.length > 0
        ? rawMessage
        : `API returned an error status (${JSON.stringify(json.error ?? json).slice(0, 200)})`;
    const err = new Error(message);
    err.apiError = json.error;
    throw err;
  }

  cache.set(url, { data: json.data, time: Date.now() });
  return json.data;
}

// --- Legacy API (/api/*) ---
// Response envelope: { status: "ok", data: [...] }
// Items look like: { category, configData: { id, pt?, sh? }, value }
// pt=1 golden, pt=2 rainbow, sh=true shiny (mainly relevant to pets)

export async function getAllRap() {
  return getJson(`${LEGACY_BASE}/rap`, 4 * 60 * 60 * 1000); // cached 4hr like upstream
}

export async function getAllExists() {
  return getJson(`${LEGACY_BASE}/exists`, 60_000);
}

export async function getClan(clanName) {
  return getJson(`${LEGACY_BASE}/clan/${encodeURIComponent(clanName)}`, 60_000);
}

export async function getClans({ page = 1, pageSize = 10, sort = 'Points', sortOrder = 'desc' } = {}) {
  return getJson(
    `${LEGACY_BASE}/clans?page=${page}&pageSize=${pageSize}&sort=${sort}&sortOrder=${sortOrder}`,
    60_000
  );
}

export async function getActiveClanBattle() {
  return getJson(`${LEGACY_BASE}/activeClanBattle`, 60_000);
}

// Helper: filter a rap/exists list by pet or item name (case-insensitive, partial match)
export function findByName(list, name) {
  const needle = name.toLowerCase();
  return list.filter((entry) => entry.configData?.id?.toLowerCase().includes(needle));
}

// Resolves a search query to a single best-matching pet NAME (not a list of
// entries) — prefers an exact case-insensitive match, then falls back to the
// shortest name containing the query as a substring (the closest/most
// specific match, avoiding an overly broad "dragon" matching 15 different
// dragon pets when the person likely meant one specific pet). Returns null
// if nothing matches at all.
export function resolvePetName(list, query) {
  const needle = query.toLowerCase();
  let exactMatch = null;
  let bestPartial = null;

  for (const entry of list) {
    const id = entry.configData?.id;
    if (!id) continue;
    const idLower = id.toLowerCase();

    if (idLower === needle) {
      exactMatch = id;
      break; // can't do better than exact
    }

    if (idLower.includes(needle)) {
      if (!bestPartial || id.length < bestPartial.length) {
        bestPartial = id;
      }
    }
  }

  return exactMatch ?? bestPartial;
}

export function describeVariantFromConfig(configData) {
  const parts = [];
  if (configData.pt === 1) parts.push('Golden');
  if (configData.pt === 2) parts.push('Rainbow');
  if (configData.sh) parts.push('Shiny');
  return parts.length ? parts.join(' ') : 'Normal';
}

export function formatEntry(entry) {
  return {
    name: entry.configData?.id ?? 'Unknown',
    variant: describeVariantFromConfig(entry.configData ?? {}),
    category: entry.category,
    value: entry.value,
  };
}

// --- Pet tier classification ---
// Pull the full Pets collection once (cached) and use its configData flags
// (huge / titanic / gargantuan) to classify by exact pet name. This is more
// reliable than name-prefix matching since prefixes can appear inside compound
// names (e.g. "Huge" could theoretically be part of a regular pet's name).
let petsCollectionCache = null;
let petsCollectionCacheTime = 0;
const PETS_COLLECTION_TTL = 6 * 60 * 60 * 1000; // pets list rarely changes for TIER classification purposes

export async function getPetsCollection() {
  if (petsCollectionCache && Date.now() - petsCollectionCacheTime < PETS_COLLECTION_TTL) {
    return petsCollectionCache;
  }
  const data = await getJson(`${LEGACY_BASE}/collection/Pets`, PETS_COLLECTION_TTL);
  petsCollectionCache = data;
  petsCollectionCacheTime = Date.now();
  return data;
}

// Separate from getPetsCollection() above: that function's 6-hour cache is
// fine for tier classification (huge/titanic/gargantuan rarely changes) but
// was ALSO being used for new-pet detection in the tracker, meaning newly
// added pets could go undetected for up to 6 hours after release — a real
// bug, since the tracker polls every 10 minutes and expects to catch new
// items close to when they appear. This bypasses both the outer cache and
// the underlying getJson HTTP cache with a short, dedicated TTL. A distinct
// query marker (harmless, ignored server-side) gives it its own cache key
// so the two TTL policies don't collide on getJson's shared URL-keyed cache.
export async function getPetsCollectionFresh() {
  return getJson(`${LEGACY_BASE}/collection/Pets?_fresh=1`, 10 * 60 * 1000); // 10 min, matches tracker cadence
}

// Builds a Map from pet name -> tier ('huge' | 'titanic' | 'gargantuan' | null)
export async function getPetTierMap() {
  const pets = await getPetsCollection();
  const map = new Map();
  for (const pet of pets) {
    const cfg = pet.configData ?? {};
    const name = cfg.name ?? pet.configName;
    if (!name) continue;
    if (isPetExcluded(name)) continue; // prototype/test entries, admin-blocked names
    let tier = null;
    if (cfg.gargantuan) tier = 'gargantuan';
    else if (cfg.titanic) tier = 'titanic';
    else if (cfg.huge) tier = 'huge';
    if (!tier) {
      if (/^gargantuan\s/i.test(name)) tier = 'gargantuan';
      else if (/^titanic\s/i.test(name)) tier = 'titanic';
      else if (/^huge\s/i.test(name)) tier = 'huge';
    }
    if (tier) map.set(name, tier);
  }
  return map;
}

// Builds a Map from pet name -> thumbnail info { thumbnail, goldenThumbnail }
// (both are rbxassetid:// strings per the collection API, either may be empty).
// Callers should pass the right one to resolveThumbnail() in thumbnails.js
// based on which variant (golden/rainbow/shiny/normal) they're displaying.
export async function getPetThumbnailMap() {
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

// --- v1 API (/v1/*) ---
// NOTE: exact field names for player profiles are not independently verified here.
// Code defensively reads common-sense fields and falls back to raw JSON on mismatch.

export async function getPlayer(usernameOrId) {
  return getJson(`${V1_BASE}/players/${encodeURIComponent(usernameOrId)}`, 60_000);
}

// v1 leagues — CONFIRMED shape from live testing (2026-07-09):
// GET /v1/leagues returns { leagues: [...], total, page, pageSize }
// Each league: { Name, NameLower, ID, Icon, Level, Points, Members,
//                MemberCapacity, ContributorCount, Owner, Created }
// IMPORTANT: there is no working single-league lookup endpoint. Tried and
// confirmed NOT working: /v1/leagues/{ID}, /v1/leagues/{name},
// /v1/leagues?name=X (silently ignored, returns the unfiltered list).
// There is also no per-member/contributor breakdown available from this
// endpoint or any other public endpoint found — Members/ContributorCount
// are counts only. So /league <name> works by paging through the list
// client-side to find a name match, and rates are league-level only
// (points/hour for the league as a whole), not per-player.
export async function getLeaguesPage(page = 1, pageSize = 100) {
  const result = await getJson(
    `${V1_BASE}/leagues?page=${page}&pageSize=${pageSize}`,
    60_000
  );
  return result; // { leagues, total, page, pageSize }
}

// Searches across paginated results for a league matching `name`
// (case-insensitive, exact match on Name/NameLower preferred, falls back to
// partial match). Scans up to `maxPages` pages (100/page = up to 2000
// leagues by default) since there's no server-side name filter. Returns the
// first exact match found, or the first partial match if no exact match
// exists, or null.
export async function findLeagueByName(name, { maxPages = 20, pageSize = 100 } = {}) {
  const needle = name.toLowerCase();
  let partialMatch = null;

  for (let page = 1; page <= maxPages; page++) {
    const { leagues, total } = await getLeaguesPage(page, pageSize);
    if (!leagues || leagues.length === 0) break;

    for (const league of leagues) {
      if (league.NameLower === needle) return league; // exact match, stop immediately
      if (!partialMatch && league.NameLower?.includes(needle)) partialMatch = league;
    }

    if (page * pageSize >= total) break; // reached the end of the list
  }

  return partialMatch;
}

// Fetches the top N leagues by points. The list endpoint isn't documented as
// pre-sorted, so we sort client-side after fetching enough pages to cover N
// (with some headroom in case of ties/pagination quirks).
export async function getTopLeagues(count = 10, { pageSize = 100 } = {}) {
  const { leagues } = await getLeaguesPage(1, Math.max(pageSize, count * 2));
  return [...leagues].sort((a, b) => b.Points - a.Points).slice(0, count);
}
