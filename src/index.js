import 'dotenv/config';

// node:sqlite is experimental on Node < 26 and prints a warning on startup.
// It's fully functional for our use; this just keeps the logs readable.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning);
});

import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPoll, runHourlyAlerts } from './lib/tracker.js';
import { checkAccess, describeInvocation } from './lib/owner.js';
import { logCommand, isGuildWhitelisted } from './lib/db.js';
import { postCommandLog, postLeaveNotice, postGuildJoinLog } from './lib/commandLog.js';
import {
  COMPONENT_PREFIX as OWNERMENU_PREFIX,
  handleComponent as handleOwnerMenuComponent,
} from './commands/ownermenu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  try {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (mod.data && mod.execute) {
      client.commands.set(mod.data.name, mod);
    } else {
      console.warn(`[commands] Skipping ${file}: missing data/execute export.`);
    }
  } catch (err) {
    // A command file can throw at IMPORT time, not just at runtime:
    // SlashCommandBuilder validates description length the instant
    // .setDescription() is called, which happens during module evaluation for
    // the top-level `export const data = ...` pattern. Without this catch, one
    // oversized description crashes the whole process on every startup — which
    // is exactly what happened to the sibling league bot once.
    console.error(`[commands] FAILED to load ${file} — this command is unavailable:`, err.message);
  }
}

if (client.commands.size === 0) {
  console.error('[commands] No commands loaded — check the errors above.');
}

/**
 * Refuse to stay in a server that isn't approved.
 *
 * Gating commands is not enough on its own: anyone with the invite link can
 * add the bot anywhere, and it would then sit there indefinitely, appear in
 * the member list, and show its commands in the picker. Leaving immediately is
 * what makes the whitelist mean "where this bot runs" rather than just "where
 * its commands succeed".
 */
async function enforceGuildWhitelist(guild, { onStartup = false } = {}) {
  if (isGuildWhitelisted(guild.id)) return false;

  const how = onStartup ? 'Found' : 'Added to';
  console.warn('[whitelist] ' + how + ' unapproved server "' + guild.name + '" (' + guild.id + ') — leaving.');

  await postGuildJoinLog(client, guild, { approved: false, onStartup }).catch(() => {});

  await postLeaveNotice(guild, {
    reason:
      "🔒 **This bot is invite-only.** This server hasn't been approved, so it can't stay.",
  }).catch(() => {});

  await guild.leave().catch((err) => {
    console.error('[whitelist] Could not leave ' + guild.id + ':', err.message);
  });

  return true;
}

