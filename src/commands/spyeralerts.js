import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setChannelEnabled, setAllChannelsEnabled, getGuildChannels } from '../lib/db.js';

/**
 * Silence the bot's alerts without losing where they were pointed.
 *
 * /setalertchannel with no channel already removes a setting, but that is
 * deletion, not muting: coming back means remembering every channel and
 * re-entering all of them. This flips a flag and leaves the configuration
 * intact, which is what "turn it off for now" actually means.
 */

const TYPE_LABELS = {
  // The three hourly rate boards live in the same table, so "pause
  // everything" covers them too and they need labels for the summary.
  huge: 'Huge hatch rates',
  titanic: 'Titanic hatch rates',
  gargantuan: 'Gargantuan hatch rates',
  exists: 'Hatch rate spikes & drops',
  rap: 'RAP swings & crashes',
  store: 'Shop leaks',
  newitem: 'New items',
  firsthatch: 'World-first hatches',
  game: 'Game updates & restarts',
  economy: 'Diamond economy',
  leaderboard: 'Leaderboard payouts',
};

export const data = new SlashCommandBuilder()
  .setName('spyeralerts')
  .setDescription('Pause or resume this server\'s alerts without losing the channels.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName('action')
      .setDescription('Pause or resume')
      .setRequired(true)
      .addChoices({ name: 'Pause', value: 'pause' }, { name: 'Resume', value: 'resume' })
  )
  .addStringOption((opt) =>
    opt
      .setName('type')
      .setDescription('Which alert. Omit to apply to every alert in this server.')
      .addChoices(
        { name: 'Hatch rate spikes & drops', value: 'exists' },
        { name: 'RAP swings & crashes', value: 'rap' },
        { name: 'Shop leaks', value: 'store' },
        { name: 'New items', value: 'newitem' },
        { name: 'World-first hatches', value: 'firsthatch' },
        { name: 'Game updates & restarts', value: 'game' },
        { name: 'Diamond economy', value: 'economy' },
        { name: 'Leaderboard payouts', value: 'leaderboard' },
        { name: 'Huge hatch rates', value: 'huge' },
        { name: 'Titanic hatch rates', value: 'titanic' },
        { name: 'Gargantuan hatch rates', value: 'gargantuan' }
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const action = interaction.options.getString('action', true);
  const type = interaction.options.getString('type');
  const enable = action === 'resume';

  if (type) {
    const changed = setChannelEnabled(interaction.guildId, type, enable);
    const label = TYPE_LABELS[type] ?? type;

    if (!changed) {
      await interaction.editReply(
        `ℹ️ **${label}** is not set up here, so there is nothing to ${action}.\n` +
          `_Point it at a channel first with_ \`/setalertchannel\`_._`
      );
      return;
    }

    await interaction.editReply(
      enable ? `▶️ Resumed **${label}**.` : `⏸️ Paused **${label}** — the channel is remembered.`
    );
    return;
  }

  const count = setAllChannelsEnabled(interaction.guildId, enable);

  if (count === 0) {
    await interaction.editReply(
      'ℹ️ No alerts are set up in this server yet. Use `/setalertchannel` to add one.'
    );
    return;
  }

  // Report what is actually configured, so "paused everything" is verifiable
  // rather than something you have to take on trust.
  const rows = getGuildChannels(interaction.guildId);
  const list = rows.map((r) => `• ${TYPE_LABELS[r.kind] ?? r.kind} — <#${r.channel_id}>`).join('\n');

  await interaction.editReply(
    (enable
      ? `▶️ Resumed **${count}** alert(s):\n`
      : `⏸️ Paused **${count}** alert(s). Channels are remembered — \`/spyeralerts action:resume\` brings them back.\n`) + list
  );
}
