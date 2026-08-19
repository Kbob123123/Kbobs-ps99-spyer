import { SlashCommandBuilder } from 'discord.js';
import { addCheapOptions, runCheapCommand } from '../lib/cheapPets.js';

export const data = addCheapOptions(
  new SlashCommandBuilder()
    .setName('cheaphuges')
    .setDescription('The cheapest Huge pets by RAP, optionally filtered to one variant.')
);

export async function execute(interaction) {
  await runCheapCommand(interaction, 'huge');
}
