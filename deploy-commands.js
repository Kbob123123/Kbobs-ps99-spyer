import { REST, Routes } from 'discord.js';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import 'dotenv/config';

const commandsPath = path.join(process.cwd(), 'commands');
const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

const commands = [];
for (const file of commandFiles) {
  const mod = await import(pathToFileURL(path.join(commandsPath, file)).href);
  commands.push(mod.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  console.log(`Deploying ${commands.length} slash commands...`);

  if (process.env.GUILD_ID) {
    const guildIds = process.env.GUILD_ID.split(',');

    for (const guildId of guildIds) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(
            process.env.CLIENT_ID,
            guildId.trim()
          ),
          { body: commands }
        );

        console.log(`✅ Deployed to guild ${guildId.trim()}.`);
      } catch (err) {
        if (err.code === 50001) {
          console.log(
            `⚠️ Skipping guild ${guildId.trim()} (bot is not in this server).`
          );
        } else {
          console.error(
            `❌ Failed to deploy to guild ${guildId.trim()}:`,
            err
          );
        }
      }
    }

    console.log('✅ Guild deployment complete.');
  } else {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('✅ Deployed globally — may take up to 1 hour to appear.');
  }
} catch (err) {
  console.error('Failed to deploy commands:', err);
}