client.on('guildCreate', async (guild) => {
  try {
    const left = await enforceGuildWhitelist(guild);
    // Approved joins are logged too, so the owner gets an invite link for
    // every server the bot is in, not only the ones it turned away.
    if (!left) await postGuildJoinLog(client, guild, { approved: true });
  } catch (err) {
    console.error('[whitelist] guildCreate handling failed:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  // Buttons and modals from the owner menu. Routed by custom_id prefix so the
  // menu owns its own component logic instead of this file growing a switch.
  if (interaction.isButton() || interaction.isModalSubmit()) {
    if (!interaction.customId?.startsWith(OWNERMENU_PREFIX)) return;
    try {
      await handleOwnerMenuComponent(interaction);
    } catch (err) {
      console.error('[ownermenu] Component failed:', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  const logBase = {
    guildId: interaction.guildId,
    guildName: interaction.guild?.name ?? null,
    userId: interaction.user.id,
    username: interaction.user.username,
    command: interaction.commandName,
    options: describeInvocation(interaction),
    avatarUrl: interaction.user.displayAvatarURL(),
  };

  // Whitelist check before anything runs. Logged either way — a blocked
  // attempt is exactly the kind of thing the owner wants to see.
  const access = checkAccess({
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });

  if (!access.allowed) {
    safeLog(client, { ...logBase, outcome: 'blocked' });
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
    safeLog(client, { ...logBase, outcome: 'ok' });
  } catch (err) {
    console.error(`[interaction] Error running /${interaction.commandName}:`, err);
    safeLog(client, { ...logBase, outcome: `error: ${err.message}`.slice(0, 200) });
    const payload = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

/** Logging must never be the reason a command fails. */
function safeLog(client, entry) {
  try {
    logCommand(entry);
  } catch (err) {
    console.warn('[log] Could not record command use:', err.message);
  }

  postCommandLog(client, entry).catch(() => {});
}

const POLL_INTERVAL_MS = (Number(process.env.POLL_INTERVAL_MINUTES) || 10) * 60 * 1000;
let pollInFlight = false;

async function runPollTick() {
  if (pollInFlight) {
    console.warn('[tracker] Previous poll still running; skipping this tick.');
    return;
  }
  pollInFlight = true;
  try {
    await runPoll(client);
  } catch (err) {
    console.error('[tracker] Unexpected top-level error:', err);
  } finally {
    pollInFlight = false;
  }
}

// Alerts run on their own fixed hourly cadence, independent of
// POLL_INTERVAL_MINUTES. Both alert types compare windows measured in hours,
// so evaluating them on every 10-minute poll would re-send the same alert for
// the same unchanged window six times an hour.
const ALERT_INTERVAL_MS = 60 * 60 * 1000;
let alertsInFlight = false;

async function runAlertTick() {
  if (alertsInFlight) {
    console.warn('[tracker] Previous alert pass still running; skipping this tick.');
    return;
  }
  alertsInFlight = true;
  try {
    await runHourlyAlerts(client);
  } catch (err) {
    console.error('[tracker] Alert pass failed:', err);
  } finally {
    alertsInFlight = false;
  }
}

client.once('ready', async () => {
  // Sweep servers joined while the bot was offline, or before the whitelist
  // existed. Without this the whitelist only ever applies to future invites
  // and everything already joined stays forever.
  let left = 0;
  for (const guild of [...client.guilds.cache.values()]) {
    try {
      if (await enforceGuildWhitelist(guild, { onStartup: true })) left += 1;
    } catch (err) {
      console.error('[whitelist] Startup sweep failed for ' + guild.id + ':', err.message);
    }
  }
  console.log('[whitelist] ' + client.guilds.cache.size + ' approved server(s) remain' + (left > 0 ? '; left ' + left + ' unapproved.' : '.'));

  console.log(`Logged in as ${client.user.tag}.`);
  console.log(`Polling every ${POLL_INTERVAL_MS / 60000} minute(s); alerts checked hourly.`);
  setInterval(runPollTick, POLL_INTERVAL_MS);
  // Take a baseline reading shortly after startup rather than waiting a full
  // interval — history can't start accumulating until the first poll runs.
  setTimeout(runPollTick, 15_000);

  setInterval(runAlertTick, ALERT_INTERVAL_MS);
  // Stagger the first alert pass past the first poll so it has a reading to
  // work with, rather than racing it.
  setTimeout(runAlertTick, 90_000);
});

// Check the token's shape before handing it to discord.js. Without this, a
// missing or malformed token surfaces as a DiscordjsError [TokenInvalid] stack
// trace, and because the restart policy retries, the logs fill with ten copies
// of it — which reads like a code fault when it's really a config one.
const token = process.env.DISCORD_TOKEN?.trim();

if (!token) {
  console.error(
    '[startup] DISCORD_TOKEN is not set.\n' +
      '  Railway: Variables tab -> add DISCORD_TOKEN.\n' +
      '  Locally: copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

// A bot token is three dot-separated segments. The most common mistakes are
// pasting the Application ID (digits only, no dots) or leaving quotes around
// the value, and both are caught here.
if (token.split('.').length !== 3) {
  console.error(
    '[startup] DISCORD_TOKEN does not look like a bot token.\n' +
      '  Expected three dot-separated parts.\n' +
      (/^\d+$/.test(token)
        ? '  That value is all digits — it looks like the Application ID, not the token.\n'
        : '') +
      (/^["']|["']$/.test(token) ? '  Remove the surrounding quotes.\n' : '') +
      '  Get a fresh one from the Developer Portal: your app -> Bot -> Reset Token.'
  );
  process.exit(1);
}

client.login(token).catch((err) => {
  if (err.code === 'TokenInvalid') {
    console.error(
      '[startup] Discord rejected this token.\n' +
        '  It is usually stale — resetting a token in the Developer Portal\n' +
        "  immediately invalidates the old one, so Railway's copy must be updated too."
    );
    process.exit(1);
  }
  throw err;
});
