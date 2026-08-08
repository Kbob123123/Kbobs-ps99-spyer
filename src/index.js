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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[interaction] Error running /${interaction.commandName}:`, err);
    const payload = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

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

client.once('ready', () => {
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

client.login(process.env.DISCORD_TOKEN);
