// 2D SVG charts: table sparklines and the detail price chart with a snapping crosshair.
import * as fmt from "./format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
let uid = 0;

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (parent) parent.appendChild(node);
  return node;
}

function text(parent, content, attrs) {
  const node = el("text", attrs, parent);
  node.textContent = content;
  return node;
}

function linePath(points) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

/** Small trend line for tables and tiles. `values` are changes since the period start. */
export function sparkline(values, { width = 112, height = 30, label } = {}) {
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "spark", role: "img" });
  if (label) el("title", {}, svg).textContent = label;
  if (!values || values.length < 2) return svg;

  let min = 0;
  let max = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) max = min + 1e-9;
  const pad = 3;
  const x = (i) => pad + (i / (values.length - 1)) * (width - pad * 2 - 3);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  const last = values[values.length - 1];
  const color = last >= 0 ? "var(--gain)" : "var(--loss)";

  el("line", { x1: pad, x2: width - pad, y1: y(0), y2: y(0), stroke: "var(--line-strong)", "stroke-dasharray": "2 3" }, svg);
  el("path", {
    d: linePath(values.map((v, i) => [x(i), y(v)])),
    fill: "none",
    stroke: color,
    "stroke-width": 1.6,
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  }, svg);
  el("circle", { cx: x(values.length - 1), cy: y(last), r: 2.6, fill: color, stroke: "var(--surface)", "stroke-width": 1.5 }, svg);
  return svg;
}

/**
 * Price + volume chart for the selected stock. The readout callback receives the hovered
 * index (or null at rest) so the panel above the chart can show the values.
 */
export class PriceChart {
  constructor(host, { onReadout } = {}) {
    this.host = host;
    this.onReadout = onReadout;
    this.id = `pc${++uid}`;
    this.state = null;
    this.hoverIndex = null;
    this.lastWidth = 0;
    this.observer = new ResizeObserver(() => {
      if (host.clientWidth !== this.lastWidth) this.render();
    });
    this.observer.observe(host);
  }

  set(state) {
    this.state = state;
    this.hoverIndex = null;
    this.render();
  }

