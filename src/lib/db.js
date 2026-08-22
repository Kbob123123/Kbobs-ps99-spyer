import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/spyer.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
-- One row per (guild, kind). kind is a tier name for hatch-rate channels
-- ('huge'|'titanic'|'gargantuan') or an alert type ('rap'|'exists').
-- message_id lets the recurring rate post edit itself in place rather than
-- adding a new message every 10 minutes.
CREATE TABLE IF NOT EXISTS channels (
  guild_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  PRIMARY KEY (guild_id, kind)
);

-- Static description of a pet variant, kept out of the history tables so a
-- name/tier isn't repeated on every one of the millions of readings.
CREATE TABLE IF NOT EXISTS pet_meta (
  pet_key TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  variant TEXT NOT NULL,
  tier    TEXT
);

-- Exists-count and RAP readings.
--
-- IMPORTANT: rows are written ONLY when a value actually changes, not on
-- every poll. There are ~6,300 tiered pet variants; storing all of them every
-- 10 minutes would be ~1M rows/day, and the overwhelming majority of those
-- rows would be identical to the one before (RAP in particular is cached
-- upstream for hours). Change-only storage is lossless for everything we do
-- with it, because every read is "the latest row at or before time T" — which
-- returns the correct value whether or not a row exists exactly at T.
CREATE TABLE IF NOT EXISTS exists_history (
  pet_key TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  value   INTEGER NOT NULL,
  PRIMARY KEY (pet_key, ts)
);

CREATE INDEX IF NOT EXISTS idx_exists_history_key_ts ON exists_history (pet_key, ts DESC);

CREATE TABLE IF NOT EXISTS rap_history (
  pet_key TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  value   INTEGER NOT NULL,
  PRIMARY KEY (pet_key, ts)
);

CREATE INDEX IF NOT EXISTS idx_rap_history_key_ts ON rap_history (pet_key, ts DESC);

-- Small key/value store for scheduler bookkeeping that must outlive a restart,
-- e.g. "has today's daily RAP summary already been posted".
-- Gamepasses and developer products seen in a monitored universe.
--
-- This is the baseline the leak detector diffs against: anything present in
-- the API but missing here is NEW, and anything whose name, price or sale
-- status differs has CHANGED. Both are worth announcing, and the change case
-- is the more valuable of the two — a gamepass sitting unreleased under the
-- name "TEMPORARY NAME!" is only interesting at the moment it gets a real one.
--
-- first_seen is ours, not Roblox's. Their "created" is when the studio made
-- the item, which can be long before we ever looked; first_seen is when it
-- entered OUR record, and only the second one can tell "new to the game" from
-- "new to us" on the very first pass.
--
-- (No backticks anywhere in this block: the whole schema is one JS template
-- literal, and a backtick in a SQL comment silently terminates it.)
CREATE TABLE IF NOT EXISTS store_items (
  universe_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- product | gamepass
  item_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  price        INTEGER,
  is_for_sale  INTEGER NOT NULL DEFAULT 0,
  icon_asset   TEXT,
  created      TEXT,
  updated      TEXT,
  first_seen   INTEGER NOT NULL,
  PRIMARY KEY (universe_id, kind, item_id)
);

CREATE TABLE IF NOT EXISTS bot_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Every tiered pet we have ever seen in the collection.
--
-- This is the baseline for "a new pet was released", and it lives on DISK for
-- one specific reason: the check used to compare against a module-level Set
-- that started empty on every boot. Railway restarts these services several
-- times a week, and each restart silently re-baselined — so a pet released
-- while the bot was down could never be announced, and the first pass after
-- any restart was guaranteed to find "nothing new" no matter what shipped.
--
-- first_seen is ours, not the game's: it records when the pet entered OUR
-- record, which is the only thing that can separate "new to the game" from
-- "new to us" on a cold start.
CREATE TABLE IF NOT EXISTS known_pets (
  name       TEXT PRIMARY KEY,
  tier       TEXT,
  first_seen INTEGER NOT NULL
);

