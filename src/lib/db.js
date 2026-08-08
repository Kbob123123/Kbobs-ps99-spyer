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
