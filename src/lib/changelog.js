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