-- Last reading of the live Roblox game, for update and restart detection.
--
-- peak_playing is tracked separately from playing because a restart is only
-- visible as a COLLAPSE: comparing against the previous poll alone would miss
-- a restart that happened between two low readings, and would fire on the
-- ordinary overnight decline. The peak is what the drop is measured from.
-- Every item id we have seen in /api/exists, across ALL 26 categories.
--
-- Broader than known_pets on purpose: that table drives the new-PET alert and
-- holds only tiered pets, while an update ships eggs, enchants, potions and
-- hoverboards too. Kept separate rather than merged because the two answer
-- different questions and have different baselines — merging them would make
-- the pet alert fire for a new potion.
--
-- first_seen is what the update summary reads: "what appeared in the last few
-- hours", which is how new content is attributed to the update that shipped it.
CREATE TABLE IF NOT EXISTS known_items (
  category   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (category, item_id)
);

CREATE INDEX IF NOT EXISTS idx_known_items_seen ON known_items (first_seen DESC);

-- Daily readings of a game-wide currency total, for the inflation tracker.
--
-- value is REAL, not INTEGER, on purpose. Diamonds sit around 1.05e15 which
-- is fine either way, but /api/exists carries currencies as large as 8e46
-- (Coins) — far past what a 64-bit integer column can hold. REAL costs
-- nothing here: doubles represent integers exactly below 2^53, so every
-- figure we actually report is exact, and the absurd ones degrade to
-- approximate instead of failing to store.
--
-- One row per (currency, day): the tracker wants a daily delta, so a reading
-- per poll would be 144x the rows for no extra resolution.
CREATE TABLE IF NOT EXISTS currency_history (
  currency TEXT NOT NULL,
  day      TEXT NOT NULL,
  value    REAL NOT NULL,
  ts       INTEGER NOT NULL,
  PRIMARY KEY (currency, day)
);

CREATE TABLE IF NOT EXISTS game_state (
  universe_id  TEXT PRIMARY KEY,
  name         TEXT,
  updated      TEXT,
  playing      INTEGER,
  peak_playing INTEGER,
  checked_at   INTEGER NOT NULL
);

-- Channels that receive the bot's own release announcements.
--
-- Its own table rather than another "channels" kind, because it is not a
-- per-guild alert setting: it is a broadcast list, read as a flat set at
-- startup with no guild scoping in the query. Keying on channel_id lets one
-- server register more than one, and makes unregistering exact.
--
-- WHICH VERSIONS HAVE BEEN ANNOUNCED IS NOT STORED HERE. That marker lives
-- once in bot_meta, globally. Putting it on the row would mean a channel
-- registered tomorrow replays every past release the first time it is seen.
CREATE TABLE IF NOT EXISTS bot_update_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  added_by   TEXT,
  added_at   INTEGER NOT NULL
);

-- Servers allowed to use the bot, managed by the owner via /ownermenu.
--
-- An EMPTY table means "allow everyone" on purpose. The alternative — empty
-- means deny — would take every server offline the moment this shipped, and
-- the owner would have to whitelist their way back in from a bot that no
-- longer answers them. Enforcement only begins once at least one guild is
-- listed, which makes turning it on a deliberate act.
CREATE TABLE IF NOT EXISTS guild_whitelist (
  guild_id TEXT PRIMARY KEY,
  note     TEXT,
  added_by TEXT,
  added_at INTEGER NOT NULL
);

-- Every command invocation, so the owner can see what each server is doing.
CREATE TABLE IF NOT EXISTS command_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  guild_id   TEXT,
  guild_name TEXT,
  user_id    TEXT NOT NULL,
  username   TEXT,
  command    TEXT NOT NULL,
  options    TEXT,
  outcome    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_command_log_ts ON command_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_command_log_guild ON command_log (guild_id, ts DESC);
