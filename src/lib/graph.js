import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatNumber, displayName } from './format.js';
import {
  HOUSE,
  fullNumber,
  loadWatermark,
  backdropPlugin,
  watermarkPlugin,
  titlePlugin,
  legendBoxPlugin,
  footnotePlugin,
  processTimeNote,
  houseScales,
  housePadding,
} from './chartTheme.js';
import { resolveThumbnail } from './thumbnails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// The house surface, shared with the clan and league bots.
//
// NOTE for the tier palette below: those colours were validated against the
// OLD #2b2d31 surface. The house surface is darker (#17181b), which only
// increases their contrast against the background, so every pass still passes.
// The pair-separation checks are surface-independent and are unaffected.
export const SURFACE = HOUSE.SURFACE;

// Ink tokens. Text never wears a series colour: the coloured mark beside a
// label carries identity, the text stays neutral so it reads as text.
const INK = HOUSE.INK;
const INK_MUTED = HOUSE.INK_MUTED;

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

/**
 * chartjs-node-canvas is imported LAZILY and never at module scope.
 *
 * It pulls in `canvas`, a native module that dlopen()s the cairo/pango stack
 * at require() time. On a host missing any of those shared libraries (the
 * classic one is `libuuid.so.1`) a top-level import throws while this module
 * is still evaluating, which takes down every command that imports this file —
 * including ones that draw no chart at all. Charts are decoration; the numbers
 * are the product, so a missing library costs an image, not a command.
 *
 * Cached as a promise so the failure warning is logged once, not per render.
 */
let ctorPromise = null;

function getChartCtor() {
  if (!ctorPromise) {
    ctorPromise = import('chartjs-node-canvas')
      .then((m) => m.ChartJSNodeCanvas)
      .catch((err) => {
        console.warn(
          `[graph] Chart rendering unavailable (${err.message}). ` +
            'Embeds will post without images; everything else works normally.'
        );
        return null;
      });
  }
  return ctorPromise;
}

/**
 * Render a chart at a specific size, or null if this host can't render.
 *
 * Size is per-chart rather than global because the tier bar chart grows with
 * the number of pets it plots.
 */
async function render(width, height, config) {
  const ChartJSNodeCanvas = await getChartCtor();
  if (!ChartJSNodeCanvas) return null;

  try {
    const canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: SURFACE,
      // Minimal Linux containers often ship no fonts at all, which silently
      // renders every label as an empty box. Bundling a font and registering
      // it here makes output host-independent.
      chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'DejaVu Sans';
        ChartJS.defaults.color = INK_MUTED;
      },
    });
    canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans.ttf'), { family: 'DejaVu Sans', weight: 'normal' });
    canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), { family: 'DejaVu Sans', weight: 'bold' });

    return await canvas.renderToBuffer(config);
  } catch (err) {
    console.warn('[graph] Render failed:', err.message);
    return null;
  }
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
export async function renderTierRateChart(tier, tierLabel, items, { art } = {}) {
  if (!items || items.length === 0) return null;
  const startedAt = Date.now();

  const rows = items.slice(0, 12);
  // Bar thickness is fixed rather than stretched to fill, so a chart of 3 pets
  // doesn't render three enormous slabs. The extra 60px is the house title
  // strip and footnote row, which need reserved space above and below.
  const height = Math.max(280, 130 + rows.length * 30);
  const color = TIER_COLORS[tier] ?? EXISTS_COLOR;

  // The tier's leading pet is the subject of the chart, so its art is the
  // watermark. Falls back to nothing, which renders a plain plot.
  const watermark = await loadWatermark(await resolveThumbnail(art));

  const buffer = await render(900, height, {
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
      // Title strip above, footnote row below — both painted by house plugins
      // into this reserved space.
      layout: { padding: { top: 62, right: 78, bottom: 26, left: 16 } },
      plugins: {
        // Drawn by the house plugins instead, so Chart.js's own must be off or
        // they would draw twice, in the wrong style and the wrong place.
        legend: { display: false },
        title: { display: false },
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
    plugins: [
      backdropPlugin(),
      watermarkPlugin(watermark),
      titlePlugin({ title: tierLabel, subtitle: 'Hatched — last hour' }),
      // No legend box. One series, already named by the title, and every bar
      // carries its own value label — a box here only collided with the top
      // bar's number and named something the reader already knew.
      footnotePlugin({
        left: processTimeNote(startedAt),
        right: `${rows.length} of ${items.length} variants`,
      }),
      valueLabelPlugin(rows.map((r) => formatNumber(r.value))),
    ],
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
export async function renderHistoryChart(petLabel, metric, series, { art } = {}) {
  if (!series || series.length < 2) return null;
  const startedAt = Date.now();

  const isExists = metric === 'exists';
  const color = isExists ? EXISTS_COLOR : RAP_COLOR;
  const seriesLabel = isExists ? 'Exists' : 'RAP';

  const watermark = await loadWatermark(await resolveThumbnail(art));

  const buffer = await render(900, 400, {
    type: 'line',
    data: {
      labels: series.map((p) => formatTimeLabel(p.ts)),
      datasets: [
        {
          data: series.map((p) => p.value),
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          // Smooth curve rather than a stepped line. Readings are stored only
          // when a value changes, so a step function is technically the more
          // literal shape — but exists and RAP move continuously in reality,
          // the steps are an artefact of how we sample, and the blocky result
          // was harder to read than the trend it was hiding.
          tension: 0.35,
          pointRadius: series.length > 40 ? 0 : 2,
          pointHoverRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: housePadding({ hasSubtitle: true, hasFootnote: true }) },
      plugins: {
        // Drawn by the house plugins instead — see the bar chart above.
        legend: { display: false },
        title: { display: false },
      },
      // Full numbers on the axis, not compacted: the house rule, and for RAP
      // in particular the digits are exactly what people compare.
      scales: houseScales({ yFormat: fullNumber, xTickLimit: 8 }),
    },
    plugins: [
      backdropPlugin(),
      watermarkPlugin(watermark),
      titlePlugin({ title: petLabel, subtitle: isExists ? 'Exists over time' : 'RAP over time' }),
      legendBoxPlugin([{ label: seriesLabel, color }]),
      footnotePlugin({ left: processTimeNote(startedAt), right: `${series.length} readings` }),
    ],
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
