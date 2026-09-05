import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { isOwner, OWNER_ID } from '../lib/owner.js';

/**
 * Posts a running demo of the bot's features into the channel — several
 * messages, each showing what one real command's output actually looks like.
 * Built for sales/ticket use: run it once in a channel and it speaks for
 * itself, rather than the owner describing features in prose.
 *
 * Every embed here uses clearly-labelled EXAMPLE data — real pet/item names,
 * but made-up prices and counts — so it never claims to be a live reading.
 */
export const data = new SlashCommandBuilder()
  .setName('showcase')
  .setDescription("Post a running demo of what this bot does, one message at a time.");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({
      content: `🔒 This command is restricted to the bot owner.\n_Configured owner ID: \`${OWNER_ID}\`._`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({ content: '📽️ Posting the showcase below…', ephemeral: true });

  for (const embed of buildShowcaseEmbeds()) {
    await interaction.channel.send({ embeds: [embed] }).catch((err) => {
      console.error('[showcase] Could not post an embed:', err.message);
    });
    await sleep(400);
  }
}

const EXAMPLE_FOOTER = 'Example output for demonstration — not live data.';

function buildShowcaseEmbeds() {
  return [
    new EmbedBuilder()
      .setTitle('🚀 What this bot does')
      .setColor(0x3987e5)
      .setDescription(
        'Watches PS99 hatch rates and RAP — lookups for pets, eggs, potions and more, with history ' +
          'charts, plus alerts for new pets, game updates and price swings.\n\n' +
          'The next several messages show real command output, with example data.'
      ),

    new EmbedBuilder()
      .setTitle('🔎 Huge Cosmic Axolotl')
      .setColor(0x3987e5)
      .setDescription('💎 **12,400,000** RAP · 342 exist')
      .setFooter({ text: `/exists & /rap — pet and item lookup, exact figures from the game's own API · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('🥚 Exclusive Cosmic Egg')
      .setColor(0x3987e5)
      .setDescription(
        'Exact drop odds from the game\'s own weight table — not an estimate.\n\n' +
          '**Cosmic Axolotl** — 63.6900% _(1 in 1.57)_\n' +
          '**Cosmic Dragon** — 44.5100% _(1 in 2.25)_\n' +
          '**Huge Cosmic Axolotl** — 1.5900% _(1 in 62.89)_\n' +
          '**Titanic Cosmic Pegasus** — 0.0636% _(1 in 1,572.33)_'
      )
      .setFooter({ text: `/eggodds <egg> — real pet drop odds · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('💰 Cheapest Huges')
      .setColor(0xc98500)
      .setDescription(
        '**Huge Cyber Bunny** — 💎 850,000 · 1,204 exist\n' +
          '**Huge Cosmic Agony** — 💎 1,120,000 · 980 exist\n' +
          '**Huge Tiedye Cat** — 💎 1,340,000 · 875 exist'
      )
      .setFooter({ text: `/cheaphuges, /cheaptitanics, /cheapgargs — cheapest by RAP right now · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('🚀 Next update')
      .setColor(0x3987e5)
      .setDescription('Due <t:1735776000:R>.\n\n_A fixed weekly target, not a guarantee._')
      .setFooter({ text: `/nextupdate — countdown to the next expected update · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('🚀 GAME UPDATE')
      .setColor(0x2ee6c5)
      .setDescription(
        '**[FROSTBOUND DEPTHS]** just went live — new pets, eggs and enchants shipped with it, ' +
          'posted automatically to whichever channel you point `/setalertchannel` at.'
      )
      .setFooter({ text: `Automatic game update & new item alerts · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('📉 RAP crash — Huge Wireframe Dog')
      .setColor(0xed4245)
      .setDescription(
        'Dropped **38%** in the last hour (2,100,000 → 1,302,000). One alert when it crashes, ' +
          'silence while it stays down, a fresh alert only if it recovers and falls again.'
      )
      .setFooter({ text: `Automatic RAP crash alerts · ${EXAMPLE_FOOTER}` }),

    new EmbedBuilder()
      .setTitle('🔐 Owner console')
      .setColor(0x5865f2)
      .setDescription(
        'One console for everything owner-side: approve/block servers with an optional expiry, ' +
          'block specific commands/users/roles per server, and a full command log — all from ' +
          '`/ownermenu`.'
      )
      .setFooter({ text: EXAMPLE_FOOTER }),
  ];
}
