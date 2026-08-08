import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCompact, formatNumber, displayName } from './format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// Discord's dark message surface. Every colour below was validated against
// THIS surface, not a generic dark grey — a palette that passes on #1a1a19 can
// fail here.
export const SURFACE = '#2b2d31';

// Ink tokens. Text never wears a series colour: the coloured mark beside a
// label carries identity, the text stays neutral so it reads as text.
const INK = '#e8e8e6';
const INK_MUTED = '#a8a8a4';
const GRID = 'rgba(255,255,255,0.07)';

/**
 * Tier accent colours.
 *
 * Chosen by running the palette validator against #2b2d31 with `--pairs all`,
 * not by eye. The obvious choice — gold/orange/red, matching an escalating
 * heat ramp — FAILS: orange↔gold sit at normal-vision ΔE 4.8 and red↔gold at
 * 13.0, both under the 15 floor, meaning even full-colour-vision readers
 * struggle to tell them apart. Gold → magenta → violet passes every check
 * (worst pair ΔE 19.3) and still reads as an escalating rarity ramp.
 */
export const TIER_COLORS = {
  huge: '#c98500',
  titanic: '#d55181',
  gargantuan: '#9085e9',
};

// Exists and RAP are different measures on different scales, so they are NEVER
// drawn on one pair of axes — they render as two separate charts. These two
// only need to be distinguishable from each other; validated together as an
// adjacent pair (CVD ΔE 19.6, normal-vision 20.9).
const EXISTS_COLOR = '#3987e5';
const RAP_COLOR = '#199e70';

function makeCanvas(width, height) {
  const canvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: SURFACE,
    // Minimal Linux containers (Railway's build image included) often ship no
    // fonts at all, which silently renders every label as an empty box.
    // Bundling a font and registering it here makes output host-independent.
    chartCallback: (ChartJS) => {
      ChartJS.defaults.font.family = 'DejaVu Sans';
      ChartJS.defaults.color = INK_MUTED;
    },
  });
  canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans.ttf'), { family: 'DejaVu Sans', weight: 'normal' });
  canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), { family: 'DejaVu Sans', weight: 'bold' });
  return canvas;
}

/**
 * Horizontal bar chart of the top hatch rates for one tier.
 *
 * Horizontal because the categories are pet names — long, variable-length text
 * that would be unreadable rotated under a vertical axis. One tier per chart
 * means one series, so there is no legend: the title names what's plotted.
 *
 * @param {{name: string, variant: string, value: number}[]} items ranked, highest first
 */
export async function renderTierRateChart(tier, tierLabel, items) {
  if (!items || items.length === 0) return null;

  const rows = items.slice(0, 12);
  // Bar thickness is fixed rather than stretched to fill, so a chart of 3 pets
  // doesn't render three enormous slabs.
  const height = Math.max(220, 70 + rows.length * 30);
  const canvas = makeCanvas(900, height);
  const color = TIER_COLORS[tier] ?? EXISTS_COLOR;

  const buffer = await canvas.renderToBuffer({
    type: 'bar',
    data: {
      labels: rows.map((r) => truncateLabel(displayName(r.name, r.variant))),
      datasets: [
        {
          data: rows.map((r) => r.value),
          backgroundColor: color,
          borderColor: SURFACE,
          // A 2px surface-coloured border is the gap between adjacent bars —
          // it separates them without drawing a visible outline.
          borderWidth: 2,
          borderRadius: 4, // rounded data-end only; the baseline end stays square
          borderSkipped: 'start',
          barThickness: 18,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: false,
      layout: { padding: { top: 12, right: 72, bottom: 8, left: 16 } },
      plugins: {
        legend: { display: false }, // single series — the title says what this is
        title: {
          display: true,
          text: `${tierLabel} hatched — last hour`,
          color: INK,
          font: { size: 16, weight: 'bold' },
          padding: { bottom: 12 },
        },
        // Every bar is directly labelled with its value, so the x-axis is
        // redundant scaffolding and is switched off below.
        datalabels: undefined,
      },
      scales: {
        x: {
          display: false,
          beginAtZero: true,
          grace: '12%', // headroom so the longest bar's label isn't clipped
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: INK, font: { size: 12 } },
        },
      },
    },
    plugins: [valueLabelPlugin(rows.map((r) => formatNumber(r.value)))],
  });

  return buffer;
}

/**
 * Draws the value at the end of each horizontal bar.
 *
 * Chart.js has no built-in data labels and the usual plugin is an extra
 * dependency, so this is a small inline plugin. Labels go in ink, never the
 * bar colour.
 */
function valueLabelPlugin(labels) {
  return {
    id: 'valueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.fillStyle = INK;
      ctx.font = 'bold 12px "DejaVu Sans"';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      meta.data.forEach((bar, i) => {
        if (labels[i] == null) return;
        ctx.fillText(labels[i], bar.x + 8, bar.y);
      });
      ctx.restore();
    },
  };
}

/**
 * Line chart of one metric for one pet over time.
 *
 * Deliberately one metric per chart. Exists counts and RAP differ by orders of
 * magnitude, and putting them on twin y-axes would let their lines cross
 * wherever the two scales happen to land — a visual relationship that is pure
 * artefact. Callers render both and attach two images.
 */
export async function renderHistoryChart(petLabel, metric, series) {
  if (!series || series.length < 2) return null;

  const canvas = makeCanvas(900, 320);
  const isExists = metric === 'exists';
  const color = isExists ? EXISTS_COLOR : RAP_COLOR;
  const title = isExists ? `${petLabel} — exists over time` : `${petLabel} — RAP over time`;

  const buffer = await canvas.renderToBuffer({
    type: 'line',
    data: {
      labels: series.map((p) => formatTimeLabel(p.ts)),
      datasets: [
        {
          data: series.map((p) => p.value),
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          // Readings are stored only when the value changes, so the true shape
          // between two stored points is a flat hold, not a slope. A stepped
          // line states that honestly instead of inventing gradual drift.
          stepped: 'before',
          pointRadius: series.length > 40 ? 0 : 3,
          pointHoverRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      layout: { padding: { top: 10, right: 16, bottom: 6, left: 8 } },
      plugins: {
        legend: { display: false }, // one series; the title names it
        title: {
          display: true,
          text: title,
          color: INK,
          font: { size: 16, weight: 'bold' },
          padding: { bottom: 10 },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: GRID },
          ticks: {
            color: INK_MUTED,
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
          },
        },
        y: {
          grid: { color: GRID, drawTicks: false },
          border: { display: false },
          ticks: {
            color: INK_MUTED,
            font: { size: 11 },
            callback: (v) => formatCompact(v),
            maxTicksLimit: 6,
          },
        },
      },
    },
  });

  return buffer;
}

/**
 * Cap a bar's category label so it can't push past the left edge.
 *
 * Chart.js sizes the y-axis label gutter to the longest label, so one very
 * long name ("Shiny Rainbow Gargantuan ..." plus its variant prefix) both
 * squeezes the plot area and risks clipping. Truncating is the predictable
 * option — the value label and the tier title carry the rest of the meaning.
 */
function truncateLabel(text, max = 26) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatTimeLabel(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
}
