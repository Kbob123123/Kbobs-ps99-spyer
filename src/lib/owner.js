import { countWhitelistedGuilds, isGuildWhitelisted } from './db.js';

// Who owns this bot. Read from the environment rather than hardcoded so a
// wrong value is a one-variable fix instead of a redeploy — which matters
// here, because getting it wrong locks the owner out of /ownermenu, the very
// command needed to fix anything else.
//
// NOTE: the configured default is 16 digits. Discord user IDs are normally
// 17-19, so this may well be a typo. If /ownermenu says you are not the owner,
// that is the first thing to check: set OWNER_ID to the value from Discord's
// "Copy User ID" (Developer Mode must be on).
export const OWNER_ID = (process.env.OWNER_ID || '7487924737941921').trim();

export function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

/**
 * Commands that must work regardless of whitelist state.
 *
 * /ownermenu is here so the owner can never be locked out by their own
 * configuration, and /help so a server that has just been blocked can still
 * see what the bot is and who to ask.
 */
const ALWAYS_ALLOWED = new Set(['ownermenu', 'help']);

/**
 * Whether a command may run.
 *
 * Returns { allowed: true } or { allowed: false, reason } with a message meant
 * to be shown to the user.
 *
 * The empty-whitelist case deliberately allows everything. Treating "no rows"
 * as "deny all" would have taken every server offline the moment this shipped,
 * including the owner's, so enforcement only starts once the owner has
 * explicitly listed at least one guild.
 */
export function checkAccess({ commandName, guildId, userId }) {
  if (isOwner(userId)) return { allowed: true };
  if (ALWAYS_ALLOWED.has(commandName)) return { allowed: true };

  // DMs have no guild to check against; the bot is server-oriented anyway.
  if (!guildId) return { allowed: true };

  if (countWhitelistedGuilds() === 0) return { allowed: true };

  if (isGuildWhitelisted(guildId)) return { allowed: true };

  return {
    allowed: false,
    reason:
      "🔒 This server isn't whitelisted to use this bot.\n" +
      'Ask the bot owner to add it — they need this server\'s ID, which is ' +
      `\`${guildId}\`.`,
  };
}

/** Compact one-line description of a command invocation, for the log. */
export function describeInvocation(interaction) {
  const parts = [];

  const sub = interaction.options.getSubcommand?.(false);
  if (sub) parts.push(sub);

  for (const opt of interaction.options.data ?? []) {
    // Subcommands nest their real arguments one level down.
    const source = opt.options ?? [opt];
    for (const o of source) {
      if (o.value === undefined || o.value === null) continue;
      parts.push(`${o.name}:${String(o.value).slice(0, 40)}`);
    }
  }

  return parts.join(' ');
}
