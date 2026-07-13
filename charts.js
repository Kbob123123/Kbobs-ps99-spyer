import fetch from 'node-fetch';

// Builds chart images via QuickChart (https://quickchart.io). We use the
// POST /chart/create endpoint, which returns a short fixed-length URL
// (https://quickchart.io/chart/render/<uuid>) instead of building a GET URL
// with the entire Chart.js config JSON-encoded into the query string.
//
// IMPORTANT: the GET-based approach (c=<encoded config> query param) was
// used previously and caused real failures — Discord embed image URLs are
// capped at 2048 characters, and any chart with more than a few data points
// easily exceeded that, causing "BASE_TYPE_MAX_LENGTH" errors on send. The
// /chart/create endpoint avoids this entirely since the config is sent in
// the POST body, not the URL.
//
// All builder functions here are now ASYNC (they make a network call) and
// return null on failure — callers should treat a null return as "no chart
// this time" and skip attaching an image, not as a hard error.

const QUICKCHART_CREATE_URL = 'https://quickchart.io/chart/create';

// Dark theme palette to roughly match the reference screenshots (dark bg,
// bright line colors, light gridlines).
const COLORS = ['#5ee65e', '#4fc3f7', '#f06292', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373'];

async function createChartUrl(chartConfig, { width = 760, height = 380 } = {}) {
  try {
    const res = await fetch(QUICKCHART_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width,
        height,
        devicePixelRatio: 2,
        backgroundColor: '#23272A',
        format: 'png',
        chart: chartConfig,
      }),
    });

    if (!res.ok) {
      console.error('[charts] QuickChart /chart/create returned', res.status);
      return null;
    }

    const json = await res.json();
    if (!json.success || !json.url) {
      console.error('[charts] QuickChart /chart/create response missing url:', JSON.stringify(json).slice(0, 200));
      return null;
    }

    return json.url; // short, fixed-length https://quickchart.io/chart/render/<uuid>
  } catch (err) {
    console.error('[charts] Failed to create chart:', err.message);
    return null;
  }
}

function formatTimeLabel(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Forces the axis to include zero (so a tight value range like 0.1-1
// doesn't render as a misleadingly steep or near-empty-looking chart), and
// uses QuickChart's built-in tickFormat plugin for k/m/b/t-style compact
// number labels (see COMPACT_TICK_PLUGIN below). Pass allowNegative: true
// for datasets that can go negative (e.g. RAP % change) so a hard min:0
// doesn't clip negative bars off-screen — beginAtZero still ensures zero
// is included in the range either way.
function zeroBasedAxis({ allowNegative = false } = {}) {
  const ticks = { fontColor: '#ccc', beginAtZero: true };
  if (!allowNegative) ticks.min = 0;
  return [{ ticks, gridLines: { color: '#444' } }];
}

const COMPACT_TICK_PLUGIN = { tickFormat: { notation: 'compact' } };

// Single-series line chart for one pet's exists (or RAP) count over time.
// series: [{ time, value }, ...] oldest first
export async function buildPetExistsChartUrl(petName, series, { label = 'Exists Over Time', color = COLORS[0] } = {}) {
  if (!series || series.length < 2) return null;

  const labels = series.map((p) => formatTimeLabel(p.time));
  const data = series.map((p) => p.value);

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: petName,
          data,
          borderColor: color,
          backgroundColor: 'rgba(94,230,94,0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      title: { display: true, text: `${petName} — ${label}`, fontColor: '#eee' },
      legend: { display: false },
      plugins: COMPACT_TICK_PLUGIN,
      scales: {
        xAxes: [{ ticks: { fontColor: '#ccc' }, gridLines: { color: '#444' } }],
        yAxes: zeroBasedAxis(),
      },
    },
  };

  return createChartUrl(config);
}

// Multi-series line chart for clan or league points over time.
// series: array of { name, points: [{ time, value }, ...] }
export async function buildMultiSeriesChartUrl(title, series) {
  const withData = series.filter((s) => s.points && s.points.length >= 2);
  if (withData.length === 0) return null;

  // Use the longest series for labels (they should mostly line up since all
  // entries are snapshotted together every 10 min).
  const longest = withData.reduce((a, b) => (a.points.length >= b.points.length ? a : b));
  const labels = longest.points.map((p) => formatTimeLabel(p.time));

  const datasets = withData.map((s, i) => ({
    label: s.name,
    data: s.points.map((p) => p.value),
    borderColor: COLORS[i % COLORS.length],
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.3,
    pointRadius: 2,
  }));

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      title: { display: true, text: title, fontColor: '#eee' },
      legend: { display: true, labels: { fontColor: '#ccc' } },
      plugins: COMPACT_TICK_PLUGIN,
      scales: {
        xAxes: [{ ticks: { fontColor: '#ccc' }, gridLines: { color: '#444' } }],
        yAxes: zeroBasedAxis(),
      },
    },
  };

  return createChartUrl(config);
}

// Horizontal bar chart for a set of {name, value} deltas — used for RAP
// change alerts and exists spike alerts, showing the magnitude of each.
export async function buildDeltaBarChartUrl(title, items, { valueLabel = 'Change' } = {}) {
  if (!items || items.length === 0) return null;

  const sorted = [...items].sort((a, b) => b.value - a.value).slice(0, 10);
  const labels = sorted.map((i) => i.name);
  const data = sorted.map((i) => i.value);
  const colors = data.map((v) => (v >= 0 ? '#5ee65e' : '#e57373'));

  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ label: valueLabel, data, backgroundColor: colors }],
    },
    options: {
      title: { display: true, text: title, fontColor: '#eee' },
      legend: { display: false },
      plugins: COMPACT_TICK_PLUGIN,
      scales: {
        xAxes: zeroBasedAxis({ allowNegative: true }), // value axis for horizontal bars; RAP % change can be negative
        yAxes: [{ ticks: { fontColor: '#ccc' }, gridLines: { color: '#444' } }],
      },
    },
  };

  return createChartUrl(config, { width: 760, height: Math.max(280, sorted.length * 40) });
}
