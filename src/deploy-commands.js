import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(__dirname, 'commands');

const commands = [];
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
  if (!mod.data) {
    console.warn(`[deploy] Skipping ${file}: no exported data.`);
    continue;
  }
  commands.push(mod.data.toJSON());
}

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error('[deploy] DISCORD_TOKEN and DISCORD_CLIENT_ID must both be set in .env.');
  process.exit(1);
}

const rest = new REST().setToken(token);

try {
  console.log(`[deploy] Registering ${commands.length} commands...`);

  const guildIds = (process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

  if (guildIds.length > 0) {
    // Guild-scoped registration is instant, which makes it the right choice
    // while testing; global registration can take up to an hour to appear.
    let anyGuildSucceeded = false;
    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log(`[deploy] ✅ Registered to guild ${guildId}.`);
        anyGuildSucceeded = true;
      } catch (err) {
        if (err.code === 50001) {
          console.log(`[deploy] ⚠️  Skipped guild ${guildId} — the bot isn't in that server.`);
        } else {
          console.error(`[deploy] ❌ Failed for guild ${guildId}:`, err.message);
        }
      }
    }

    // Guild and global registrations are separate sets, and Discord shows BOTH
    // in the picker — so a leftover global set from an earlier deploy makes
    // every command appear twice. Clearing it is the only way to remove those
    // duplicates. Only safe because this bot is deliberately guild-scoped; if
    // it were ever meant to serve other servers, this would strip its commands
    // from all of them.
    if (anyGuildSucceeded) {
      try {
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        console.log('[deploy] 🧹 Cleared the global command set (duplicates of the guild set).');
      } catch (err) {
        console.warn('[deploy] ⚠️  Could not clear global commands:', err.message);
      }
    }
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('[deploy] ✅ Registered globally — may take up to an hour to appear.');
  }
} catch (err) {
  console.error('[deploy] Failed:', err);
  process.exit(1);
}