  render() {
    const { host, state } = this;
    host.replaceChildren();
    if (!state) return;
    const { stock, m, dates } = state;
    this.lastWidth = host.clientWidth;
    const width = Math.max(240, host.clientWidth);
    const priceH = 178;
    const volH = 40;
    const gap = 26;
    const pad = { top: 12, right: 12, bottom: 18, left: 44 };
    const height = pad.top + priceH + gap + volH + pad.bottom;
    const plotW = width - pad.left - pad.right;
    const count = m.end - m.start + 1;

    const svg = el("svg", {
      viewBox: `0 0 ${width} ${height}`,
      height,
      role: "img",
      "aria-label": `${stock.symbol} closing price from ${fmt.day(dates[m.start])} to ${fmt.day(dates[m.end])}: ${fmt.price(m.base)} to ${fmt.price(m.last)} AED (${fmt.pct(m.changePct)}).`,
    });
    host.appendChild(svg);

    // ---- scales
    const closes = stock.close.slice(m.start, m.end + 1);
    const step = fmt.niceStep(m.high - m.low || m.last * 0.02, 4);
    const yMin = Math.floor(m.low / step) * step;
    const yMax = Math.ceil(m.high / step) * step;
    const xAt = (i) => pad.left + (count === 1 ? plotW / 2 : (i / (count - 1)) * plotW);
    const yAt = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin || 1)) * priceH;
    const volumes = (stock.volume ?? []).slice(m.start, m.end + 1).map((v) => v ?? 0);
    const volMax = Math.max(1, ...volumes);
    const volTop = pad.top + priceH + gap;
    const volAt = (v) => (v / volMax) * volH;

    const up = m.changePct >= 0;
    const color = up ? "var(--gain)" : "var(--loss)";

    const defs = el("defs", {}, svg);
    const grad = el("linearGradient", { id: `${this.id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.22 }, grad);
    el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }, grad);

    // ---- grid + y labels
    const grid = el("g", {}, svg);
    for (let v = yMin; v <= yMax + step / 2; v += step) {
      const y = yAt(v);
      el("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: "grid" }, grid);
      text(grid, fmt.price(v), { x: pad.left - 8, y: y + 3.5, "text-anchor": "end" });
    }

    // ---- x month ticks
    const ticks = fmt.monthStarts(dates, m.start, m.end);
    const minGap = 38;
    let lastX = -Infinity;
    for (const i of ticks) {
      const x = xAt(i - m.start);
      if (x - lastX < minGap || x > width - pad.right - 14) continue;
      lastX = x;
      el("line", { x1: x, x2: x, y1: pad.top + priceH, y2: pad.top + priceH + 4, class: "grid" }, grid);
      const label = dates[i].slice(5, 7) === "01" ? `${fmt.month(dates[i])} ${dates[i].slice(2, 4)}` : fmt.month(dates[i]);
      text(grid, label, { x, y: pad.top + priceH + 15, "text-anchor": "middle" });
    }

    // ---- start baseline
    const baseY = yAt(m.base);
    el("line", { x1: pad.left, x2: width - pad.right, y1: baseY, y2: baseY, class: "baseline" }, svg);

    // ---- area + line
    const points = closes.map((v, i) => [xAt(i), yAt(v)]);
    const area = `${linePath(points)}L${xAt(count - 1).toFixed(1)},${(pad.top + priceH).toFixed(1)}L${pad.left},${(pad.top + priceH).toFixed(1)}Z`;
    el("path", { d: area, fill: `url(#${this.id}-fill)` }, svg);
    el("path", { d: linePath(points), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

    // ---- selective labels: period high, low, last
    const marks = el("g", {}, svg);
    const markLabel = (i, value, prefix, above) => {
      const x = xAt(i - m.start);
      const y = yAt(value);
      el("circle", { cx: x, cy: y, r: 3, fill: "var(--surface)", stroke: "var(--ink-2)", "stroke-width": 1.5 }, marks);
      const anchor = x < pad.left + 40 ? "start" : x > width - pad.right - 40 ? "end" : "middle";
      text(marks, `${prefix} ${fmt.price(value)}`, { x, y: above ? y - 8 : y + 15, "text-anchor": anchor, class: "label-strong" });
    };
    if (m.highIdx !== m.end) markLabel(m.highIdx, m.high, "High", true);
    if (m.lowIdx !== m.end && m.lowIdx !== m.highIdx) markLabel(m.lowIdx, m.low, "Low", false);
    el("circle", { cx: xAt(count - 1), cy: yAt(m.last), r: 4.5, fill: color, stroke: "var(--surface)", "stroke-width": 2 }, marks);

    // ---- volume
    const volGroup = el("g", {}, svg);
    text(volGroup, "Volume", { x: pad.left - 8, y: volTop + 8, "text-anchor": "end" });
    text(volGroup, fmt.compact(volMax), { x: pad.left - 8, y: volTop + 19, "text-anchor": "end" });
    const barW = Math.max(1, plotW / count - 1);
    const bars = volumes.map((v, i) => {
      const h = Math.max(v > 0 ? 1 : 0, volAt(v));
      return el("rect", { x: xAt(i) - barW / 2, y: volTop + volH - h, width: barW, height: h, class: "vol" }, volGroup);
    });
    el("line", { x1: pad.left, x2: width - pad.right, y1: volTop + volH, y2: volTop + volH, class: "grid" }, volGroup);

    // ---- crosshair
    const cross = el("g", { visibility: "hidden" }, svg);
    const crossLine = el("line", { y1: pad.top, y2: volTop + volH, class: "cross" }, cross);
    const crossDot = el("circle", { r: 4.5, fill: color, stroke: "var(--surface)", "stroke-width": 2 }, cross);

    const hit = el("rect", { x: pad.left - 6, y: 0, width: plotW + 12, height, fill: "transparent" }, svg);
    let hotBar = null;
    const show = (index) => {
      if (index == null) {
        cross.setAttribute("visibility", "hidden");
        hotBar?.classList.remove("is-hot");
        hotBar = null;
        this.onReadout?.(null);
        return;
      }
      const x = xAt(index);
      crossLine.setAttribute("x1", x);
      crossLine.setAttribute("x2", x);
      crossDot.setAttribute("cx", x);
      crossDot.setAttribute("cy", yAt(closes[index]));
      cross.setAttribute("visibility", "visible");
      hotBar?.classList.remove("is-hot");
      hotBar = bars[index];
      hotBar?.classList.add("is-hot");
      this.onReadout?.(m.start + index);
    };
    const indexFromEvent = (event) => {
      const rect = svg.getBoundingClientRect();
      const scale = width / rect.width;
      const x = (event.clientX - rect.left) * scale;
      return Math.round(Math.min(1, Math.max(0, (x - pad.left) / plotW)) * (count - 1));
    };
    hit.addEventListener("pointermove", (event) => show(indexFromEvent(event)));
    hit.addEventListener("pointerdown", (event) => show(indexFromEvent(event)));
    hit.addEventListener("pointerleave", () => show(null));

    // Keyboard: arrow keys walk the crosshair along the trading days.
    svg.setAttribute("tabindex", "0");
    svg.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") return show((this.hoverIndex = null));
      const current = this.hoverIndex ?? count - 1;
      const next =
        event.key === "Home" ? 0 : event.key === "End" ? count - 1 : current + (event.key === "ArrowLeft" ? -1 : 1);
      this.hoverIndex = Math.min(count - 1, Math.max(0, next));
      show(this.hoverIndex);
    });
    svg.addEventListener("blur", () => show((this.hoverIndex = null)));
  }
}
