/**
 * House chart style, shared by all three bots.
 *
 * This file is duplicated verbatim into the league bot and the spyer on
 * purpose (see ROADMAP "Repo layout"). It is the ONE file in the chart stack
 * that is byte-identical across the three, so syncing it is a straight copy —
 * keep it that way and put bot-specific drawing in that bot's graph.js.
 *
 * The style matches the reference bots (CW-Bot / the pet-value bot):
 *
 *   - near-black plot, light grid, bold centred title above the chart
 *   - the subject's artwork watermarked behind the plot, semi-transparent
 *   - a legend box inside the plot, bottom-right
 *   - full numbers on the Y axis (2,050,000,000), never compacted
 *   - a footnote row below the plot, outside it
 *   - bright cyan / green series
 *
 * NOTHING here may import `canvas` or `chartjs-node-canvas` at module scope.
 * Those pull the native cairo/pango stack in at require() time and a missing
 * shared library would take down every command that transitively imports a
 * chart. The watermark loader dynamic-imports `canvas` at first use for
 * exactly that reason — see the long comment in graph.js.
 */

/** Ink and surface tokens. Text never wears a series colour. */
export const HOUSE = {
  // Near-black, a shade under Discord's #2b2d31 so the embed edge stays visible.
  SURFACE: '#17181b',
  PLOT: '#1e1f22',
  INK: '#f2f3f5',
  INK_MUTED: '#9aa0a6',
  INK_FAINT: '#6f757c',
  GRID: 'rgba(255,255,255,0.10)',
  AXIS: 'rgba(255,255,255,0.18)',
  BOX_FILL: 'rgba(0,0,0,0.55)',
  BOX_STROKE: 'rgba(255,255,255,0.14)',
  FONT: 'DejaVu Sans',
};

/**
 * Series palette: bright cyan first, then green, on near-black.
 *
 * Ordered so the first two — the ones a one- or two-series chart actually
 * uses — are the house cyan and green. The rest are for member charts, which
 * can plot up to ten lines, and are spaced around the wheel so no adjacent
 * pair is confusable.
 */
export const SERIES_COLORS = [
  '#2ee6c5', // cyan  — primary
  '#57F287', // green — secondary
  '#FEE75C',
  '#00A8FC',
  '#EB459E',
  '#F4900C',
  '#9B59B6',
  '#ED4245',
  '#1ABC9C',
  '#5865F2',
];

