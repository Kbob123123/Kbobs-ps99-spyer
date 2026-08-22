import { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } from 'discord.js';
import { capToFieldLimit } from '../lib/format.js';

// Discord application command option types. Anything above 2 is a real
// argument; 1 and 2 are subcommands and subcommand groups.
const TYPE_SUBCOMMAND = 1;
const TYPE_SUBCOMMAND_GROUP = 2;

// Which commands belong under which heading. Anything not listed here still
// shows up, under "Other" — so adding a command file and forgetting to touch
// this map degrades to a slightly untidy /help rather than a missing entry.
const CATEGORIES = [
  { name: '🔎 Look things up', commands: ['exists', 'rap'] },
  {
    name: '💰 Cheapest by RAP',
    commands: ['cheaphuges', 'cheaptitanics', 'cheapgargs'],
  },
  { name: '🔔 Alerts & channels', commands: ['setratechannel', 'setalertchannel'] },
  { name: '🔧 Setup', commands: ['spyerconfig', 'spyeralerts', 'botupdchannel'] },
  { name: 'ℹ️ Meta', commands: ['help'] },
  { name: '🔐 Owner only', commands: ['ownermenu'] },
];

const BLURB =
  'Watches PS99 hatch rates and RAP — lookups for pets, eggs, potions and more ' +
  'with history charts, plus alerts for new pets, game updates and price swings.';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List every command and what it does.')
  .addStringOption((opt) =>
    opt.setName('command').setDescription('Show full detail for one command, e.g. pet')
  );

export async function execute(interaction) {
  // Ephemeral: help is for the person who asked, and a full command list is
  // noisy enough that posting it publicly in an alert channel is a nuisance.
  await interaction.deferReply({ ephemeral: true });

  const commands = collectCommands(interaction.client);
  const requested = interaction.options.getString('command')?.trim().toLowerCase().replace(/^\//, '');

  if (requested) {
    const match = commands.find((c) => c.name === requested);
    if (!match) {
      await interaction.editReply(
        `❌ There's no \`/${requested}\` command. Run \`/help\` with no argument to see all ${commands.length}.`
      );
      return;
    }
    await interaction.editReply({ embeds: [buildDetailEmbed(match)] });
    return;
  }

  await interaction.editReply({ embeds: [buildOverviewEmbed(commands)] });
}

/**
 * Every loaded command, as plain JSON, sorted by name.
 *
 * Read from the live client rather than a hardcoded list so /help cannot drift
 * out of sync with what's actually registered — the whole failure mode of a
 * handwritten help text.
 */
function collectCommands(client) {
  return [...client.commands.values()]
    .map((mod) => mod.data.toJSON())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when a command is gated behind Manage Server at the Discord level. */
function isRestricted(command) {
  // default_member_permissions is a decimal string, or null for "everyone".
  if (!command.default_member_permissions) return false;
  return new PermissionsBitField(BigInt(command.default_member_permissions)).has(
    PermissionsBitField.Flags.ManageGuild
  );
}

function subcommandsOf(command) {
  return (command.options ?? []).filter((o) => o.type === TYPE_SUBCOMMAND);
}

/** `/setalertchannel <type> [channel]` */
function usageLine(commandName, subName, node) {
  const args = (node.options ?? [])
    .filter((o) => o.type !== TYPE_SUBCOMMAND && o.type !== TYPE_SUBCOMMAND_GROUP)
    .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));
  return ['/' + commandName, subName, ...args].filter(Boolean).join(' ');
}

function buildOverviewEmbed(commands) {
  const embed = new EmbedBuilder()
    .setTitle('📖 PS99 Spyer — commands')
    .setColor(0x3987e5)
    .setDescription(`${BLURB}\n\n**${commands.length}** commands. Run \`/help command:<name>\` for full detail on one.`)
    .setTimestamp();

  const byName = new Map(commands.map((c) => [c.name, c]));
  const placed = new Set();

  for (const category of CATEGORIES) {
    const lines = [];
    for (const name of category.commands) {
      const command = byName.get(name);
      if (!command) continue; // listed here but not actually loaded — skip quietly
      placed.add(name);
      lines.push(describeBriefly(command));
    }
    if (lines.length > 0) {
      embed.addFields({ name: category.name, value: capToFieldLimit(lines), inline: false });
    }
  }

  // Anything the category map doesn't know about.
  const uncategorised = commands.filter((c) => !placed.has(c.name));
  if (uncategorised.length > 0) {
    embed.addFields({
      name: '📦 Other',
      value: capToFieldLimit(uncategorised.map(describeBriefly)),
      inline: false,
    });
  }

  embed.setFooter({ text: '🔒 = needs the Manage Server permission' });
  return embed;
}

function describeBriefly(command) {
  const lock = isRestricted(command) ? ' 🔒' : '';
  const subs = subcommandsOf(command);
  const suffix = subs.length > 0 ? ` _(${subs.map((s) => s.name).join(', ')})_` : '';
  return `**/${command.name}**${lock}${suffix}\n${command.description}`;
}

function buildDetailEmbed(command) {
  const embed = new EmbedBuilder()
    .setTitle(`/${command.name}`)
    .setColor(0x3987e5)
    .setDescription(command.description + (isRestricted(command) ? '\n\n🔒 Needs the **Manage Server** permission.' : ''))
    .setTimestamp();

  const subs = subcommandsOf(command);

  if (subs.length === 0) {
    embed.addFields({ name: 'Usage', value: '`' + usageLine(command.name, null, command) + '`' });
    const options = describeOptions(command);
    if (options) embed.addFields({ name: 'Options', value: options });
    return embed;
  }

  for (const sub of subs) {
    const options = describeOptions(sub);
    const value = [
      '`' + usageLine(command.name, sub.name, sub) + '`',
      sub.description,
      options,
    ]
      .filter(Boolean)
      .join('\n');
    embed.addFields({ name: `/${command.name} ${sub.name}`, value: capToFieldLimit([value]) });
  }

  return embed;
}

/** One line per argument: name, whether it's required, and any fixed choices. */
function describeOptions(node) {
  const options = (node.options ?? []).filter(
    (o) => o.type !== TYPE_SUBCOMMAND && o.type !== TYPE_SUBCOMMAND_GROUP
  );
  if (options.length === 0) return null;

  const lines = options.map((o) => {
    const choices = o.choices?.length ? ` _(${o.choices.map((c) => c.value).join(' / ')})_` : '';
    return `\`${o.name}\`${o.required ? '' : ' _(optional)_'} — ${o.description}${choices}`;
  });

  return capToFieldLimit(lines);
}