`);

/* ---------------------------------------------------------------------------
 * Channel configuration
 * ------------------------------------------------------------------------- */

export function setChannel(guildId, kind, channelId) {
  db.prepare(`
    INSERT INTO channels (guild_id, kind, channel_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, kind) DO UPDATE SET channel_id = excluded.channel_id, message_id = NULL
  `).run(guildId, kind, channelId);
}

export function clearChannel(guildId, kind) {
  db.prepare(`DELETE FROM channels WHERE guild_id = ? AND kind = ?`).run(guildId, kind);
}

export function getGuildChannels(guildId) {
  return db.prepare(`SELECT * FROM channels WHERE guild_id = ?`).all(guildId);
}

export function getChannelsOfKind(kind) {
  return db.prepare(`SELECT * FROM channels WHERE kind = ?`).all(kind);
}

export function setChannelMessageId(guildId, kind, messageId) {
  db.prepare(`UPDATE channels SET message_id = ? WHERE guild_id = ? AND kind = ?`).run(messageId, guildId, kind);
}

/* ---------------------------------------------------------------------------
 * Pet metadata
 * ------------------------------------------------------------------------- */

export function upsertPetMetaBatch(rows) {
  const stmt = db.prepare(`
    INSERT INTO pet_meta (pet_key, name, variant, tier) VALUES (@petKey, @name, @variant, @tier)
    ON CONFLICT(pet_key) DO UPDATE SET name = excluded.name, variant = excluded.variant, tier = excluded.tier
  `);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getPetMeta(petKey) {
  return db.prepare(`SELECT * FROM pet_meta WHERE pet_key = ?`).get(petKey);
}

/* ---------------------------------------------------------------------------
 * History
 * ------------------------------------------------------------------------- */

function tableFor(metric) {
  if (metric !== 'exists' && metric !== 'rap') throw new Error(`Unknown metric: ${metric}`);
  return metric === 'exists' ? 'exists_history' : 'rap_history';
}

/**
 * Write readings for the current poll, skipping any whose value is unchanged
 * since the last stored reading. Returns how many rows were actually written,
 * which is useful for log output (a healthy poll writes far fewer rows than
 * it was offered).
 */
export function recordReadings(metric, readings, ts = Math.floor(Date.now() / 1000)) {
  const table = tableFor(metric);
  const latest = db.prepare(`
    SELECT value FROM ${table} WHERE pet_key = ? ORDER BY ts DESC LIMIT 1
  `);
  const insert = db.prepare(`
    INSERT INTO ${table} (pet_key, ts, value) VALUES (?, ?, ?)
    ON CONFLICT(pet_key, ts) DO UPDATE SET value = excluded.value
  `);

  let written = 0;
  db.exec('BEGIN');
  try {
    for (const r of readings) {
      const prev = latest.get(r.petKey);
      if (prev && Number(prev.value) === Number(r.value)) continue;
      insert.run(r.petKey, ts, r.value);
      written++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return written;
}

/** The value in force at `ts` — the latest reading at or before it. */
export function getValueAt(metric, petKey, ts) {
  const row = db.prepare(`
    SELECT * FROM ${tableFor(metric)} WHERE pet_key = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
  `).get(petKey, ts);
  return row ? Number(row.value) : null;
}

/** Most recent reading for a pet, or null. */
export function getLatestValue(metric, petKey) {
  const row = db.prepare(`
    SELECT * FROM ${tableFor(metric)} WHERE pet_key = ? ORDER BY ts DESC LIMIT 1
  `).get(petKey);
  return row ? { value: Number(row.value), ts: Number(row.ts) } : null;
}

/**
 * Readings across a window, oldest first, for charting.
 *
 * Because storage is change-only, the first row inside the window may be much
 * newer than the window start. The value in force at the window start is
 * prepended so a chart line begins at the left edge instead of floating.
 */
export function getSeries(metric, petKey, windowSeconds) {
  const from = Math.floor(Date.now() / 1000) - windowSeconds;
  const rows = db.prepare(`
    SELECT ts, value FROM ${tableFor(metric)} WHERE pet_key = ? AND ts >= ? ORDER BY ts ASC
  `).all(petKey, from);

  const series = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.value) }));

  const baseline = getValueAt(metric, petKey, from);
  if (baseline != null && (series.length === 0 || series[0].ts > from)) {
    series.unshift({ ts: from, value: baseline });
  }

  return series;
}

/**
 * Delete readings older than `keepSeconds`, but keep the most recent row at or
 * before the cutoff for each pet. Without that carve-out, change-only storage
 * would lose the baseline for any pet whose value hasn't moved recently, and
 * its history would read as empty rather than flat.
 */
export function pruneHistory(metric, keepSeconds) {
  const table = tableFor(metric);
  const cutoff = Math.floor(Date.now() / 1000) - keepSeconds;
  const result = db.prepare(`
    DELETE FROM ${table}
    WHERE ts < ?
      AND ts NOT IN (
        SELECT MAX(ts) FROM ${table} AS inner_t
        WHERE inner_t.pet_key = ${table}.pet_key AND inner_t.ts <= ?
      )
  `).run(cutoff, cutoff);
  return result.changes ?? 0;
}

export function countRows(metric) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${tableFor(metric)}`).get();
  return n;
}