/** Translucent fill matching a series colour, for single-series area charts. */
export function fillFor(color, alpha = 0.15) {
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Full numbers, with thousands separators — the house rule for the Y axis.
 *
 * The reference bots print `2,050,000,000` rather than `2.05b`, and that is
 * deliberate: the compact form loses the digits people are comparing against
 * each other. Compacting is still right for a stat tile, where the number has
 * to fit a fixed box — use `compact()` there.
 */
export function fullNumber(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Short form, for stat tiles and footnotes where width is fixed. */
export function compact(n) {
  const abs = Math.abs(Number(n) || 0);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return String(Math.round(Number(n) || 0));
}

// ---------------------------------------------------------------------------
// Watermark loading
// ---------------------------------------------------------------------------

// url -> Promise<Image|null>. A failed load caches its null so a broken or
// slow art URL is attempted once per process, not once per chart.
const watermarkCache = new Map();
const WATERMARK_CACHE_MAX = 200;
const WATERMARK_TIMEOUT_MS = 4000;

/**
 * Fetch an image for use as a watermark. Returns null on any failure.
 *
 * Never throws: a chart with no artwork behind it is fine, a command that
 * fails because an image 404'd is not.
 */
export async function loadWatermark(url) {
  if (!url) return null;
  if (watermarkCache.has(url)) return watermarkCache.get(url);

  const promise = (async () => {
    try {
      // Dynamic import: `canvas` is the native module, see the file header.
      const { loadImage, createCanvas } = await import('canvas');

      const res = await fetch(url, {
        signal: AbortSignal.timeout(WATERMARK_TIMEOUT_MS),
        headers: { 'User-Agent': 'ps99-bot/1.0' },
      });
      if (!res.ok) return null;

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) return null;

      return feather(await loadImage(buf), createCanvas);
    } catch {
      return null; // art is decoration; never let it break a render
    }
  })();

  if (watermarkCache.size >= WATERMARK_CACHE_MAX) {
    watermarkCache.delete(watermarkCache.keys().next().value);
  }
  watermarkCache.set(url, promise);
  return promise;
}

/**
 * Fade a watermark's edges out to nothing with a radial mask.
 *
 * Roblox art does NOT come back on transparent backgrounds — clan icons ship
 * an opaque dark card, and pet renders ship a light one. Drawn as-is, either
 * paints an obvious rectangle on the plot no matter what opacity or blend
 * mode is used, which reads as a pasted-in screenshot rather than a mark
 * behind the chart. Feathering the alpha to zero at the edges removes the
 * rectangle at the source, so the drawing code downstream stays simple and
 * every art source behaves the same way.
 *
 * Done once at load and cached with the image, not per render.
 */
function feather(image, createCanvas) {
  const w = image.width;
  const h = image.height;
  if (!w || !h) return image;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);

  // Opaque through the middle, transparent by the edge. The inner stop sits at
  // 55% so the subject itself stays intact and only the surrounding card fades.
  const radius = Math.max(w, h) / 2;
  const gradient = ctx.createRadialGradient(w / 2, h / 2, radius * 0.55, w / 2, h / 2, radius);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  return canvas;
}

// Deliberately NO URL-building helper here. Resolving a Roblox avatar or an
// rbxassetid to an image URL needs a batched, throttled, disk-cached API call
// (see robloxAvatars.js / thumbnails.js) — this file stays free of network and
// database concerns so it can remain byte-identical across the three bots.
// Callers hand `loadWatermark` a URL they have already resolved.

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * Paint the whole canvas, then the plot area, before anything else.
 *
 * chartjs-node-canvas's own `backgroundColour` covers the canvas but cannot
 * give the plot area a different shade, and the two-tone surface is what makes
 * the reference charts read as a card rather than a bare graph.
 */
export function backdropPlugin() {
  return {
    id: 'houseBackdrop',
    beforeDraw(chart) {
      const { ctx, chartArea, width, height } = chart;
      ctx.save();
      ctx.fillStyle = HOUSE.SURFACE;
      ctx.fillRect(0, 0, width, height);
      if (chartArea) {
        ctx.fillStyle = HOUSE.PLOT;
        ctx.fillRect(
          chartArea.left,
          chartArea.top,
          chartArea.right - chartArea.left,
          chartArea.bottom - chartArea.top
        );
      }
      ctx.restore();
    },
  };
}

/**
 * The subject's artwork, centred behind the plot at low opacity.
 *
 * Drawn in `beforeDatasetsDraw` so it sits above the grid but under the
 * series — behind the data, never over it. `image` may be null, in which case
 * the plugin does nothing and the chart renders plain.
 */
export function watermarkPlugin(image, { opacity = 0.22, coverage = 0.68 } = {}) {
  return {
    id: 'houseWatermark',
    beforeDatasetsDraw(chart) {
      if (!image) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;

      const areaW = chartArea.right - chartArea.left;
      const areaH = chartArea.bottom - chartArea.top;

      // Fit inside the plot preserving aspect ratio; `coverage` keeps it from
      // filling the whole area, which would read as a background not a mark.
      const scale = Math.min((areaW * coverage) / image.width, (areaH * coverage) / image.height);
      const w = image.width * scale;
      const h = image.height * scale;

      ctx.save();
      // Clip to the plot so a wide image cannot bleed over the axis labels.
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, areaW, areaH);
      ctx.clip();
      ctx.globalAlpha = opacity;
      // 'screen' rather than plain alpha. Clan icons and pet art come back
      // from Roblox as PNGs with an OPAQUE dark backdrop, not transparency,
      // so compositing them normally paints a visible rectangle on the plot.
      // Under 'screen' a near-black pixel leaves the backdrop untouched while
      // the artwork itself still lightens through, so the mark reads as art
      // behind the chart instead of a pasted-on box.
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(image, chartArea.left + (areaW - w) / 2, chartArea.top + (areaH - h) / 2, w, h);
      ctx.restore();
    },
  };
}

