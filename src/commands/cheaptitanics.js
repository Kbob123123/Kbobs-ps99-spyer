import { SlashCommandBuilder } from 'discord.js';
import { addCheapOptions, runCheapCommand } from '../lib/cheapPets.js';

export const data = addCheapOptions(
  new SlashCommandBuilder()
    .setName('cheaptitanics')
    .setDescription('The cheapest Titanic pets by RAP, optionally filtered to one variant.')
);

export async function execute(interaction) {
  await runCheapCommand(interaction, 'titanic');
}
