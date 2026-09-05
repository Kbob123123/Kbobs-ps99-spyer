import {
  countWhitelistedGuilds,
  isGuildWhitelisted,
  isCommandBlacklisted,
  isUserBlacklisted,
  isAnyRoleBlacklisted,
} from './db.js';

// Who owns this bot. Read from the environment rather than hardcoded so a
// wrong value is a one-variable fix instead of a redeploy — which matters
// here, because getting it wrong locks the owner out of /ownermenu, the very
// command needed to fix anything else.
export const OWNER_ID = (process.env.OWNER_ID || '748792473794641921').trim();

export function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

/**
 * Whether a command may run.
 *
 * Returns { allowed: true } or { allowed: false, reason } with a message meant
 * to be shown to the user.
 *
 * DENY BY DEFAULT: a server has to be on the whitelist. An empty whitelist
 * therefore allows nothing rather than everything — being in a server is not
 * the same as being wanted there.
 *
 * The owner is never blocked, by their user ID rather than by which server
 * they are in, so an empty or misconfigured whitelist can never lock them out
 * of /ownermenu — the one command needed to fix it.
 *
 * Beyond the whitelist, three more checks narrow what's allowed WITHIN an
 * already-approved guild: a command blacklist (some commands disabled here),
 * a user blacklist (this person specifically blocked), and a role blacklist
 * (anyone holding a flagged role blocked). All three are per-guild and only
 * ever reached once the guild itself has passed the whitelist check.
 */
export function checkAccess({ commandName, guildId, userId, roleIds = [] }) {
  if (isOwner(userId)) return { allowed: true };

  // A DM has no guild to check. Only the owner gets to use the bot there;
  // otherwise a blocked server could just DM the bot instead.
  if (!guildId) {
    return {
      allowed: false,
      reason: '🔒 This bot only works in servers its owner has approved.',
    };
  }

  if (!isGuildWhitelisted(guildId)) {
    return {
      allowed: false,
      reason:
        "🔒 This server isn't approved to use this bot.\n" +
        "Ask the bot owner to add it — they'll need this server's ID: " +
        `\`${guildId}\`.`,
    };
  }

  if (isUserBlacklisted(guildId, userId)) {
    return { allowed: false, reason: "🔒 You've been blocked from using this bot in this server." };
  }

  if (isAnyRoleBlacklisted(guildId, roleIds)) {
    return { allowed: false, reason: '🔒 A role you hold is blocked from using this bot in this server.' };
  }

  if (commandName && isCommandBlacklisted(guildId, commandName)) {
    return { allowed: false, reason: `🔒 \`/${commandName}\` is disabled in this server.` };
  }

  return { allowed: true };
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