/**
 * Bold centred title above the plot, with an optional subtitle under it.
 *
 * Drawn by hand rather than via Chart.js's `title` because the reference
 * style needs the subtitle in a different weight and colour, and needs both
 * to sit in reserved layout padding rather than pushing the plot down.
 */
export function titlePlugin({ title, subtitle } = {}) {
  return {
    id: 'houseTitle',
    afterDraw(chart) {
      if (!title) return;
      const { ctx, width } = chart;
      ctx.save();
      ctx.textAlign = 'center';

      ctx.fillStyle = HOUSE.INK;
      ctx.font = `bold 21px "${HOUSE.FONT}"`;
      ctx.fillText(title, width / 2, 32);

      if (subtitle) {
        ctx.fillStyle = HOUSE.INK_MUTED;
        ctx.font = `13px "${HOUSE.FONT}"`;
        ctx.fillText(subtitle, width / 2, 53);
      }
      ctx.restore();
    },
  };
}

/**
 * Legend box inside the plot, bottom-right.
 *
 * Chart.js's own legend can only sit outside the plot on one of four edges,
 * so the boxed bottom-right legend the reference bots use has to be drawn.
 * `entries` is [{ label, color }].
 */
export function legendBoxPlugin(entries, { corner = 'bottom-right' } = {}) {
  return {
    id: 'houseLegendBox',
    afterDatasetsDraw(chart) {
      if (!entries || entries.length === 0) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;

      const PAD = 9;
      const ROW = 17;
      const SWATCH = 10;
      const GAP = 7;
      const FONT_PX = 12;

      ctx.save();
      ctx.font = `${FONT_PX}px "${HOUSE.FONT}"`;
      const textW = Math.max(...entries.map((e) => ctx.measureText(e.label).width));
      const boxW = PAD * 2 + SWATCH + GAP + textW;
      const boxH = PAD * 2 + ROW * entries.length - (ROW - FONT_PX);

      const margin = 12;
      const x = corner.endsWith('left') ? chartArea.left + margin : chartArea.right - margin - boxW;
      const y = corner.startsWith('top') ? chartArea.top + margin : chartArea.bottom - margin - boxH;

      ctx.fillStyle = HOUSE.BOX_FILL;
      ctx.strokeStyle = HOUSE.BOX_STROKE;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      entries.forEach((entry, i) => {
        const rowY = y + PAD + ROW * i + FONT_PX / 2;
        ctx.fillStyle = entry.color;
        roundRect(ctx, x + PAD, rowY - SWATCH / 2, SWATCH, SWATCH, 2);
        ctx.fill();
        ctx.fillStyle = HOUSE.INK;
        ctx.fillText(entry.label, x + PAD + SWATCH + GAP, rowY);
      });
      ctx.restore();
    },
  };
}

/**
 * A row of stat tiles between the title and the plot.
 *
 * Not part of the reference style — ours, and worth keeping: the numbers
 * travel with the image, so a screenshot of the chart still carries the
 * totals. `tiles` is [{ label, value }]; values should already be `compact()`
 * because each tile is a fixed-width box.
 */
