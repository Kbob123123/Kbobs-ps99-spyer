import 'dotenv/config';
import { REST, Routes } from 'discord.js';

/**
 * Remove the GUILD copy of the commands, leaving the global set alone.
 *
 * deploy-commands registers globally and then adds a guild copy, because the
 * global set can take an hour to propagate and the owner's own server should
 * not have to wait. Discord shows both, so that one server sees every command
 * listed twice — working as designed, but only wanted while iterating.
 *
 * Run this once the global set has appeared (~1h after deploying) and the
 * duplicates disappear, because only the global registration is left.
 *
 * This does NOT touch global commands, so it can never remove the bot's
 * commands from other servers. That has bitten before: an earlier version of
 * deploy-commands registered to the guild and wiped global, which silently
 * removed every command everywhere else.
 */
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID ?? process.argv[2];

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID must both be set.');
  process.exit(1);
}
if (!guildId) {
  console.error('No guild id. Set DISCORD_GUILD_ID, or pass one: npm run clear-guild-commands -- <guildId>');
  process.exit(1);
}

const rest = new REST().setToken(token);

try {
  console.log(`Clearing guild command copies in ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
  console.log('Done. Global commands are untouched — the duplicates should disappear shortly.');
} catch (err) {
  console.error('Failed to clear guild commands:', err);
  process.exit(1);
}
