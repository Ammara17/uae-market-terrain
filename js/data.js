// Loads data/stocks.json and derives the per-period metrics every view shares.

export const RANGES = [
  { id: "1M", label: "1M", days: 21 },
  { id: "3M", label: "3M", days: 63 },
  { id: "6M", label: "6M", days: 126 },
  { id: "YTD", label: "YTD" },
  { id: "1Y", label: "1Y", days: 252 },
];

export async function loadData() {
  // A build can inline the dataset as window.__UAE_DATA__ so the page also works from file://.
  const raw = window.__UAE_DATA__ ?? (await fetchJson("data/stocks.json"));
  return normalise(raw);
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (err) {
    throw new Error(
      `Could not load ${url}. If you opened index.html straight from disk, serve the folder instead, for example with "python -m http.server".`,
    );
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

function normalise(raw) {
  if (!raw || !Array.isArray(raw.dates) || !Array.isArray(raw.stocks) || raw.dates.length < 2) {
    throw new Error("data/stocks.json is missing its dates or stocks. Re-run scripts/fetch_data.py.");
  }
  const stocks = raw.stocks
    .map((stock) => ({
      ...stock,
      firstIndex: stock.close.findIndex((value) => value != null),
    }))
    .filter((stock) => stock.firstIndex >= 0);
  return { ...raw, stocks, sectors: [...new Set(stocks.map((s) => s.sector))].sort() };
}

export function rangeStartIndex(dates, rangeId) {
  const last = dates.length - 1;
  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1];
  if (range.id === "YTD") {
    const year = dates[last].slice(0, 4);
    const first = dates.findIndex((d) => d.slice(0, 4) === year);
    // Early January: fall back to the last close of the previous year as the base.
    return Math.max(0, Math.min(first - 1 >= 0 ? first - 1 : 0, last - 1));
  }
  return Math.max(0, last - range.days);
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function movingAverage(close, end, window, firstIndex) {
  const from = end - window + 1;
  if (from < firstIndex) return null;
  return mean(close.slice(from, end + 1));
}

function annualisedVolatility(close, end, window, firstIndex) {
  const from = end - window;
  if (from < firstIndex) return null;
  const returns = [];
  for (let i = from + 1; i <= end; i++) returns.push(Math.log(close[i] / close[i - 1]));
  const avg = mean(returns);
  const variance = returns.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function classifyTrend(last, ma20, ma50) {
  if (ma20 == null || ma50 == null) return { id: "na", label: "Short history", text: "Fewer than 50 trading days of prices." };
  if (last > ma50 && ma20 > ma50) {
    return { id: "up", label: "Uptrend", text: "Close is above its 50-day average and the 20-day average is above the 50-day." };
  }
  if (last < ma50 && ma20 < ma50) {
    return { id: "down", label: "Downtrend", text: "Close is below its 50-day average and the 20-day average is below the 50-day." };
  }
  return { id: "mixed", label: "Mixed", text: "The close and its 20-day average sit on opposite sides of the 50-day average." };
}

/**
 * Metrics for one stock between two date indexes (inclusive).
 * Returns null when the stock has fewer than two closes in the window.
 */
export function computeMetrics(stock, start, end) {
  const close = stock.close;
  const volume = stock.volume ?? [];
  const s = Math.max(start, stock.firstIndex);
  if (end - s < 1 || close[end] == null) return null;

  const base = close[s];
  const last = close[end];
  const prev = close[end - 1] ?? base;
  const pct = new Float64Array(end - s + 1);
  let high = -Infinity;
  let low = Infinity;
  let highIdx = s;
  let lowIdx = s;
  let peak = -Infinity;
  let maxDrawdown = 0;
  let volSum = 0;
  let volCount = 0;
  let minPct = 0;
  let maxPct = 0;

  for (let i = s; i <= end; i++) {
    const p = close[i];
    const change = p / base - 1;
    pct[i - s] = change;
    if (change < minPct) minPct = change;
    if (change > maxPct) maxPct = change;
    if (p > high) {
      high = p;
      highIdx = i;
    }
    if (p < low) {
      low = p;
      lowIdx = i;
    }
    if (p > peak) peak = p;
    maxDrawdown = Math.min(maxDrawdown, p / peak - 1);
    if (volume[i] != null && i > s) {
      volSum += volume[i];
      volCount++;
    }
  }

  const ma20 = movingAverage(close, end, 20, stock.firstIndex);
  const ma50 = movingAverage(close, end, 50, stock.firstIndex);

  return {
    start: s,
    end,
    base,
    last,
    prev,
    change: last - base,
    changePct: last / base - 1,
    dayPct: last / prev - 1,
    high,
    low,
    highIdx,
    lowIdx,
    maxDrawdown,
    avgVolume: volCount ? volSum / volCount : null,
    ma20,
    ma50,
    volatility: annualisedVolatility(close, end, 20, stock.firstIndex),
    trend: classifyTrend(last, ma20, ma50),
    pct,
    minPct,
    maxPct,
    listedInRange: stock.firstIndex > start,
  };
}

/** Equal-weight average of each stock's change since the period start, per trading day. */
export function basketPath(items, start, end) {
  const path = [];
  for (let i = start; i <= end; i++) {
    let sum = 0;
    let count = 0;
    for (const { m } of items) {
      if (i < m.start) continue;
      sum += m.pct[i - m.start];
      count++;
    }
    path.push(count ? sum / count : 0);
  }
  return path;
}

/** Sector groups ordered by average change (best first), stocks within by change. */
export function groupBySector(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.stock.sector)) groups.set(item.stock.sector, []);
    groups.get(item.stock.sector).push(item);
  }
  return [...groups.entries()]
    .map(([sector, members]) => ({
      sector,
      items: members.sort((a, b) => b.m.changePct - a.m.changePct),
      avg: mean(members.map((it) => it.m.changePct)),
    }))
    .sort((a, b) => b.avg - a.avg);
}