export function statStripPlugin(tiles, { y = 74 } = {}) {
  return {
    id: 'houseStatStrip',
    afterDraw(chart) {
      if (!tiles || tiles.length === 0) return;
      const { ctx, width } = chart;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      const tileWidth = Math.min(132, (width - 48) / tiles.length);
      let x = (width - tiles.length * tileWidth) / 2;

      for (const tile of tiles) {
        ctx.fillStyle = HOUSE.INK_FAINT;
        ctx.font = `10px "${HOUSE.FONT}"`;
        ctx.fillText(String(tile.label).toUpperCase(), x + tileWidth / 2, y);
        ctx.fillStyle = SERIES_COLORS[0];
        ctx.font = `bold 16px "${HOUSE.FONT}"`;
        ctx.fillText(String(tile.value), x + tileWidth / 2, y + 20);
        x += tileWidth;
      }
      ctx.restore();
    },
  };
}

/**
 * Footnote row under the plot, outside it.
 *
 * Left is the house "Process Time: 0.65 Seconds" line; right is whatever the
 * chart wants to qualify itself with (sample count, data source, a
 * hypothetical value). Either may be omitted.
 */
export function footnotePlugin({ left, right } = {}) {
  return {
    id: 'houseFootnote',
    afterDraw(chart) {
      // Resolved at DRAW time, not when the config was built: the process-time
      // note is a thunk so it measures the render it is printed on. Building
      // the string eagerly measured everything before the render and reported
      // 0.00 on any chart that did no prep work.
      const leftText = typeof left === 'function' ? left() : left;
      const rightText = typeof right === 'function' ? right() : right;
      if (!leftText && !rightText) return;

      const { ctx, width, height } = chart;
      ctx.save();
      ctx.fillStyle = HOUSE.INK_FAINT;
      ctx.font = `11px "${HOUSE.FONT}"`;
      ctx.textBaseline = 'alphabetic';
      if (leftText) {
        ctx.textAlign = 'left';
        ctx.fillText(leftText, 18, height - 12);
      }
      if (rightText) {
        ctx.textAlign = 'right';
        ctx.fillText(rightText, width - 18, height - 12);
      }
      ctx.restore();
    },
  };
}

/**
 * `Process Time: 0.65 Seconds`, the house footnote.
 *
 * Returns a thunk, not a string, so `footnotePlugin` can evaluate it at draw
 * time and cover the actual render rather than only the setup before it.
 */
export function processTimeNote(startedAtMs) {
  return () => {
    const seconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
    return `Process Time: ${seconds.toFixed(2)} Seconds`;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * The house axes: no vertical grid, light horizontal grid, muted ticks, and
 * full numbers on Y.
 *
 * `yTickLimit` stays low because full numbers are wide — six 13-character
 * labels is already a lot of ink down the left edge.
 */
export function houseScales({ xTickLimit = 8, yTickLimit = 6, yFormat = fullNumber } = {}) {
  return {
    x: {
      grid: { display: false },
      border: { color: HOUSE.AXIS },
      ticks: {
        color: HOUSE.INK_MUTED,
        font: { size: 11, family: HOUSE.FONT },
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: xTickLimit,
      },
    },
    y: {
      grid: { color: HOUSE.GRID, drawTicks: false },
      border: { display: false },
      ticks: {
        color: HOUSE.INK_MUTED,
        font: { size: 11, family: HOUSE.FONT },
        maxTicksLimit: yTickLimit,
        padding: 6,
        callback: (v) => yFormat(v),
      },
    },
  };
}

/**
 * Layout padding reserving room for the title strip above and the footnote
 * row below. Both are painted into this reserved space by the plugins, so the
 * plot never has to shrink to make room for them at draw time.
 */
export function housePadding({ hasSubtitle = false, hasFootnote = true, hasStats = false } = {}) {
  let top = 50;
  if (hasSubtitle) top = 70;
  if (hasStats) top = hasSubtitle ? 118 : 104;
  return {
    top,
    right: 24,
    bottom: hasFootnote ? 26 : 8,
    left: 10,
  };
}
