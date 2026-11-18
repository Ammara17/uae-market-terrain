// Wires the filters, summary, 3D stage, detail panel and stock board together.
import { loadData, RANGES, rangeStartIndex, computeMetrics, basketPath } from "./data.js";
import * as fmt from "./format.js";
import { sparkline, PriceChart } from "./charts.js";

const $ = (id) => document.getElementById(id);

const prefs = {
  get(key) {
    try {
      return localStorage.getItem(`uae-terrain:${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`uae-terrain:${key}`, value);
    } catch {
      /* storage unavailable: preferences simply are not remembered */
    }
  },
};

const state = {
  data: null,
  range: RANGES.some((r) => r.id === prefs.get("range")) ? prefs.get("range") : "3M",
  exchange: "ALL",
  sector: "ALL",
  query: "",
  view: prefs.get("view") === "towers" ? "towers" : "ribbons",
  sort: { key: "change", dir: -1 },
  selected: null,
  preferred: null,
  items: [],
  start: 0,
  end: 0,
  sceneKey: "",
};

let terrain = null;
let chart = null;

boot();

async function boot() {
  initTheme();
  try {
    state.data = await loadData();
  } catch (err) {
    showFatal(err);
    return;
  }
  renderChrome();
  bindControls();
  chart = new PriceChart($("d-chart"), { onReadout: renderReadout });

  const fromHash = symbolFromHash();
  const fallback = state.data.stocks.find((s) => s.symbol === "EMAAR") ?? state.data.stocks[0];
  state.selected = fromHash ?? fallback.symbol;
  state.preferred = state.selected;
  update();

  await initTerrain();
  renderStage(Boolean(fromHash));

  window.addEventListener("hashchange", () => {
    const symbol = symbolFromHash();
    if (symbol && symbol !== state.selected) revealAndSelect(symbol);
  });
}

// ------------------------------------------------------------------ theme

function currentTheme() {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initTheme() {
  const saved = prefs.get("theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  const button = $("theme-toggle");
  const label = () => button.setAttribute("aria-label", `Switch to ${currentTheme() === "dark" ? "light" : "dark"} theme`);
  button.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    prefs.set("theme", next);
    label();
  });
  label();
}

function watchTheme(callback) {
  let queued = false;
  const run = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      callback();
    });
  };
  new MutationObserver(run).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", run);
}

// ------------------------------------------------------------------ 3D stage

async function initTerrain() {
  try {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    const { Terrain, readTokens } = await import("./scene.js");
    terrain = new Terrain($("canvas-host"), {
      onHover: showTooltip,
      onSelect: (symbol, options) => select(symbol, options),
    });
    watchTheme(() => terrain.setTheme(readTokens()));
  } catch (err) {
    console.error(err);
    terrain = null;
    $("reset-view").hidden = true;
    $("stage-hint").hidden = true;
    setStageMessage(
      "The 3D view could not start",
      "This browser has WebGL turned off, or the Three.js library did not load. Every stock is still listed in the table below.",
    );
  }
}

function setStageMessage(title, body) {
  const box = $("stage-empty");
  if (!title) {
    box.hidden = true;
    return;
  }
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("span");
  text.textContent = body;
  box.replaceChildren(strong, text);
  box.hidden = false;
}

function renderStage(fly = false) {
  renderLegend();
  if (!terrain) return;
  const empty = state.items.length === 0;
  setStageMessage(empty ? "No stocks match these filters" : null, "Clear the search or choose another sector or exchange.");
  const key = `${state.view}|${state.items.map((it) => it.stock.symbol).join(",")}`;
  terrain.setData({
    items: state.items,
    dates: state.data.dates,
    start: state.start,
    end: state.end,
    view: state.view,
    selected: state.selected,
    refit: key !== state.sceneKey,
  });
  state.sceneKey = key;
  if (fly && state.selected) terrain.setSelected(state.selected, { fly: true });
}

function renderLegend() {
  const items = state.items;
  let maxAbs = 0;
  for (const { m } of items) {
    maxAbs = Math.max(maxAbs, state.view === "towers" ? Math.abs(m.changePct) : Math.max(-m.minPct, m.maxPct));
  }
  $("legend-title").textContent = state.view === "towers" ? "Change over the period" : "Change since period start";
  $("legend-min").textContent = items.length ? fmt.pct(-maxAbs, 0) : "";
  $("legend-max").textContent = items.length ? fmt.pct(maxAbs, 0) : "";
  for (const button of $("view-group").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
  $("stage-hint").textContent =
    state.view === "towers"
      ? "Drag to orbit · Scroll or pinch to zoom · Click a tower to inspect"
      : "Drag to orbit · Scroll or pinch to zoom · Click a ribbon to inspect";
}

function showTooltip(info, clientX, clientY) {
  const tip = $("tooltip");
  if (!info) {
    tip.hidden = true;
    return;
  }
  const { stock, m } = info.item;
  const dates = state.data.dates;
  const close = stock.close[info.index];
  const change = info.tower ? m.changePct : close / m.base - 1;
  const line = (className, content) => {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = content;
    return div;
  };
  tip.replaceChildren(
    line(`tt-value delta ${fmt.direction(change)}`, fmt.pct(change)),
    line("tt-name", `${stock.symbol} · ${stock.name}`),
    line("tt-meta", `AED ${fmt.price(close)} · ${fmt.day(dates[info.index])}`),
    line("tt-meta", `from AED ${fmt.price(m.base)} on ${fmt.day(dates[m.start])}`),
  );
  tip.hidden = false;
  const stage = $("stage").getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = clientX - stage.left + 16;
  let y = clientY - stage.top + 16;
  if (x + w > stage.width - 8) x = clientX - stage.left - w - 16;
  if (y + h > stage.height - 8) y = clientY - stage.top - h - 16;
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

// ------------------------------------------------------------------ controls

function bindControls() {
  const rangeGroup = $("range-group");
  for (const range of RANGES) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.range = range.id;
    button.textContent = range.label;
    rangeGroup.appendChild(button);
  }
  rangeGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]");
    if (!button || button.dataset.range === state.range) return;
    state.range = button.dataset.range;
    prefs.set("range", state.range);
    refresh();
  });

  $("exchange-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-exchange]");
    if (!button || button.dataset.exchange === state.exchange) return;
    state.exchange = button.dataset.exchange;
    refresh();
  });

  const sectorSelect = $("sector-select");
  sectorSelect.replaceChildren(new Option("All sectors", "ALL"), ...state.data.sectors.map((s) => new Option(s, s)));
  sectorSelect.addEventListener("change", () => {
    state.sector = sectorSelect.value;
    refresh();
  });

  let searchTimer = 0;
  $("search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      refresh();
    }, 140);
  });

  $("view-group").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === state.view) return;
    state.view = button.dataset.view;
    prefs.set("view", state.view);
    $("tooltip").hidden = true;
    renderStage();
  });

  $("reset-view").addEventListener("click", () => terrain?.resetView());
  $("sum-top").addEventListener("click", (event) => select(event.currentTarget.dataset.symbol, { fly: true }));
  $("sum-bottom").addEventListener("click", (event) => select(event.currentTarget.dataset.symbol, { fly: true }));

  for (const th of document.querySelectorAll("#board-table th[data-sort]")) {
    th.querySelector("button").addEventListener("click", () => {
      const key = th.dataset.sort;
      const textual = key === "symbol" || key === "name";
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: textual ? 1 : -1 };
      renderTable();
    });
  }
  syncControls();
}

function syncControls() {
  for (const b of $("range-group").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.range === state.range));
  for (const b of $("exchange-group").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.exchange === state.exchange));
  $("sector-select").value = state.sector;
  if ($("search").value !== state.query) $("search").value = state.query;
}

function refresh() {
  syncControls();
  update();
  renderStage();
}

// ------------------------------------------------------------------ data → views

function update() {
  const { data } = state;
  state.end = data.dates.length - 1;
  state.start = rangeStartIndex(data.dates, state.range);
  const query = state.query.trim().toLowerCase();
  state.items = data.stocks
    .filter(
      (s) =>
        (state.exchange === "ALL" || s.exchange === state.exchange) &&
        (state.sector === "ALL" || s.sector === state.sector) &&
        (!query || `${s.symbol} ${s.name} ${s.sector}`.toLowerCase().includes(query)),
    )
    .map((stock) => ({ stock, m: computeMetrics(stock, state.start, state.end) }))
    .filter((item) => item.m);

  // Keep the stock the viewer picked whenever it is visible; otherwise fall back to the top row.
  const visible = (symbol) => state.items.some((it) => it.stock.symbol === symbol);
  if (state.preferred && visible(state.preferred)) state.selected = state.preferred;
  else if (!visible(state.selected)) state.selected = sortedItems()[0]?.stock.symbol ?? null;
  renderSummary();
  renderTable();
  renderDetail();
}

const SORTERS = {
  symbol: (it) => it.stock.symbol,
  name: (it) => it.stock.name,
  last: (it) => it.m.last,
  change: (it) => it.m.changePct,
  day: (it) => it.m.dayPct,
  volume: (it) => it.m.avgVolume ?? -1,
  trend: (it) => ({ up: 3, mixed: 2, na: 1, down: 0 })[it.m.trend.id] * 100 + it.m.changePct,
};

function sortedItems() {
  const { key, dir } = state.sort;
  const value = SORTERS[key] ?? SORTERS.change;
  return [...state.items].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
}

function selectedItem() {
  return state.items.find((it) => it.stock.symbol === state.selected) ?? null;
}

function rangeText() {
  return `${fmt.day(state.data.dates[state.start])} – ${fmt.day(state.data.dates[state.end])}`;
}

function deltaSpan(value, text = fmt.pct(value), extraClass = "") {
  const span = document.createElement("span");
  span.className = `delta ${fmt.direction(value)} ${extraClass}`.trim();
  span.textContent = text;
  return span;
}

function renderSummary() {
  const items = state.items;
  const blank = () => {
    for (const id of ["sum-basket", "sum-breadth", "sum-top-value", "sum-bottom-value"]) $(id).replaceChildren("—");
    for (const id of ["sum-basket-sub", "sum-breadth-sub", "sum-top-sub", "sum-bottom-sub"]) $(id).textContent = "";
    $("sum-basket-spark").replaceChildren();
    $("sum-breadth-bar").replaceChildren();
  };
  if (!items.length) return blank();

  const path = basketPath(items, state.start, state.end);
  const basket = path[path.length - 1];
  $("sum-basket").replaceChildren(deltaSpan(basket));
  $("sum-basket-spark").replaceChildren(sparkline(path, { width: 96, height: 30, label: "Basket trend" }));
  $("sum-basket-sub").textContent = `Average of ${items.length} stocks since ${fmt.day(state.data.dates[state.start])}`;

  const up = items.filter((it) => fmt.direction(it.m.changePct) === "up").length;
  const down = items.filter((it) => fmt.direction(it.m.changePct) === "down").length;
  $("sum-breadth").textContent = `${up} up · ${down} down`;
  const bar = $("sum-breadth-bar");
  const upSpan = document.createElement("span");
  upSpan.className = "up";
  upSpan.style.width = `${(up / items.length) * 100}%`;
  const downSpan = document.createElement("span");
  downSpan.className = "down";
  downSpan.style.width = `${(down / items.length) * 100}%`;
  downSpan.style.marginLeft = "auto";
  bar.replaceChildren(upSpan, downSpan);
  $("sum-breadth-sub").textContent = `${Math.round((up / items.length) * 100)}% of ${items.length} stocks advanced`;

  const byChange = [...items].sort((a, b) => b.m.changePct - a.m.changePct);
  const fill = (prefix, item) => {
    $(`${prefix}-value`).replaceChildren(deltaSpan(item.m.changePct));
    $(`${prefix}-sub`).textContent = `${item.stock.symbol} · ${item.stock.name}`;
    $(prefix).dataset.symbol = item.stock.symbol;
  };
  fill("sum-top", byChange[0]);
  fill("sum-bottom", byChange[byChange.length - 1]);
}

function renderTable() {
  const body = $("board-body");
  const rows = sortedItems();
  const total = state.data.stocks.length;
  $("board-count").textContent = `${rows.length} of ${total} stocks · ${rangeText()} · click a row to inspect it in 3D`;

  for (const th of document.querySelectorAll("#board-table th[data-sort]")) {
    if (th.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  }

  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.className = "empty-row";
    const td = document.createElement("td");
    td.colSpan = 9;
    td.textContent = "No stocks match these filters. Clear the search or choose another sector or exchange.";
    tr.appendChild(td);
    body.replaceChildren(tr);
    return;
  }

  body.replaceChildren(
    ...rows.map((item) => {
      const { stock, m } = item;
      const tr = document.createElement("tr");
      tr.dataset.symbol = stock.symbol;
      if (stock.symbol === state.selected) tr.classList.add("is-selected");
      const cell = (className = "") => {
        const td = document.createElement("td");
        if (className) td.className = className;
        tr.appendChild(td);
        return td;
      };

      const idCell = cell();
      const ticker = document.createElement("button");
      ticker.type = "button";
      ticker.className = "ticker-btn";
      ticker.textContent = stock.symbol;
      ticker.setAttribute("aria-label", `Inspect ${stock.symbol}, ${stock.name}`);
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = stock.exchange;
      idCell.append(ticker, chip);

      const company = document.createElement("div");
      company.className = "company";
      const name = document.createElement("span");
      name.textContent = stock.name;
      const sector = document.createElement("span");
      sector.textContent = m.listedInRange ? `${stock.sector} · listed ${fmt.day(state.data.dates[m.start])}` : stock.sector;
      company.append(name, sector);
      cell().appendChild(company);

      cell("num").textContent = fmt.price(m.last);
      cell("num").appendChild(deltaSpan(m.changePct));
      cell().appendChild(sparkline(Array.from(m.pct), { label: `${stock.symbol} trend, ${fmt.pct(m.changePct)}` }));
      cell("num").appendChild(deltaSpan(m.dayPct, fmt.pct(m.dayPct, 2)));
      cell("num").textContent = `${fmt.price(m.low)} – ${fmt.price(m.high)}`;
      cell("num").textContent = fmt.compact(m.avgVolume);
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.dataset.trend = m.trend.id;
      pill.textContent = m.trend.label;
      pill.title = m.trend.text;
      cell().appendChild(pill);

      tr.addEventListener("click", () => select(stock.symbol, { fly: true }));
      return tr;
    }),
  );
}

function markSelectedRow() {
  for (const tr of $("board-body").querySelectorAll("tr[data-symbol]")) {
    tr.classList.toggle("is-selected", tr.dataset.symbol === state.selected);
  }
}

function renderDetail() {
  const item = selectedItem();
  const stats = $("d-stats");
  if (!item) {
    $("d-ticker").textContent = "—";
    $("d-exchange").textContent = "";
    $("d-sector").textContent = "";
    $("d-name").textContent = "No stock selected";
    $("r-label").textContent = "";
    $("r-price").replaceChildren();
    $("r-delta").replaceChildren();
    $("r-extra").textContent = "";
    stats.replaceChildren();
    chart.set(null);
    $("d-trend").textContent = "—";
    $("d-trend").dataset.trend = "na";
    $("d-trend-text").textContent = "";
    return;
  }
  const { stock, m } = item;
  const dates = state.data.dates;
  $("d-ticker").textContent = stock.symbol;
  $("d-exchange").textContent = stock.exchange;
  $("d-sector").textContent = stock.sector;
  $("d-name").textContent = stock.name;
  chart.set({ stock, m, dates });
  renderReadout(null);

  const rows = [
    ["Period high", `${fmt.price(m.high)} · ${fmt.shortDay(dates[m.highIdx])}`],
    ["Period low", `${fmt.price(m.low)} · ${fmt.shortDay(dates[m.lowIdx])}`],
    ["Day change", fmt.pct(m.dayPct, 2)],
    ["Max drawdown", fmt.pct(m.maxDrawdown)],
    ["20-day average", fmt.price(m.ma20)],
    ["50-day average", fmt.price(m.ma50)],
    ["Volatility (20d, annualised)", fmt.unsignedPct(m.volatility)],
    ["Avg daily volume", `${fmt.compact(m.avgVolume)} shares`],
  ];
  stats.replaceChildren(
    ...rows.map(([label, value]) => {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      div.append(dt, dd);
      return div;
    }),
  );
  $("d-trend").textContent = m.trend.label;
  $("d-trend").dataset.trend = m.trend.id;
  $("d-trend-text").textContent = m.trend.text;
}

function renderReadout(index) {
  const item = selectedItem();
  if (!item) return;
  const { stock, m } = item;
  const dates = state.data.dates;
  const i = index ?? m.end;
  const close = stock.close[i];
  const change = close / m.base - 1;
  $("r-label").textContent = `${index == null ? "Last close" : "Close"} · ${fmt.day(dates[i])}`;
  const unit = document.createElement("small");
  unit.textContent = "AED";
  $("r-price").replaceChildren(unit, fmt.price(close));
  $("r-delta").className = `delta ${fmt.direction(change)}`;
  $("r-delta").textContent = fmt.pct(change, 2);
  const volume = stock.volume?.[i];
  $("r-extra").textContent = `${fmt.signedPrice(close - m.base)} since ${fmt.day(dates[m.start])}${volume ? ` · Vol ${fmt.compact(volume)}` : ""}`;
}

// ------------------------------------------------------------------ selection

function select(symbol, { fly = false } = {}) {
  if (!symbol || !state.items.some((it) => it.stock.symbol === symbol)) return;
  state.preferred = symbol;
  if (symbol !== state.selected) {
    state.selected = symbol;
    renderDetail();
    markSelectedRow();
  }
  terrain?.setSelected(symbol, { fly });
  try {
    history.replaceState(null, "", `#${symbol}`);
  } catch {
    /* some embedded viewers refuse history changes */
  }
}

function revealAndSelect(symbol) {
  if (!state.items.some((it) => it.stock.symbol === symbol)) {
    Object.assign(state, { exchange: "ALL", sector: "ALL", query: "" });
    syncControls();
    update();
    renderStage();
  }
  select(symbol, { fly: true });
}

function symbolFromHash() {
  const raw = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  return state.data?.stocks.some((s) => s.symbol === raw) ? raw : null;
}

// ------------------------------------------------------------------ chrome

function renderChrome() {
  const { data } = state;
  const badge = $("source-badge");
  badge.dataset.source = data.source;
  badge.textContent = data.source === "demo" ? "Demo data" : "Yahoo Finance closes";
  $("asof").textContent = `Prices to ${fmt.day(data.asOf ?? data.dates[data.dates.length - 1])} · ${data.stocks.length} stocks`;
  $("demo-notice").hidden = data.source !== "demo";

  const skipped = (data.skipped ?? []).map((s) => s.symbol);
  $("foot-source").textContent =
    `Source: ${data.sourceName ?? data.source}. Data file generated ${fmt.stamp(data.generated)}.` +
    (skipped.length ? ` Not available this run: ${skipped.join(", ")}.` : "");
}

function showFatal(err) {
  console.error(err);
  const box = document.createElement("section");
  box.className = "fatal";
  const title = document.createElement("h2");
  title.textContent = "The market data did not load";
  const body = document.createElement("p");
  body.textContent = err?.message ?? String(err);
  box.append(title, body);
  document.querySelector(".workspace").replaceWith(box);
  $("source-badge").textContent = "No data";
}