/* ---------------------------------------------------------------------------
 * Guild whitelist and command log (owner tooling)
 * ------------------------------------------------------------------------- */

export function addWhitelistedGuild({ guildId, note, addedBy }) {
  db.prepare(`
    INSERT INTO guild_whitelist (guild_id, note, added_by, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET note = excluded.note
  `).run(String(guildId), note ?? null, addedBy ? String(addedBy) : null, Math.floor(Date.now() / 1000));
}

/** Returns true if a row was actually removed. */
export function removeWhitelistedGuild(guildId) {
  return db.prepare(`DELETE FROM guild_whitelist WHERE guild_id = ?`).run(String(guildId)).changes > 0;
}

export function getWhitelistedGuilds() {
  return db.prepare(`SELECT * FROM guild_whitelist ORDER BY added_at ASC`).all();
}

export function countWhitelistedGuilds() {
  return db.prepare(`SELECT COUNT(*) AS n FROM guild_whitelist`).get().n;
}

export function isGuildWhitelisted(guildId) {
  if (!guildId) return false;
  return !!db.prepare(`SELECT 1 FROM guild_whitelist WHERE guild_id = ?`).get(String(guildId));
}

const COMMAND_LOG_MAX_ROWS = 20000;

/**
 * Whether command logging is currently running.
 *
 * Defaults to ON when unset: the owner asked for this to monitor servers, and
 * a monitor that silently starts disabled would look broken rather than idle.
 * The menu's stop button writes 'off' explicitly.
 */
export function isCommandLoggingEnabled() {
  return getMeta('command_logging') !== 'off';
}

export function setCommandLoggingEnabled(on) {
  setMeta('command_logging', on ? 'on' : 'off');
}

export function logCommand({ guildId, guildName, userId, username, command, options, outcome }) {
  if (!isCommandLoggingEnabled()) return;

  db.prepare(`
    INSERT INTO command_log (ts, guild_id, guild_name, user_id, username, command, options, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Math.floor(Date.now() / 1000),
    guildId ? String(guildId) : null,
    guildName ?? null,
    String(userId),
    username ?? null,
    command,
    options ?? null,
    outcome
  );

  // Trim opportunistically rather than on a timer — cheap, and keeps the table
  // bounded without another scheduled job to forget about.
  if (Math.random() < 0.01) {
    db.prepare(`
      DELETE FROM command_log WHERE id <= (
        SELECT MAX(id) - ? FROM command_log
      )
    `).run(COMMAND_LOG_MAX_ROWS);
  }
}

/** Recent command log entries, newest first, optionally filtered to one guild. */
export function getCommandLog({ guildId = null, limit = 25 } = {}) {
  if (guildId) {
    return db
      .prepare(`SELECT * FROM command_log WHERE guild_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(String(guildId), limit);
  }
  return db.prepare(`SELECT * FROM command_log ORDER BY ts DESC LIMIT ?`).all(limit);
}

/** Per-guild usage totals, busiest first. */
export function getCommandLogSummary(limit = 20) {
  return db
    .prepare(
      `SELECT guild_id, guild_name, COUNT(*) AS uses, MAX(ts) AS last_used
       FROM command_log GROUP BY guild_id ORDER BY uses DESC LIMIT ?`
    )
    .all(limit);
}

