// The 3D stage: "trend ribbons" (one lane per stock, time → x, change → y) and
// "return towers" (one column per stock, grouped into sector rows).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { groupBySector } from "./data.js";
import * as fmt from "./format.js";

const RIBBON = { width: 46, lane: 1.0, sectorGap: 1.0, height: 10 };
const TOWER = { cell: 2.2, size: 1.15, height: 8, gap: 2.6 };
const LABEL_PX = 30;

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Theme colours and fonts, read from the CSS custom properties. */
export function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return {
    gain: get("--gain"),
    loss: get("--loss"),
    neutral: get("--neutral"),
    ink: get("--ink"),
    ink2: get("--ink-2"),
    muted: get("--muted"),
    accent: get("--accent"),
    plane: get("--plane"),
    halo: get("--stage-bottom"),
    fontData: get("--font-data") || "monospace",
    fontBody: get("--font-body") || "sans-serif",
  };
}

export class Terrain {
  constructor(host, { onHover, onSelect } = {}) {
    this.host = host;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.tokens = readTokens();

    // Throws when WebGL is unavailable; the caller shows a fallback.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute(
      "aria-label",
      "3D chart of every stock's price trend. Use the left and right arrow keys to move between stocks; the table below lists the same data.",
    );
    host.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 800);
    this.camera.position.set(30, 22, 48);
    this.controls = new OrbitControls(this.camera, this.canvas);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      rotateSpeed: 0.7,
      minDistance: 4,
      maxDistance: 180,
      maxPolarAngle: Math.PI * 0.58,
      screenSpacePanning: true,
    });
    this.controls.addEventListener("start", () => (this.tween = null));
    this.controls.addEventListener("change", () => (this.needsPick = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3b4a60, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.25);
    sun.position.set(14, 30, 22);
    this.scene.add(sun);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.view = "ribbons";
    this.lanes = new Map();
    this.order = [];
    this.pickables = [];
    this.lineMaterials = [];
    this.fadeMaterials = [];
    this.hovered = null;

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ public API

  setData({ items, dates, start, end, view, selected, refit }) {
    const viewChanged = view !== this.view;
    Object.assign(this, { items, dates, start, end, view, selected });
    this.build();
    if (refit || viewChanged || !this.hasFit) {
      this.fit(this.hasFit);
      this.hasFit = true;
    }
    this.grow = motionQuery.matches ? null : { t0: performance.now(), dur: 800 };
    if (!this.grow) this.setGrowth(1);
  }

  setSelected(symbol, { fly = false } = {}) {
    const previous = this.selected;
    this.selected = symbol;
    this.applySelection(previous);
    if (fly) this.focus(symbol);
  }

  setTheme(tokens) {
    this.tokens = tokens;
    if (this.items) {
      this.build();
      this.setGrowth(1);
    }
  }

  resetView() {
    this.fit(true);
  }

  // ------------------------------------------------------------------ building

  clear() {
    this.world.traverse((node) => {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const material of materials) {
        material.map?.dispose();
        material.dispose();
      }
    });
    this.world.clear();
    this.lanes.clear();
    this.order = [];
    this.pickables = [];
    this.lineMaterials = [];
    this.fadeMaterials = [];
    this.hovered = null;
    this.bounds = null;
    this.scaleInfo = null;
  }

  build() {
    this.clear();
    if (!this.items?.length) return;
    this.content = new THREE.Group();
    this.labels = new THREE.Group();
    this.overlay = new THREE.Group();
    this.world.add(this.content, this.labels, this.overlay);
    this.palette = {
      gain: new THREE.Color(this.tokens.gain),
      loss: new THREE.Color(this.tokens.loss),
      neutral: new THREE.Color(this.tokens.neutral),
      accent: new THREE.Color(this.tokens.accent),
      ink: new THREE.Color(this.tokens.ink),
    };
    if (this.view === "towers") this.buildTowers();
    else this.buildRibbons();
    this.buildHoverMarks();
    this.applySelection(null, true);
  }

  divergingColor(value, maxAbs, out = new THREE.Color()) {
    const { gain, loss, neutral } = this.palette;
    const k = Math.min(1, Math.abs(value) / maxAbs);
    return out.copy(neutral).lerp(value >= 0 ? gain : loss, 0.25 + 0.75 * k ** 0.7);
  }

  buildRibbons() {
    const { items, start, end, tokens } = this;
    const { width, lane: laneGap, sectorGap, height } = RIBBON;
    const span = Math.max(1, end - start);
    const xAt = (i) => -width / 2 + ((i - start) / span) * width;

    let lo = 0;
    let hi = 0;
    for (const { m } of items) {
      lo = Math.min(lo, m.minPct);
      hi = Math.max(hi, m.maxPct);
    }
    const maxAbs = Math.max(0.01, -lo, hi);
    const yScale = height / maxAbs;
    this.scaleInfo = { maxAbs, title: "Change since period start" };
    this.xAt = xAt;
    this.yScale = yScale;

    // Lanes: best sector at the back so taller ribbons sit behind shorter ones.
    const groups = groupBySector(items);
    const lanes = [];
    const sectors = [];
    let z = 0;
    for (const group of groups) {
      const z0 = z;
      for (const item of group.items) {
        lanes.push({ item, z });
        z += laneGap;
      }
      sectors.push({ name: group.sector, z0, z1: z - laneGap });
      z += sectorGap;
    }
    const offset = (z - sectorGap - laneGap) / 2;
    for (const lane of lanes) lane.z -= offset;
    for (const s of sectors) {
      s.z0 -= offset;
      s.z1 -= offset;
    }
    const zBack = -offset - 1.4;
    const zFront = offset + 1.4;

    const tmp = new THREE.Color();
    for (const { item, z: laneZ } of lanes) {
      const { stock, m } = item;
      const n = m.end - m.start + 1;
      const positions = new Float32Array(n * 6);
      const colors = new Float32Array(n * 8);
      const linePositions = new Float32Array(n * 3);
      const lineColors = new Float32Array(n * 3);
      const index = [];
      for (let j = 0; j < n; j++) {
        const x = xAt(m.start + j);
        const v = m.pct[j];
        const y = v * yScale;
        positions.set([x, y, laneZ, x, 0, laneZ], j * 6);
        this.divergingColor(v, maxAbs, tmp);
        colors.set([tmp.r, tmp.g, tmp.b, 0.78, tmp.r, tmp.g, tmp.b, 0.06], j * 8);
        linePositions.set([x, y, laneZ], j * 3);
        const pole = v >= 0 ? this.palette.gain : this.palette.loss;
        lineColors.set([pole.r, pole.g, pole.b], j * 3);
        if (j < n - 1) {
          const a = j * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
      geometry.setIndex(index);
      const curtain = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      curtain.userData.symbol = stock.symbol;
      curtain.renderOrder = 1;
      this.content.add(curtain);
      this.pickables.push(curtain);

      const lineGeometry = new LineGeometry();
      lineGeometry.setPositions(linePositions);
      lineGeometry.setColors(lineColors);
      const lineMaterial = new LineMaterial({ vertexColors: true, linewidth: 2, transparent: true, worldUnits: false });
      lineMaterial.resolution.set(this.size.w, this.size.h);
      const line = new Line2(lineGeometry, lineMaterial);
      line.computeLineDistances();
      line.renderOrder = 2;
      this.content.add(line);
      this.lineMaterials.push(lineMaterial);

      const yEnd = m.pct[n - 1] * yScale;
      const lane = {
        item,
        z: laneZ,
        curtain,
        line,
        labelAt: new THREE.Vector3(width / 2 + 0.5, yEnd, laneZ),
        labelAnchor: [0, 0.5],
        labelLines: () => [[{ text: stock.symbol, weight: 600 }, { text: `  ${fmt.pct(m.changePct)}`, muted: true }]],
        focusAt: new THREE.Vector3(0, (m.minPct + m.maxPct) * 0.5 * yScale, laneZ),
      };
      this.addLaneLabel(lane, false);
      this.lanes.set(stock.symbol, lane);
      this.order.push(stock.symbol);
    }

    // Floor, month grid and sector brackets.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 1.6, zFront - zBack),
      new THREE.MeshBasicMaterial({ color: tokens.plane, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.01, (zFront + zBack) / 2);
    floor.renderOrder = 0;
    this.world.add(floor);

    const guide = [];
    const strong = [];
    for (const i of fmt.monthStarts(this.dates, start, end)) {
      const x = xAt(i);
      guide.push(x, 0, zBack, x, 0, zFront);
      const label = this.dates[i].slice(5, 7) === "01" ? `${fmt.month(this.dates[i])} ${this.dates[i].slice(0, 4)}` : fmt.month(this.dates[i]);
      this.addStaticLabel([[{ text: label }]], new THREE.Vector3(x, 0, zFront + 0.6), [0.5, 1], 0.85, true);
    }
    this.addStaticLabel([[{ text: fmt.day(this.dates[start]), weight: 600 }]], new THREE.Vector3(-width / 2, 0, zFront + 2.2), [0, 1], 0.85);
    this.addStaticLabel([[{ text: fmt.day(this.dates[end]), weight: 600 }]], new THREE.Vector3(width / 2, 0, zFront + 2.2), [1, 1], 0.85);

    for (const s of sectors) {
      strong.push(-width / 2 - 0.35, 0, s.z0 - 0.3, -width / 2 - 0.35, 0, s.z1 + 0.3);
      this.addStaticLabel([[{ text: s.name.toUpperCase(), weight: 600 }]], new THREE.Vector3(-width / 2 - 0.8, 0, (s.z0 + s.z1) / 2), [1, 0.5], 0.8, true);
    }

    // Back wall: horizontal guides at tidy percentages.
    const step = fmt.niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const y = v * yScale;
      (Math.abs(v) < 1e-9 ? strong : guide).push(-width / 2, y, zBack, width / 2, y, zBack);
      this.addStaticLabel([[{ text: fmt.pct(v, step < 0.01 ? 1 : 0) }]], new THREE.Vector3(-width / 2 - 0.5, y, zBack), [1, 0.5], 0.85, true);
    }
    this.addSegments(guide, 0.12);
    this.addSegments(strong, 0.32);

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-width / 2 - 4, Math.min(0, lo * yScale), zBack),
      new THREE.Vector3(width / 2 + 4, Math.max(1, hi * yScale), zFront + 1.5),
    );
    this.sliceSpan = { zBack, zFront, yLo: Math.min(0, lo * yScale), yHi: Math.max(0.5, hi * yScale) };
  }

  buildTowers() {
    const { items, tokens } = this;
    const { cell, size, height, gap } = TOWER;
    const maxAbs = Math.max(0.01, ...items.map(({ m }) => Math.abs(m.changePct)));
    const yScale = height / maxAbs;
    this.scaleInfo = { maxAbs, title: "Change over the period" };

    // Each sector is a "district": a square block of towers, best performer at the back-left.
    const groups = groupBySector(items);
    const side = Math.ceil(Math.sqrt(Math.max(...groups.map((g) => g.items.length))));
    const block = side * cell;
    const cols = Math.min(groups.length, Math.max(1, Math.round(Math.sqrt(groups.length * 1.8))));
    const rows = Math.ceil(groups.length / cols);
    const pitch = block + gap;
    const xOffset = ((cols - 1) * pitch) / 2;
    const zOffset = ((rows - 1) * pitch) / 2;
    const geometry = new THREE.BoxGeometry(size, 1, size);
    geometry.translate(0, 0.5, 0);
    const edges = new THREE.EdgesGeometry(geometry);
    const tileGeometry = new THREE.PlaneGeometry(block + 0.5, block + 0.5).rotateX(-Math.PI / 2);
    const tileMaterial = new THREE.MeshBasicMaterial({ color: tokens.plane, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });

    let lo = 0;
    let hi = 0;
    groups.forEach((group, g) => {
      const cx = (g % cols) * pitch - xOffset;
      const cz = Math.floor(g / cols) * pitch - zOffset;
      const tile = new THREE.Mesh(tileGeometry, tileMaterial);
      tile.position.set(cx, -0.005, cz);
      this.world.add(tile);

      group.items.forEach((item, k) => {
        const { stock, m } = item;
        const v = m.changePct;
        const h = Math.max(0.05, Math.abs(v) * yScale);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        const x = cx + ((k % side) - (side - 1) / 2) * cell;
        const z = cz + (Math.floor(k / side) - (side - 1) / 2) * cell;
        const material = new THREE.MeshLambertMaterial({ color: this.divergingColor(v, maxAbs) });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.y = h;
        mesh.position.set(x, v >= 0 ? 0 : -h, z);
        mesh.userData.symbol = stock.symbol;
        this.content.add(mesh);
        this.pickables.push(mesh);

        const rim = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: this.palette.ink, transparent: true, opacity: 0.16 }));
        rim.scale.y = h;
        rim.position.copy(mesh.position);
        this.content.add(rim);

        const top = v >= 0 ? h : -h;
        const lane = {
          item,
          mesh,
          x,
          z,
          labelAt: new THREE.Vector3(x, top + (v >= 0 ? 0.3 : -0.3), z),
          labelAnchor: [0.5, v >= 0 ? 0 : 1],
          labelLines: () => [[{ text: stock.symbol, weight: 600 }], [{ text: fmt.pct(v), muted: true }]],
          focusAt: new THREE.Vector3(x, top / 2, z),
          top,
        };
        this.addLaneLabel(lane, false);
        this.lanes.set(stock.symbol, lane);
        this.order.push(stock.symbol);
      });
      this.addStaticLabel(
        [[{ text: group.sector.toUpperCase(), weight: 600 }]],
        new THREE.Vector3(cx, 0.05, cz + block / 2 + 0.45),
        [0.5, 1],
        0.7,
        true,
        true,
      );
    });

    const xMin = -xOffset - block / 2 - 0.6;
    const xMax = xOffset + block / 2 + 0.6;
    const zBack = -zOffset - block / 2 - 1;
    const zFront = zOffset + block / 2 + 1.6;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(xMax - xMin, zFront - zBack),
      new THREE.MeshBasicMaterial({ color: tokens.plane, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.02, (zFront + zBack) / 2);
    this.world.add(floor);

    const guide = [];
    const strong = [];
    const tick = fmt.niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / tick) * tick; v <= hi + 1e-9; v += tick) {
      const y = v * yScale;
      (Math.abs(v) < 1e-9 ? strong : guide).push(xMin, y, zBack, xMax, y, zBack);
      this.addStaticLabel([[{ text: fmt.pct(v, tick < 0.01 ? 1 : 0) }]], new THREE.Vector3(xMin - 0.3, y, zBack), [1, 0.5], 0.8, true);
    }
    this.addSegments(guide, 0.12);
    this.addSegments(strong, 0.32);

    this.bounds = new THREE.Box3(
      new THREE.Vector3(xMin - 2, Math.min(0, lo * yScale), zBack),
      new THREE.Vector3(xMax, Math.max(1, hi * yScale + 1), zFront),
    );
  }

  addSegments(points, opacity) {
    if (!points.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: this.palette.ink, transparent: true, opacity, depthWrite: false }),
    );
    this.world.add(lines);
  }

  buildHoverMarks() {
    const accent = this.palette.accent;
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 20, 14),
      new THREE.MeshBasicMaterial({ color: accent, depthTest: false }),
    );
    this.marker.renderOrder = 30;
    this.stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineBasicMaterial({ color: accent, depthTest: false }),
    );
    this.stem.renderOrder = 29;
    this.slice = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.slice.rotation.y = Math.PI / 2;
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(TOWER.size + 0.22, 1, TOWER.size + 0.22).translate(0, 0.5, 0)),
      new THREE.LineBasicMaterial({ color: accent }),
    );
    for (const mark of [this.marker, this.stem, this.slice]) mark.visible = false;
    this.outline.visible = false;
    this.overlay.add(this.marker, this.stem, this.slice);
    this.content.add(this.outline);
  }

  // ------------------------------------------------------------------ labels

  drawLabel(lines, { color, mutedColor, size }) {
    const { fontData } = this.tokens;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const lineHeight = LABEL_PX * 1.25;
    const pad = 8;
    const fontFor = (run) => `${run.weight ?? 500} ${LABEL_PX}px ${fontData}`;
    const widths = lines.map((runs) =>
      runs.reduce((sum, run) => {
        ctx.font = fontFor(run);
        return sum + ctx.measureText(run.text).width;
      }, 0),
    );
    canvas.width = Math.ceil(Math.max(...widths) + pad * 2);
    canvas.height = Math.ceil(lines.length * lineHeight + pad * 2);
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    lines.forEach((runs, li) => {
      let x = pad + (canvas.width - pad * 2 - widths[li]) / 2;
      const y = pad + lineHeight * (li + 0.5);
      for (const run of runs) {
        ctx.font = fontFor(run);
        ctx.lineWidth = 7;
        ctx.strokeStyle = this.tokens.halo;
        ctx.strokeText(run.text, x, y);
        ctx.fillStyle = run.muted ? mutedColor : color;
        ctx.fillText(run.text, x, y);
        x += ctx.measureText(run.text).width;
      }
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const worldHeight = size * (canvas.height / (lineHeight + pad * 2));
    return { texture, scale: [worldHeight * (canvas.width / canvas.height), worldHeight] };
  }

  makeSprite(lines, anchor, options) {
    const { texture, scale } = this.drawLabel(lines, options);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.center.set(anchor[0], anchor[1]);
    sprite.scale.set(scale[0], scale[1], 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  addStaticLabel(lines, position, anchor, size, muted = false, depthTest = false) {
    const t = this.tokens;
    const sprite = this.makeSprite(lines, anchor, { color: muted ? t.muted : t.ink2, mutedColor: t.muted, size });
    sprite.material.depthTest = depthTest;
    sprite.position.copy(position);
    this.labels.add(sprite);
    this.fadeMaterials.push(sprite.material);
    return sprite;
  }

  addLaneLabel(lane, selected) {
    const t = this.tokens;
    if (lane.label) {
      this.labels.remove(lane.label);
      lane.label.material.map.dispose();
      lane.label.material.dispose();
      this.fadeMaterials = this.fadeMaterials.filter((m) => m !== lane.label.material);
    }
    const sprite = this.makeSprite(lane.labelLines(), lane.labelAnchor, {
      color: selected ? t.accent : t.ink,
      mutedColor: selected ? t.accent : t.ink2,
      size: selected ? 1.05 : 0.72,
    });
    sprite.position.copy(lane.labelAt);
    sprite.renderOrder = selected ? 12 : 10;
    this.labels.add(sprite);
    this.fadeMaterials.push(sprite.material);
    lane.label = sprite;
  }

  // ------------------------------------------------------------------ selection + hover

  applySelection(previous, initial = false) {
    const selected = this.selected;
    for (const [symbol, lane] of this.lanes) {
      const isSelected = symbol === selected;
      if (lane.curtain) {
        const material = lane.line.material;
        lane.curtain.material.opacity = isSelected ? 1 : 0.75;
        material.opacity = isSelected ? 1 : 0.72;
        material.linewidth = isSelected ? 4 : 2;
        if (material.vertexColors === isSelected) {
          material.vertexColors = !isSelected;
          material.color.copy(isSelected ? this.palette.accent : new THREE.Color(0xffffff));
          material.needsUpdate = true;
        }
      }
      if (!initial && (symbol === previous || isSelected)) this.addLaneLabel(lane, isSelected);
      if (initial && isSelected) this.addLaneLabel(lane, true);
    }
    const lane = this.lanes.get(selected);
    if (this.outline) {
      this.outline.visible = Boolean(lane?.mesh);
      if (lane?.mesh) {
        this.outline.position.set(lane.x, lane.top >= 0 ? 0 : lane.top, lane.z);
        this.outline.scale.y = Math.abs(lane.top);
      }
    }
  }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(this.pickables, false)[0] ?? null;
  }

  hover(hit, clientX, clientY) {
    const previous = this.hovered;
    if (previous?.mesh) previous.mesh.material.emissive.setRGB(0, 0, 0);
    if (!hit) {
      this.hovered = null;
      if (this.marker) this.marker.visible = this.stem.visible = this.slice.visible = false;
      this.host.classList.remove("is-pointing");
      if (previous) this.onHover?.(null);
      return;
    }
    const lane = this.lanes.get(hit.object.userData.symbol);
    if (!lane) return;
    const { m } = lane.item;
    this.hovered = lane;
    this.host.classList.add("is-pointing");

    if (lane.curtain) {
      const span = Math.max(1, this.end - this.start);
      const raw = this.start + ((hit.point.x + RIBBON.width / 2) / RIBBON.width) * span;
      const index = clamp(Math.round(raw), m.start, m.end);
      const x = this.xAt(index);
      const y = m.pct[index - m.start] * this.yScale * this.content.scale.y;
      this.marker.position.set(x, y, lane.z);
      this.stem.position.set(x, 0, lane.z);
      this.stem.scale.y = y || 0.001;
      const { zBack, zFront, yLo, yHi } = this.sliceSpan;
      this.slice.position.set(x, (yLo + yHi) / 2, (zBack + zFront) / 2);
      this.slice.scale.set(zFront - zBack, yHi - yLo, 1);
      this.marker.visible = this.stem.visible = this.slice.visible = true;
      this.onHover?.({ item: lane.item, index }, clientX, clientY);
    } else {
      lane.mesh.material.emissive.copy(this.palette.accent).multiplyScalar(0.28);
      this.onHover?.({ item: lane.item, index: m.end, tower: true }, clientX, clientY);
    }
  }

  focus(symbol) {
    const lane = this.lanes.get(symbol);
    if (!lane) return;
    const target = lane.focusAt.clone();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const overview = this.bounds ? this.bounds.getSize(new THREE.Vector3()).length() : 60;
    const distance = clamp(overview * (this.view === "towers" ? 0.42 : 0.5), 14, 60);
    offset.setLength(distance);
    if (offset.y < distance * 0.3) offset.y = distance * 0.3;
    offset.setLength(distance);
    this.moveTo(target.clone().add(offset), target, true);
  }

  fit(animate) {
    const bounds = this.bounds;
    if (!bounds) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const direction = (this.view === "towers" ? new THREE.Vector3(0.36, 0.82, 0.86) : new THREE.Vector3(0.2, 0.75, 0.68)).normalize();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const radius = size.length() / 2;
    const portrait = this.camera.aspect < 1 ? 1.2 : 1;
    const distance = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (this.view === "towers" ? 0.62 : 0.58) * portrait;
    const target = new THREE.Vector3(center.x, center.y * 0.5, center.z + size.z * 0.04);
    this.moveTo(target.clone().addScaledVector(direction, distance), target, animate);
  }

  moveTo(position, target, animate) {
    if (!animate || motionQuery.matches) {
      this.tween = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.tween = {
      t0: performance.now(),
      dur: 900,
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position,
      toTarget: target,
    };
  }

  // ------------------------------------------------------------------ events + loop

  bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      this.pointer = { x: event.clientX, y: event.clientY };
      this.needsPick = true;
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.hover(null);
    });
    canvas.addEventListener("pointerdown", (event) => {
      this.down = { x: event.clientX, y: event.clientY, t: performance.now() };
    });
    canvas.addEventListener("pointerup", (event) => {
      const down = this.down;
      this.down = null;
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || performance.now() - down.t > 600) return;
      const hit = this.pick(event.clientX, event.clientY);
      if (!hit) return;
      this.onSelect?.(hit.object.userData.symbol);
      this.hover(hit, event.clientX, event.clientY);
    });
    canvas.addEventListener("keydown", (event) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !back) return;
      event.preventDefault();
      if (!this.order.length) return;
      const current = this.order.indexOf(this.selected);
      const next = this.order[(current + (forward ? 1 : -1) + this.order.length) % this.order.length];
      this.onSelect?.(next, { fly: true });
    });
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const material of this.lineMaterials) material.resolution.set(w, h);
  }

  setGrowth(k) {
    if (this.content) this.content.scale.y = Math.max(0.001, k);
    for (const material of this.fadeMaterials) material.opacity = k;
  }

  frame() {
    const now = performance.now();
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      const e = ease(k);
      this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, e);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
      if (k >= 1) this.tween = null;
    }
    if (this.grow) {
      const k = Math.min(1, (now - this.grow.t0) / this.grow.dur);
      this.setGrowth(ease(k));
      if (k >= 1) this.grow = null;
    }
    this.controls.update();
    if (this.needsPick && this.pointer && !this.down) {
      this.needsPick = false;
      this.hover(this.pick(this.pointer.x, this.pointer.y), this.pointer.x, this.pointer.y);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
