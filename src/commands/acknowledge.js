import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { isOwner, OWNER_ID } from '../lib/owner.js';

// A one-time terms notice posted in a ticket before access is handed over —
// NOT a whitelist tool. It doesn't grant or touch anything; it just puts the
// consequences of misuse in front of the applicant and records that they
// clicked Accept, so the owner has something to point back to later.
export const data = new SlashCommandBuilder()
  .setName('acknowledge')
  .setDescription('Post the misuse-terms notice for someone applying for access, before handing it over.')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('The applicant — only they can click Accept/Decline').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('note').setDescription('Extra context to show them (optional)').setRequired(false)
  );

export const COMPONENT_PREFIX = 'ackterms:';

export async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: `🔒 This command is restricted to the bot owner.\n_Configured owner ID: \`${OWNER_ID}\`._`,
      ephemeral: true,
    });
    return;
  }

  const applicant = interaction.options.getUser('user', true);
  const note = interaction.options.getString('note');

  const embed = new EmbedBuilder()
    .setTitle('📋 Before you get access')
    .setColor(0xc98500)
    .setDescription(
      `${applicant}, please read this before access is handed over.\n\n` +
        "This isn't a formality — here's what actually happens if it's misused, and it can be done to " +
        'just your server, without touching anyone else who has access:\n\n' +
        '• **A specific command can be switched off** in your server alone.\n' +
        "• **You personally can be blocked** from using the bot, while everyone else in your server keeps working.\n" +
        '• **A role can be blocked outright** — anyone holding it loses access, account age or standing aside.\n' +
        "• **Your server's whole access can be pulled**, immediately, with no notice required.\n" +
        '• **The bot can leave your server outright**, at any time, for any reason.\n\n' +
        (note ? `**Note from the owner:** ${note}\n\n` : '') +
        'Click below to confirm you understand.'
    )
    .setFooter({ text: 'Only the tagged applicant can respond to this.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}accept:${applicant.id}`)
      .setLabel('I accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`${COMPONENT_PREFIX}decline:${applicant.id}`)
      .setLabel('I decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✖️')
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

/**
 * Handle the Accept/Decline click. Gated to the applicant the command named —
 * this sits in a ticket channel other people can see, and letting anyone else
 * click it would make "acknowledged" meaningless.
 */
export async function handleComponent(interaction) {
  const rest = interaction.customId.slice(COMPONENT_PREFIX.length);
  const [verb, applicantId] = rest.split(':');

  if (interaction.user.id !== applicantId) {
    await interaction.reply({ content: "🔒 This isn't addressed to you.", ephemeral: true }).catch(() => {});
    return;
  }

  const accepted = verb === 'accept';
  const original = interaction.message.embeds[0];

  const embed = EmbedBuilder.from(original)
    .setTitle(accepted ? '✅ Terms accepted' : '✖️ Terms declined')
    .setColor(accepted ? 0x57f287 : 0xed4245)
    .setFooter({
      text: `${accepted ? 'Accepted' : 'Declined'} by ${interaction.user.username} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    });

  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
    ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
  );

  await interaction.update({ embeds: [embed], components: [disabledRow] });
}
