// Standalone embed builders for the auto-posted Clan/League Top 10 tracker
// feature. Intentionally NOT shared code with commands/clantop10.js or
// commands/league.js — those files were left untouched. This duplicates their
// small rendering logic so the tracker can post the same-look embeds on its
// own schedule without modifying the existing slash commands.

import { EmbedBuilder } from 'discord.js';
import { getClans, getTopLeagues } from './ps99Api.js';
import {
  getClanRate,
  getLeagueRate,
  recordLeagueSnapshot,
  getClanSeries,
  getLeagueSeries,
  estimateHoursToOvertake,
  formatHours,
} from './history.js';
import { formatCompact } from './format.js';
import { resolveThumbnail } from './thumbnails.js';
import { buildMultiSeriesChartUrl } from './charts.js';

export async function buildClanTop10Embed() {
  const clans = await getClans({ page: 1, pageSize: 10, sort: 'Points', sortOrder: 'desc' });
  if (!clans || clans.length === 0) return null;

  const rows = clans.map((clan) => ({
    name: clan.Name,
    points: clan.Points,
    icon: clan.Icon,
    members: clan.Members,
    memberCapacity: clan.MemberCapacity,
    rate: getClanRate(clan.Name),
  }));

  const embed = new EmbedBuilder()
    .setTitle('🏆 Clan Top 10')
    .setColor(0xf1c40f)
    .setFooter({ text: 'Exact trailing-1-hour rates · auto-updates every 10 minutes' })
    .setTimestamp();

  rows.forEach((row, i) => {
    const rank = i + 1;
    const rateText = row.rate
      ? `${row.rate.perHour >= 0 ? '+' : ''}${formatCompact(row.rate.perHour)}/hr`
      : 'gathering data…';

    let overtakeText = '';
    if (i > 0) {
      const next = rows[i - 1];
      if (row.rate && next.rate) {
        const hours = estimateHoursToOvertake(row.points, next.points, row.rate.perHour, next.rate.perHour);
        overtakeText = `\nOvertake #${rank - 1}: ${formatHours(hours)}`;
      }
    }

    embed.addFields({
      name: `#${rank} ${row.name}`,
      value: `${formatCompact(row.points)} pts (${rateText}) · ${row.members ?? '?'}/${row.memberCapacity ?? '?'} members${overtakeText}`,
      inline: false,
    });
  });

  if (rows[0]?.icon) {
    const iconUrl = await resolveThumbnail(rows[0].icon, '150x150');
    if (iconUrl) embed.setThumbnail(iconUrl);
  }

  const series = rows
    .slice(0, 5)
    .map((r) => ({ name: r.name, points: getClanSeries(r.name).map((p) => ({ time: p.time, value: p.points })) }));
  const chartUrl = await buildMultiSeriesChartUrl('Clan Top 5 — Points Over Time', series);
  if (chartUrl) embed.setImage(chartUrl);

  return embed;
}

export async function buildLeagueTop10Embed() {
  const leagues = await getTopLeagues(10);
  if (!leagues || leagues.length === 0) return null;

  const rows = leagues.map((league) => {
    const key = `league:${league.Name}`;
    recordLeagueSnapshot(key, league.Points);
    return {
      name: league.Name,
      points: league.Points,
      icon: league.Icon,
      key,
      rate: getLeagueRate(key),
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('🏅 League Top 10')
    .setColor(0x3498db)
    .setFooter({ text: 'Exact trailing-1-hour rates · auto-updates every 10 minutes' })
    .setTimestamp();

  rows.forEach((row, i) => {
    const rank = i + 1;
    const rateText = row.rate
      ? `${row.rate.perHour >= 0 ? '+' : ''}${formatCompact(row.rate.perHour)}/hr`
      : 'gathering data…';

    let overtakeText = '';
    if (i > 0) {
      const next = rows[i - 1];
      if (row.rate && next.rate) {
        const hours = estimateHoursToOvertake(row.points, next.points, row.rate.perHour, next.rate.perHour);
        overtakeText = `\nOvertake #${rank - 1}: ${formatHours(hours)}`;
      }
    }

    embed.addFields({
      name: `#${rank} ${row.name}`,
      value: `${formatCompact(row.points)} pts (${rateText})${overtakeText}`,
      inline: false,
    });
  });

  if (rows[0]?.icon) {
    const iconUrl = await resolveThumbnail(rows[0].icon, '150x150');
    if (iconUrl) embed.setThumbnail(iconUrl);
  }

  const series = rows.slice(0, 5).map((r) => ({ name: r.name, points: getLeagueSeries(r.key) }));
  const chartUrl = await buildMultiSeriesChartUrl('League Top 5 — Points Over Time', series);
  if (chartUrl) embed.setImage(chartUrl);

  return embed;
}
