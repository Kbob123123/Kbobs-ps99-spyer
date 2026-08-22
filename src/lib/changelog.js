/**
 * The bot's own changelog, and the version arithmetic the announcer runs on.
 *
 * WRITTEN FOR PLAYERS, NOT FOR DEVELOPERS. Every line here lands in a Discord
 * channel that ordinary users read, so it says what changed for them ("/pet
 * now covers eggs and potions"), never what changed in the source. Commit
 * messages are the wrong register for this and would read as noise; `git log`
 * already keeps those, and it cannot go stale.
 *
 * Adding a release is two edits and a deploy:
 *   1. bump "version" in package.json
 *   2. add an entry here with that exact version
 * The announcer does the rest on the next startup.
 *
 * The three bots deliberately keep separate copies of lib code, so this file
 * exists three times over with three different sets of entries — each bot
 * announces its own work in its own voice.
 */

export const CHANGELOG = [
  {
    version: '2.4.0',
    date: '2026-08-23',
    lines: [
      '**`/pet` has been replaced by `/exists`.** Same pet card, same charts, same everything — it just also covers eggs, potions, enchants and the rest now. Type `/exists` instead.',
      '**Leaderboard payouts now have their own channel** — set it with `/setalertchannel type:Leaderboard reward payouts`.',
      'Payout detection now watches for **one pet** appearing in bulk (50+ of a single Titanic, 10+ of a single Gargantuan), which is what a reward drop actually looks like. It no longer counts a busy hour spread across lots of different pets as a payout.',
    ],
  },
  {
    version: '2.3.0',
    date: '2026-08-23',
    lines: [
      '**`/exists` — look up anything, not just pets.** Eggs, potions, enchants, charms, hoverboards and even game-wide currency totals. Pets still get the full card with variants and history charts. `/pet` keeps working exactly as before.',
      '**Leaderboard payout alerts.** When a burst of Titanics or Gargantuans appears at once — the signature of leaderboard rewards being handed out — the hatch-rate channel now says so instead of it looking like a mystery spike.',
      '**RAP crash alerts.** A Titanic or Gargantuan losing 40%+ of its value in a day now gets its own immediate alert rather than waiting for the next daily digest.',
      '**Diamond economy tracker.** `/setalertchannel type:Diamond economy` posts a daily report of how many diamonds exist game-wide and how fast that is growing.',
      '**Update summaries.** When the game updates, the bot now follows the announcement with a list of the new pets, eggs and enchants that came with it.',
      'Gargantuan hatches that land together now arrive as one message instead of one ping each.',
    ],
  },
  {
    version: '2.2.0',
    date: '2026-08-22',
    lines: [
      '**New pet alerts.** `/setalertchannel type:New pets & first hatches` now posts a message with artwork the moment a new Huge, Titanic or Gargantuan appears in the game — and a second one the first time anybody actually hatches one.',
      '**Game update & restart alerts.** `/setalertchannel type:Game updates & restarts` tells you when PS99 publishes an update (with the new event name, like `[PIÑATA MAZE]`) and when the servers are restarting, so you know to rejoin.',
      '**Shop leak alerts now link to the item.** Developer products were silently missing their link entirely; gamepasses link straight to the store page.',
      'The bot now shows what it is watching in the member list.',
    ],
  },
  {
    version: '2.1.0',
    date: '2026-08-22',
    lines: [
      "**The bot now announces its own updates.** Server admins can point `/botupdchannel` at a channel and every future release shows up there automatically — no more finding out a feature exists by accident.",
      'Nothing from before today gets posted, so this channel starts quiet and fills up as new versions ship.',
    ],
  },
];

/**
 * Compare two dotted version strings numerically.
 *
 * Returns <0, 0 or >0 in the usual sort-comparator sense.
 *
 * String comparison is what this exists to avoid: '2.10.0' < '2.9.0' is true
 * alphabetically and false in every sense that matters, and getting that wrong
 * would silently stop announcing releases somewhere around the tenth patch.
 *
 * Missing parts count as zero, so '2.1' and '2.1.0' compare equal. Anything
 * non-numeric in a part (a '-rc1' suffix) is ignored rather than throwing —
 * a malformed version should degrade to "same release", not take startup down.
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Changelog entries to announce, oldest first.
 *
 * @param {string|null} previous  Last version already announced; null announces from the start.
 * @param {string|null} upTo      Version actually running; entries above it are withheld.
 *
 * The upper bound is the half that is easy to leave out and matters most. An
 * entry can legitimately be written before its release ships — you draft the
 * notes, then deploy — and without the bound the running build would announce
 * a version of itself that does not exist yet, then never mention it again
 * when it actually lands.
 */
export function entriesNewerThan(previous, upTo = null, entries = CHANGELOG) {
  return entries
    .filter((entry) => previous == null || compareVersions(entry.version, previous) > 0)
    .filter((entry) => upTo == null || compareVersions(entry.version, upTo) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}
