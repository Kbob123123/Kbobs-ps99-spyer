import { SlashCommandBuilder } from 'discord.js';
import { resolvePetName } from '../lib/ps99Api.js';
import { getAllPetNames } from '../lib/pets.js';
import { buildPetReply } from '../lib/petView.js';

// The pet-only lookup. /exists does the same for a pet and also covers eggs,
// potions, enchants and every other category — this stays because people know
// it, and both now render through buildPetReply so they cannot drift apart.
export const data = new SlashCommandBuilder()
  .setName('pet')
  .setDescription('Look up one pet: exists, RAP, tier, and history charts.')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Pet name (partial is fine)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('name', true).trim();
  if (rawQuery.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const names = await getAllPetNames();
  const resolved = resolvePetName(names, rawQuery);

  if (!resolved) {
    await interaction.editReply(
      `❌ No pet found matching **${rawQuery}**.\n_Looking for an egg, potion or enchant? Try \`/exists\`._`
    );
    return;
  }

  await interaction.editReply(await buildPetReply(resolved));
}