/* ---------------------------------------------------------------------------
 * Scheduler bookkeeping
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Store items (gamepasses + developer products)
 * ------------------------------------------------------------------------- */

/** Everything we hold for a universe, keyed "kind:itemId". */
export function getStoreItems(universeId) {
  const rows = db.prepare(`SELECT * FROM store_items WHERE universe_id = ?`).all(String(universeId));
  return new Map(rows.map((r) => [`${r.kind}:${r.item_id}`, r]));
}

/** True when we have never recorded anything for this universe. */
export function isStoreBaselineEmpty(universeId) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM store_items WHERE universe_id = ?`).get(String(universeId));
  return n === 0;
}

/** Insert or update a batch of items in one transaction. */
export function upsertStoreItems(items) {
  if (items.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO store_items
      (universe_id, kind, item_id, name, price, is_for_sale, icon_asset, created, updated, first_seen)
    VALUES (@universeId, @kind, @itemId, @name, @price, @isForSale, @iconAsset, @created, @updated, @firstSeen)
    ON CONFLICT(universe_id, kind, item_id) DO UPDATE SET
      name        = excluded.name,
      price       = excluded.price,
      is_for_sale = excluded.is_for_sale,
      icon_asset  = excluded.icon_asset,
      updated     = excluded.updated
      -- first_seen is deliberately NOT updated: it records when WE first saw
      -- the item, and overwriting it would erase that forever.
  `);

  const now = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const item of items) {
      stmt.run({
        universeId: String(item.universeId),
        kind: item.kind,
        itemId: String(item.itemId),
        name: item.name ?? '',
        price: item.priceInRobux ?? null,
        isForSale: item.isForSale ? 1 : 0,
        iconAsset: item.iconAssetId != null ? String(item.iconAssetId) : null,
        created: item.created ?? null,
        updated: item.updated ?? null,
        firstSeen: now,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function countStoreItems(universeId) {
  return db
    .prepare(`SELECT kind, COUNT(*) AS n FROM store_items WHERE universe_id = ? GROUP BY kind`)
    .all(String(universeId))
    .reduce((acc, r) => ({ ...acc, [r.kind]: r.n }), { product: 0, gamepass: 0 });
}

/* ---------------------------------------------------------------------------
 * Known pets (new-release detection)
 * ------------------------------------------------------------------------- */

/** True when we hold no baseline at all — the very first run. */
export function isKnownPetsEmpty() {
  return db.prepare(`SELECT COUNT(*) AS n FROM known_pets`).get().n === 0;
}

export function getKnownPetNames() {
  return new Set(db.prepare(`SELECT name FROM known_pets`).all().map((r) => r.name));
}

/** Record pets as known. Existing rows keep their original first_seen. */
export function addKnownPets(rows) {
  if (rows.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO known_pets (name, tier, first_seen) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET tier = excluded.tier
  `);
  const now = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.name, r.tier ?? null, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Rename the old combined 'newpet' channel to 'newitem'.
 *
 * 'newpet' used to carry both "a pet was added" and "a pet was hatched for the
 * first time". Those split into the new-item scanner and the first-hatch
 * alert, and without this the servers that had already configured it would
 * silently stop receiving anything — the kind simply would not match any
 * lookup, with nothing logged and no error anywhere.
 *
 * The scanner is the closer descendant of the two, so that is what it becomes.
 * INSERT OR IGNORE then DELETE rather than UPDATE, because a guild that has
 * somehow set both would violate the (guild_id, kind) primary key.
 */
function migrateNewPetChannels() {
  const rows = db.prepare(`SELECT * FROM channels WHERE kind = 'newpet'`).all();
  if (rows.length === 0) return;

  db.exec('BEGIN');
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO channels (guild_id, kind, channel_id) VALUES (?, 'newitem', ?)`
    );
    for (const row of rows) insert.run(row.guild_id, row.channel_id);
    db.prepare(`DELETE FROM channels WHERE kind = 'newpet'`).run();
    db.exec('COMMIT');
    console.log(`[db] Migrated ${rows.length} 'newpet' channel(s) to 'newitem'.`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.warn('[db] Could not migrate newpet channels:', err.message);
  }
}

migrateNewPetChannels();

/* ---------------------------------------------------------------------------
 * Known items across every category (new-item scanner)
 * ------------------------------------------------------------------------- */

export function isKnownItemsEmpty() {
  return db.prepare(`SELECT COUNT(*) AS n FROM known_items`).get().n === 0;
}

export function getKnownItemKeys() {
  return new Set(
    db.prepare(`SELECT category, item_id FROM known_items`).all().map((r) => `${r.category}:${r.item_id}`)
  );
}

export function addKnownItems(rows, ts = Math.floor(Date.now() / 1000)) {
  if (rows.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO known_items (category, item_id, first_seen) VALUES (?, ?, ?)
    ON CONFLICT(category, item_id) DO NOTHING
  `);

  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.category, r.itemId, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * Currency history (inflation tracker)
 * ------------------------------------------------------------------------- */

/** Record today's reading, overwriting an earlier one for the same day. */
export function recordCurrencyReading(currency, day, value) {
  db.prepare(`
    INSERT INTO currency_history (currency, day, value, ts) VALUES (?, ?, ?, ?)
    ON CONFLICT(currency, day) DO UPDATE SET value = excluded.value, ts = excluded.ts
  `).run(currency, day, Number(value), Math.floor(Date.now() / 1000));
}

/** The most recent days, newest first. */
export function getCurrencyHistory(currency, limit = 30) {
  return db
    .prepare(`SELECT * FROM currency_history WHERE currency = ? ORDER BY day DESC LIMIT ?`)
    .all(currency, limit);
}

/** One specific day's reading, or null. */
export function getCurrencyReading(currency, day) {
  return db.prepare(`SELECT * FROM currency_history WHERE currency = ? AND day = ?`).get(currency, day) ?? null;
}

/* ---------------------------------------------------------------------------
 * Live game state (update + restart detection)
 * ------------------------------------------------------------------------- */

export function getGameState(universeId) {
  return db.prepare(`SELECT * FROM game_state WHERE universe_id = ?`).get(String(universeId)) ?? null;
}

export function setGameState({ universeId, name, updated, playing, peakPlaying }) {
  db.prepare(`
    INSERT INTO game_state (universe_id, name, updated, playing, peak_playing, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(universe_id) DO UPDATE SET
      name         = excluded.name,
      updated      = excluded.updated,
      playing      = excluded.playing,
      peak_playing = excluded.peak_playing,
      checked_at   = excluded.checked_at
  `).run(
    String(universeId),
    name ?? null,
    updated ?? null,
    playing ?? null,
    peakPlaying ?? null,
    Math.floor(Date.now() / 1000)
  );
}

/* ---------------------------------------------------------------------------
 * Bot update announcement channels
 * ------------------------------------------------------------------------- */

export function addBotUpdateChannel({ channelId, guildId, addedBy }) {
  db.prepare(`
    INSERT INTO bot_update_channels (channel_id, guild_id, added_by, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id, added_by = excluded.added_by
  `).run(String(channelId), String(guildId), addedBy ? String(addedBy) : null, Math.floor(Date.now() / 1000));
}

/** Returns true if a row was actually removed. */
export function removeBotUpdateChannel(channelId) {
  return db.prepare(`DELETE FROM bot_update_channels WHERE channel_id = ?`).run(String(channelId)).changes > 0;
}

/** Every registered channel, across all servers. */
export function getBotUpdateChannels() {
  return db.prepare(`SELECT * FROM bot_update_channels ORDER BY added_at ASC`).all();
}

/** What this server has registered, if anything. */
export function getBotUpdateChannelsForGuild(guildId) {
  return db.prepare(`SELECT * FROM bot_update_channels WHERE guild_id = ?`).all(String(guildId));
}

export function getMeta(key) {
  return db.prepare(`SELECT value FROM bot_meta WHERE key = ?`).get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare(
    `INSERT INTO bot_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}
