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
    for (const guildId of guildIds) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log(`[deploy] ✅ Registered to guild ${guildId}.`);
      } catch (err) {
        if (err.code === 50001) {
          console.log(`[deploy] ⚠️  Skipped guild ${guildId} — the bot isn't in that server.`);
        } else {
          console.error(`[deploy] ❌ Failed for guild ${guildId}:`, err.message);
        }
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
