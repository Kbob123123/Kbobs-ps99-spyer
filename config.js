import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'guildConfig.json');

// Shape: { [guildId]: { hugeChannelId, titanicChannelId, gargantuanChannelId,
//                        rapAlertChannelId, existsAlertChannelId } }
let cache = null;

function ensureLoaded() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    // This fires on a genuinely fresh install too, so it's not always a
    // problem — but if you expected existing server configs to carry over
    // (e.g. after updating the bot's code) and see this message, it means
    // the data/ folder wasn't preserved during the update. See
    // SETUP-FILES.txt "Preserving config across updates".
    console.warn(
      '[config] No existing data/guildConfig.json found — starting with empty configuration. ' +
        'If you expected existing server configs to carry over from before an update, ' +
        'the data/ folder likely wasn\'t preserved — see SETUP-FILES.txt.'
    );
    cache = {};
    save();
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error('[config] Failed to parse guildConfig.json, starting fresh:', err.message);
    cache = {};
  }
  return cache;
}

function save() {
  writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

export const CHANNEL_KEYS = {
  huge: 'hugeChannelId',
  titanic: 'titanicChannelId',
  gargantuan: 'gargantuanChannelId',
  rapAlert: 'rapAlertChannelId',
  existsAlert: 'existsAlertChannelId',
  clanTop10: 'clanTop10ChannelId',
  leagueTop10: 'leagueTop10ChannelId',
  gameUpdate: 'gameUpdateChannelId',
  newItem: 'newItemChannelId',
};

export function getGuildConfig(guildId) {
  const all = ensureLoaded();
  return all[guildId] ?? {};
}

export function getAllGuildConfigs() {
  return ensureLoaded();
}

export function setGuildChannel(guildId, key, channelId) {
  const all = ensureLoaded();
  if (!all[guildId]) all[guildId] = {};
  all[guildId][key] = channelId;
  save();
}

export function clearGuildChannel(guildId, key) {
  const all = ensureLoaded();
  if (!all[guildId]) return;
  delete all[guildId][key];
  save();
}

export function clearAllGuildConfig(guildId) {
  const all = ensureLoaded();
  delete all[guildId];
  save();
}

// Clan member point tracker — separate from the single-channel CHANNEL_KEYS
// pattern since it needs two inputs (clan name + channel) set together.
// Stored per-guild as { clanName, channelId }.
export function setClanTracker(guildId, clanName, channelId) {
  const all = ensureLoaded();
  if (!all[guildId]) all[guildId] = {};
  all[guildId].clanTracker = { clanName, channelId };
  save();
}

export function getClanTracker(guildId) {
  const all = ensureLoaded();
  return all[guildId]?.clanTracker ?? null;
}

export function clearClanTracker(guildId) {
  const all = ensureLoaded();
  if (!all[guildId]) return;
  delete all[guildId].clanTracker;
  save();
}

// Returns all guilds that have a clan tracker configured, as
// [{ guildId, clanName, channelId }], for the tracker's broadcast loop.
export function getAllClanTrackers() {
  const all = ensureLoaded();
  const results = [];
  for (const [guildId, cfg] of Object.entries(all)) {
    if (cfg.clanTracker) {
      results.push({ guildId, ...cfg.clanTracker });
    }
  }
  return results;
}

// Inactivity alerts — a separate channel + on/off toggle from the main
// clan-tracker contributions post, per explicit request. Requires
// clanTracker to also be set (there's no clan name here; it reuses whatever
// clan the server is already tracking via /setupclan).
export function setClanInactivityConfig(guildId, channelId, enabled) {
  const all = ensureLoaded();
  if (!all[guildId]) all[guildId] = {};
  all[guildId].clanInactivity = { channelId, enabled };
  save();
}

export function getClanInactivityConfig(guildId) {
  const all = ensureLoaded();
  return all[guildId]?.clanInactivity ?? null;
}

export function clearClanInactivityConfig(guildId) {
  const all = ensureLoaded();
  if (!all[guildId]) return;
  delete all[guildId].clanInactivity;
  save();
}

// Returns all guilds with inactivity alerts enabled AND a clan tracker set,
// as [{ guildId, clanName, channelId }] (channelId here is the inactivity
// channel, distinct from the contributions channel).
export function getAllClanInactivityTrackers() {
  const all = ensureLoaded();
  const results = [];
  for (const [guildId, cfg] of Object.entries(all)) {
    if (cfg.clanInactivity?.enabled && cfg.clanTracker?.clanName) {
      results.push({
        guildId,
        clanName: cfg.clanTracker.clanName,
        channelId: cfg.clanInactivity.channelId,
      });
    }
  }
  return results;
}

// Ping roles — one role per alert TYPE per guild, so e.g. game-update can
// ping @Updates while new-item pings @Shop-Watch in the same server. Keyed
// by the same "type" strings used throughout (huge, titanic, gargantuan,
// rapAlert, existsAlert, gameUpdate, newItem, clanTracker, clanInactivity).
// Stored separately from CHANNEL_KEYS since not every type needs a role and
// this keeps the ping-role concept isolated from channel routing.
export function setPingRole(guildId, type, roleId) {
  const all = ensureLoaded();
  if (!all[guildId]) all[guildId] = {};
  if (!all[guildId].pingRoles) all[guildId].pingRoles = {};
  all[guildId].pingRoles[type] = roleId;
  save();
}

export function getPingRole(guildId, type) {
  const all = ensureLoaded();
  return all[guildId]?.pingRoles?.[type] ?? null;
}

export function clearPingRole(guildId, type) {
  const all = ensureLoaded();
  if (!all[guildId]?.pingRoles) return;
  delete all[guildId].pingRoles[type];
  save();
}

export function getAllPingRoles(guildId) {
  const all = ensureLoaded();
  return all[guildId]?.pingRoles ?? {};
}
