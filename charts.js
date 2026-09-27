// Small chart toolkit for the app: hand-drawn SVG, no library. Colours come from CSS variables
// (styles.css: --series-1.. for identity, --up/--down for gain/loss, --grid/--axis/--muted for chrome),
// so light and dark mode are handled by the stylesheet.
//
// Conventions (see the data-viz notes in the README):
//   - thin marks: bars at most 14px thick with a 4px rounded end (square at the baseline), 2px lines;
//   - values are always readable without hovering: bars carry their value at the tip, stacked bars
//     have a legend listing every value, and every chart gets a "Table" switch (tableToggle);
//   - one hover/tap/focus tooltip per mark, filled with textContent; Escape closes it;
//   - labels are measured, never guessed, so nothing is cut off at the edges;
//   - axis ticks are round numbers (niceTicks), and never two y-scales on one chart.

const MINUS = '−';
const hasDom = typeof document !== 'undefined';

// ---------- numbers ----------

// Decimals needed to write `step` exactly (0.25 -> 2, 2.5 -> 1, 25 -> 0).
function decimalsOf(step) {
  for (let d = 0; d < 8; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 8;
}

// A round step (1, 2, 2.5 or 5 times a power of ten) giving about `count` intervals over [min, max].
export function niceStep(min, max, count = 4) {
  if (!(max > min)) { min -= 1; max += 1; }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
  return { step, decimals: decimalsOf(step) };
}

// Round tick values inside [min, max], without floating-point dust (0.30000000000000004).
export function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const { step, decimals } = niceStep(min, max, count);
  const ticks = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) ticks.push(Number((k * step).toFixed(decimals)) || 0);
  return ticks;
}

// A plain axis number with a thousands separator, `decimals` places and a true minus sign.
export const axisNum = (v, decimals = 0) => `${v < 0 ? MINUS : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

// Percentages of `values` that add up to exactly 100 at `decimals` places (largest remainder).
export function shareLabels(values, decimals = 1) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return values.map(() => `${(0).toFixed(decimals)}%`);
  const f = 10 ** decimals;
  const raw = values.map((v) => (v / total) * 100 * f);
  const units = raw.map(Math.floor);
  let left = 100 * f - units.reduce((s, u) => s + u, 0);
  for (const [, i] of raw.map((r, i) => [r - units[i], i]).sort((a, b) => b[0] - a[0])) {
    if (left <= 0) break;
    units[i]++; left--;
  }
  return units.map((u) => `${(u / f).toFixed(decimals)}%`);
}

// ---------- text ----------

let measureCtx = null, fontFamily = null;
// Width in px of `text` at `size` and `weight` in the page's font.
export function textWidth(text, size = 12, weight = 400) {
  const s = String(text ?? '');
  if (hasDom && !measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  }
  if (!measureCtx) return s.length * size * (weight >= 600 ? 0.62 : 0.56);
  measureCtx.font = `${weight} ${size}px ${fontFamily}`;
  return Math.ceil(measureCtx.measureText(s).width) + 1;
}

// `text`, cut with an ellipsis to fit `maxW`.
function fitText(text, maxW, size = 12, weight = 400) {
  let s = String(text ?? '');
  if (textWidth(s, size, weight) <= maxW) return s;
  while (s.length > 1 && textWidth(`${s}…`, size, weight) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

const escText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A label centred on x but kept inside [0, W], with its box ({ left, right }) for collision checks.
// Bold labels (weight 600, class "val") are measured bold, plus their surface halo.
function axisLabel(x, y, text, W, size = 11, weight = 400, cls = 'axis') {
  const w = textWidth(text, size, weight) + (weight >= 600 ? 3 : 0);
  const anchor = x - w / 2 < 0 ? 'start' : x + w / 2 > W ? 'end' : 'middle';
  const at = anchor === 'start' ? Math.max(0, x - w / 2) : anchor === 'end' ? Math.min(W, x + w / 2) : x;
  return { svg: `<text class="${cls}" x="${at}" y="${y}" text-anchor="${anchor}">${escText(text)}</text>`, left: anchor === 'start' ? at : anchor === 'end' ? at - w : at - w / 2, right: anchor === 'start' ? at + w : anchor === 'end' ? at : at + w / 2 };
}
const overlaps = (a, b, gap = 0) => a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom && b.top < a.bottom;

// ---------- tooltip ----------

// Shows the shared #tooltip next to the pointer (or the focused mark). `lines`: [{ value, label, key? }]
// where `key` is a CSS colour for a short line key. Values lead; labels follow; a line without a
// value is a muted heading. Above the point when there's room, else below.
export function showTip(tip, lines, x, y) {
  tip.replaceChildren();
  for (const l of lines.filter(Boolean)) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (l.key) {
      const k = document.createElement('span');
      k.className = 'tip-key';
      k.style.background = l.key;
      row.append(k);
    }
    if (l.value != null) {
      const v = document.createElement('strong');
      v.textContent = l.value;
      row.append(v);
    }
    if (l.label) {
      const t = document.createElement('span');
      t.className = 'muted';
      t.textContent = l.value != null ? ` ${l.label}` : l.label;
      row.append(t);
    }
    tip.append(row);
  }
  tip.hidden = false;
  tip.style.left = '0px';
  tip.style.top = '0px';
  // The visible page, without a classic scrollbar.
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(x + 12, vw - w - 8))}px`;
  const above = y - h - 10;
  tip.style.top = `${Math.max(8, Math.min(above >= 8 ? above : y + 18, vh - h - 8))}px`;
}

// Who the visible tooltip belongs to, and whether keyboard focus (rather than a pointer) opened it.
let owner = null;
export const tipOpenFor = (el) => owner?.el === el && document.getElementById('tooltip')?.hidden === false;

// Hides every tooltip, hover highlight and line-chart crosshair.
export function hideTips() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.hidden = true;
  owner = null;
  for (const n of document.querySelectorAll('.chart .hot')) n.classList.remove('hot');
  for (const n of document.querySelectorAll('.chart .dot, .chart .cross')) n.setAttribute('visibility', 'hidden');
}

// The tooltip lives in <body>, but a modal dialog sits above everything else: move it into the
// chart's open dialog while it points at a chart there.
function hostTip(svg, tip) {
  const host = svg.closest('dialog[open]') ?? document.body;
  if (tip.parentElement !== host) host.append(tip);
}

// Focus that the app puts back after re-rendering (focusQuietly) doesn't open a tooltip.
let quietFocus = false;
export function focusQuietly(el) {
  quietFocus = true;
  try { el.focus({ preventScroll: true }); } finally { quietFocus = false; }
}

if (hasDom) {
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTips(); });
  // A tap outside any chart closes a tooltip left open by a tap (touch has no "pointer left").
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.chart')) hideTips(); }, true);
  // Scrolling (the page, or a dialog) moves the chart away from a fixed tooltip: close it, unless it
  // belongs to the keyboard-focused mark and the mark is still in view (e.g. the browser scrolled it
  // into view), in which case it follows the mark.
  addEventListener('scroll', () => {
    if (document.getElementById('tooltip')?.hidden !== false) return;
    const el = owner?.el;
    if (el && owner.byFocus && el === document.activeElement && el.isConnected) {
      const r = (el.matches('svg.line-chart') ? el.querySelector('.dot') : el).getBoundingClientRect();
      if (r.top >= 0 && r.top < innerHeight && r.bottom > 0) { el.dispatchEvent(new FocusEvent('focus')); return; }
    }
    hideTips();
  }, { passive: true, capture: true });
}

// Hover, tap and keyboard focus on every element matching [data-tip] inside `svg`; `tips[i]` are its lines.
function wireTips(svg, tips) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  const at = (el, e) => {
    const lines = tips[Number(el.dataset.tip)];
    if (!lines) return;
    for (const n of svg.querySelectorAll('.hot')) n.classList.remove('hot');
    hostTip(svg, tip);
    if (e?.clientX != null) showTip(tip, lines, e.clientX, e.clientY);
    else { const b = el.getBoundingClientRect(); showTip(tip, lines, b.left + b.width / 2, b.top); }
    el.classList.add('hot');
    owner = { el, byFocus: e?.clientX == null };
  };
  // Only the mark that opened the tooltip closes it (a pointer leaving another mark doesn't).
  const off = (el) => {
    el.classList.remove('hot');
    if (owner?.el === el) { tip.hidden = true; owner = null; }
  };
  for (const el of svg.querySelectorAll('[data-tip]')) {
    el.addEventListener('pointermove', (e) => at(el, e));
    el.addEventListener('pointerdown', (e) => at(el, e));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !(owner?.byFocus && el === document.activeElement)) off(el); });
    // Keyboard focus opens the tooltip; a click's focus doesn't (the pointer already did).
    el.addEventListener('focus', () => { if (!quietFocus && el.matches(':focus-visible')) at(el); });
    el.addEventListener('blur', () => off(el));
  }
}

// ---------- shapes ----------

// A bar from x0 (the baseline) to x1, `h` tall at y, with a rounded end away from the baseline.
function barPath(x0, x1, y, h, r = 4) {
  const w = Math.abs(x1 - x0);
  if (w < 0.5) return '';
  r = Math.min(r, w, h / 2);
  if (x1 >= x0) return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 + r},${y + h}H${x0}Z`;
}

// A column from the baseline y0 up to y1 (smaller y is higher), rounded at the top.
function columnPath(x, w, y0, y1, r = 4) {
  const h = y0 - y1;
  if (h < 0.5) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
}

// ---------- horizontal bars ----------

// rows: [{ label, sub?, value, display, color?, marker?, tip: [{ value, label, key? }] }].
// Bars grow from zero, so negative values go left. `color` defaults to the sign (gain/loss) when
// `signColors` is set, else --series-1. `marker`: a thin tick on the same scale (e.g. the index),
// explained by `markerLabel` in a legend under the chart. `ref`: a vertical reference line (e.g. 50%
// for a coin flip) with `refLabel`. `tickFmt(value, decimals)` writes the axis.
// Labels sit left of the bars; when they would take more than 40% of the width (phones), each
// label moves onto its own line above its bar.
export function hbars(el, rows, { signColors = false, markerLabel = '', ref = null, refLabel = '', tickFmt = (v, d) => axisNum(v, d), domain = null, ariaLabel = 'Bar chart' } = {}) {
  if (!rows.length) { el.innerHTML = ''; return; }
  const W = Math.max(240, el.clientWidth || 600);
  const barH = 14, B = 22, T = refLabel ? 22 : 8;
  const catW = Math.max(...rows.map((r) => Math.max(textWidth(r.label, 12), r.sub ? textWidth(r.sub, 11) : 0)));
  // Room for the value labels: left of zero for losses, right of the bars for the rest.
  const gutter = (keep) => Math.max(0, ...rows.filter(keep).map((r) => textWidth(r.display, 12, 600) + 13));
  const hasNeg = rows.some((r) => r.value < 0);
  const valNeg = hasNeg ? gutter((r) => r.value < 0) : 2, valPos = Math.max(16, gutter((r) => r.value >= 0));
  const sideW = Math.max(40, catW + 12);
  // Labels move above their bars when beside them they'd take too much width or leave the bars too little.
  const stacked = sideW > W * 0.4 || W - sideW - valNeg - valPos - 6 < W * 0.4;
  const labelW = stacked ? 0 : sideW;
  const rowH = stacked ? 42 : rows.some((r) => r.sub) ? 38 : 30;
  const vals = rows.flatMap((r) => [r.value, r.marker ?? 0]).concat(ref ?? 0, 0, domain ?? []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) hi = lo + 1;
  const x0p = labelW + valNeg, x1p = Math.max(W - valPos - 6, x0p + 40);
  const x = (v) => x0p + ((v - lo) / (hi - lo)) * (x1p - x0p);
  const H = T + rows.length * rowH + B;

  // Ticks: as many as fit, round, and never overlapping, with at least two labelled. Zero wins a
  // collision, unless that would leave it the only label (the baseline marks zero anyway).
  const layoutTicks = (c, zeroWins) => {
    const { decimals } = niceStep(lo, hi, c);
    const marks = [];
    for (const t of niceTicks(lo, hi, c).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9)) {
      let lab = axisLabel(x(t), H - 6, tickFmt(t, decimals), W);
      let prev = marks.findLast((m) => m.lab);
      if (prev && lab.left < prev.lab.right + 6) {
        if (zeroWins ? t === 0 : prev.t === 0) {
          prev.lab = null;
          prev = marks.findLast((m) => m.lab);
          if (prev && lab.left < prev.lab.right + 6) lab = null;
        } else lab = null;
      }
      marks.push({ t, lab });
    }
    return marks;
  };
  const labelled = (ms) => ms.filter((m) => m.lab).length;
  const fitCount = Math.max(2, Math.min(5, Math.floor((x1p - x0p) / 64)));
  let marks = null;
  for (const c of [fitCount, fitCount + 1, fitCount + 2, fitCount - 1, fitCount + 3].filter((v) => v >= 2)) {
    for (const zeroWins of [true, false]) {
      const ms = layoutTicks(c, zeroWins);
      if (labelled(ms) >= 2) { marks = ms; break; }
    }
    if (marks) break;
  }
  marks ??= layoutTicks(fitCount, true);
  if (!marks.some((m) => m.t === 0)) marks.push({ t: 0, lab: null });
  const tickSvg = marks.map(({ t, lab }) => `<line class="${t === 0 ? 'baseline' : 'grid'}" x1="${x(t)}" x2="${x(t)}" y1="${T - 4}" y2="${H - B + 2}"/>${lab ? lab.svg : ''}`);

  const tips = [];
  const body = rows.map((r, i) => {
    const top = T + i * rowH;
    const y = stacked ? top + 20 : top + (rowH - barH) / 2;
    const color = r.color ?? (signColors ? (r.value > 0 ? 'var(--up)' : r.value < 0 ? 'var(--down)' : 'var(--muted)') : 'var(--series-1)');
    const x0 = x(0);
    let endX = x(r.value);
    // A value too small to see still gets a mark: a 2px stub, or a dot at zero for exactly zero.
    let mark;
    if (r.value === 0) { mark = `<circle cx="${x0}" cy="${y + barH / 2}" r="3.5" fill="${color}"/>`; endX = x0 + 3; }
    else {
      if (Math.abs(endX - x0) < 2) endX = x0 + Math.sign(r.value) * 2;
      mark = `<path class="bar" d="${barPath(x0, endX, y, barH)}" fill="${color}"/>`;
    }
    const neg = r.value < 0;
    // The value sits past the bar's end, and past the marker too when the marker would cross it.
    let lx = neg ? endX - 6 : endX + 6;
    if (r.marker != null) {
      const mx = x(r.marker), w = textWidth(r.display, 12, 600);
      if (neg ? mx < lx + 3 && mx > lx - w - 3 : mx > lx - 3 && mx < lx + w + 3) lx = neg ? mx - 6 : mx + 6;
    }
    tips.push(r.tip);
    let label;
    if (stacked) {
      // One line above the bar: the label, then as much of the sub-label as fits.
      const lab = fitText(r.label, r.sub ? Math.max(W * 0.55, W - 12 - textWidth(r.sub, 11)) : W - 6);
      const room = W - 6 - textWidth(lab, 12) - 6;
      const sub = r.sub && room >= 30 ? fitText(r.sub, room, 11) : '';
      label = `<text class="cat" x="2" y="${top + 13}">${escText(lab)}${sub ? `<tspan class="cat-sub" dx="6">${escText(sub)}</tspan>` : ''}</text>`;
    } else label = `<text class="cat" x="${labelW - 8}" y="${y + barH / 2 + (r.sub ? -1 : 4)}" text-anchor="end">${escText(r.label)}</text>
        ${r.sub ? `<text class="cat-sub" x="${labelW - 8}" y="${y + barH / 2 + 12}" text-anchor="end">${escText(r.sub)}</text>` : ''}`;
    return `<g class="bar-row" data-tip="${i}" tabindex="0" role="listitem" aria-label="${escText(`${r.label}${r.sub ? ` (${r.sub})` : ''}: ${r.display}`)}">
      <rect class="hit" x="1" y="${top + 1}" width="${W - 2}" height="${rowH - 2}" rx="4"/>
      ${label}${mark}
      ${r.marker != null ? `<line class="marker" x1="${x(r.marker)}" x2="${x(r.marker)}" y1="${y - 4}" y2="${y + barH + 4}"/>` : ''}
      <text class="val" x="${lx}" y="${y + barH / 2 + 4}" text-anchor="${neg ? 'end' : 'start'}">${escText(r.display)}</text>
    </g>`;
  }).join('');
  const refSvg = ref == null ? '' : `<line class="ref" x1="${x(ref)}" x2="${x(ref)}" y1="${T - 4}" y2="${H - B + 2}"/>${refLabel ? axisLabel(x(ref), T - 8, refLabel, W).svg : ''}`;
  el.innerHTML = `<svg class="chart hbars" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="list" aria-label="${escText(ariaLabel)}">
    ${tickSvg.join('')}${refSvg}${body}
  </svg>${markerLabel && rows.some((r) => r.marker != null) ? `<ul class="legend-list"><li><span class="swatch swatch-tick"></span><span>${escText(markerLabel)}</span></li></ul>` : ''}`;
  wireTips(el.querySelector('svg'), tips);
}

// ---------- likely ranges ----------

// rows: [{ label, sub?, value, lo, hi, display, tip: [{ value, label }] }]: each row's likely range as a
// thin bar from lo to hi (a pale version of --series-1), with a dot at the estimate. The estimate's
// value is written past the range's end: to the right from zero up, to the left below zero. Zero is
// the baseline. Labels sit left of the ranges, or on their own line above each range when they would
// take more than 40% of the width (phones), as in hbars.
export function rangeBars(el, rows, { tickFmt = (v, d) => axisNum(v, d), ariaLabel = 'Likely ranges' } = {}) {
  if (!rows.length) { el.innerHTML = ''; return; }
  const W = Math.max(240, el.clientWidth || 600);
  const B = 22, T = 8;
  const catW = Math.max(...rows.map((r) => Math.max(textWidth(r.label, 12), r.sub ? textWidth(r.sub, 11) : 0)));
  const valW = Math.max(...rows.map((r) => textWidth(r.display, 12, 600))) + 12;
  const sideW = Math.max(40, catW + 12);
  const stacked = sideW > W * 0.4 || W - sideW - 2 * valW < W * 0.4;
  const labelW = stacked ? 0 : sideW;
  const rowH = stacked ? 44 : rows.some((r) => r.sub) ? 38 : 30;
  let lo = Math.min(0, ...rows.map((r) => r.lo)), hi = Math.max(0, ...rows.map((r) => r.hi));
  if (lo === hi) hi = lo + 1;
  const x0p = labelW + valW, x1p = Math.max(W - valW, x0p + 40);
  const x = (v) => x0p + ((v - lo) / (hi - lo)) * (x1p - x0p);
  const H = T + rows.length * rowH + B;

  // Round ticks, labelled while they don't collide (zero is always drawn as the baseline).
  const count = Math.max(2, Math.min(5, Math.floor((x1p - x0p) / 64)));
  const { decimals } = niceStep(lo, hi, count);
  let right = -Infinity;
  const ticks = niceTicks(lo, hi, count).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
  if (!ticks.includes(0)) ticks.push(0);
  const tickSvg = ticks.sort((a, b) => a - b).map((t) => {
    const lab = axisLabel(x(t), H - 6, tickFmt(t, decimals), W);
    const show = lab.left >= right + 6;
    if (show) right = lab.right;
    return `<line class="${t === 0 ? 'baseline' : 'grid'}" x1="${x(t)}" x2="${x(t)}" y1="${T - 4}" y2="${H - B + 2}"/>${show ? lab.svg : ''}`;
  });

  const tips = [];
  const body = rows.map((r, i) => {
    const top = T + i * rowH;
    const y = stacked ? top + 30 : top + rowH / 2;
    const a = x(r.lo), b = Math.max(x(r.hi), a + 2), c = x(r.value);
    const neg = r.value < 0;
    tips.push(r.tip);
    let label;
    if (stacked) {
      const lab = fitText(r.label, r.sub ? Math.max(W * 0.55, W - 12 - textWidth(r.sub, 11)) : W - 6);
      const room = W - 6 - textWidth(lab, 12) - 6;
      const sub = r.sub && room >= 30 ? fitText(r.sub, room, 11) : '';
      label = `<text class="cat" x="2" y="${top + 13}">${escText(lab)}${sub ? `<tspan class="cat-sub" dx="6">${escText(sub)}</tspan>` : ''}</text>`;
    } else label = `<text class="cat" x="${labelW - 8}" y="${y + (r.sub ? -3 : 4)}" text-anchor="end">${escText(r.label)}</text>
        ${r.sub ? `<text class="cat-sub" x="${labelW - 8}" y="${y + 11}" text-anchor="end">${escText(r.sub)}</text>` : ''}`;
    return `<g class="bar-row" data-tip="${i}" tabindex="0" role="listitem" aria-label="${escText(`${r.label}${r.sub ? ` (${r.sub})` : ''}: ${r.display}, likely ${tickFmt(r.lo, 1)} to ${tickFmt(r.hi, 1)}`)}">
      <rect class="hit" x="1" y="${top + 1}" width="${W - 2}" height="${rowH - 2}" rx="4"/>
      ${label}
      <rect class="range" x="${a}" y="${y - 3}" width="${b - a}" height="6" rx="3"/>
      <circle class="est" cx="${c}" cy="${y}" r="5"/>
      <text class="val" x="${neg ? a - 8 : b + 8}" y="${y + 4}" text-anchor="${neg ? 'end' : 'start'}">${escText(r.display)}</text>
    </g>`;
  }).join('');
  el.innerHTML = `<svg class="chart ranges" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="list" aria-label="${escText(ariaLabel)}">
    ${tickSvg.join('')}${body}
  </svg><ul class="legend-list"><li><span class="swatch swatch-range"></span><span>Likely range</span></li><li><span class="swatch swatch-dot"></span><span>Best estimate</span></li></ul>`;
  wireTips(el.querySelector('svg'), tips);
}

// ---------- one 100% stacked bar (part-to-whole) ----------

// segments: [{ label, value, color, display }] (positive values). The legend lists every segment
// with its share and value, so nothing depends on hovering or on telling colours apart.
// `shares: false` leaves the percentages out (e.g. a meter against a cap, where the last segment is
// what's left). `mark`: a tick at that value on the same scale (e.g. a cap that was overspent),
// named `markLabel` in the legend.
export function stackBar(el, segments, { ariaLabel = 'Stacked bar', shares = true, mark = null, markLabel = '' } = {}) {
  const segs = segments.filter((s) => s.value > 0);
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) { el.innerHTML = ''; return; }
  const W = Math.max(240, el.clientWidth || 600), H = 20, gap = 2;
  const pcts = shareLabels(segs.map((s) => s.value));
  let at = 0;
  const tips = [];
  const parts = segs.map((s, i) => {
    const w = (s.value / total) * W;
    const x = at;
    at += w;
    tips.push([{ value: shares ? pcts[i] : s.display, label: shares ? `${s.label} · ${s.display}` : s.label, key: s.color }]);
    const inner = Math.max(0, w - (i < segs.length - 1 ? gap : 0));
    const r = Math.min(4, inner / 2);
    const first = i === 0, last = i === segs.length - 1;
    const d = inner < 1 ? '' : `M${x + (first ? r : 0)},0H${x + inner - (last ? r : 0)}${last ? `Q${x + inner},0 ${x + inner},${r}V${H - r}Q${x + inner},${H} ${x + inner - r},${H}` : `V${H}`}H${x + (first ? r : 0)}${first ? `Q${x},${H} ${x},${H - r}V${r}Q${x},0 ${x + r},0` : 'V0'}Z`;
    return `<g data-tip="${i}" tabindex="0" role="listitem" aria-label="${escText(`${s.label}: ${shares ? `${pcts[i]}, ` : ''}${s.display}`)}"><rect class="hit" x="${x + (first ? 1 : 0)}" y="-5" width="${Math.max(0, w - (first ? 1 : 0) - (last ? 1 : 0))}" height="${H + 10}" rx="4"/><path class="seg${s.track ? ' track' : ''}" d="${d}" fill="${s.color}"/><rect class="ring" x="${x + 1}" y="-4" width="${Math.max(0, inner - 2)}" height="${H + 8}" rx="4"/></g>`;
  }).join('');
  const markX = mark != null && mark > 0 && mark < total ? (mark / total) * W : null;
  el.innerHTML = `<svg class="chart stack" viewBox="0 -6 ${W} ${H + 12}" width="${W}" height="${H + 12}" role="list" aria-label="${escText(ariaLabel)}">${parts}${markX != null ? `<line class="marker" x1="${markX}" x2="${markX}" y1="-4" y2="${H + 4}"/>` : ''}</svg>
    <ul class="legend-list">${segs.map((s, i) => `<li><span class="swatch${s.track ? ' track' : ''}" style="background:${s.color}"></span><span>${escText(s.label)} ${shares ? `<strong>${pcts[i]}</strong> <span class="muted">${escText(s.display)}</span>` : `<strong>${escText(s.display)}</strong>`}</span></li>`).join('')}${markX != null && markLabel ? `<li><span class="swatch swatch-tick"></span><span>${escText(markLabel)}</span></li>` : ''}</ul>`;
  wireTips(el.querySelector('svg'), tips);
}

// ---------- stacked columns over time (e.g. AI spend by month) ----------

// groups: [{ label, axis?, axisLong?, values: { [seriesKey]: number } }]; series: [{ key, label, color }].
// `label` names the group in the tooltip, `axis` (default `label`) under its column; when names
// don't all fit, the first and last stay and others are left out, and a year that was left out
// moves to the next name shown (its `axisLong`, e.g. 'Jan 2026'). `ref`: a
// horizontal threshold (e.g. the monthly cap). `fmt` writes values, `tickFmt(value, decimals)` the axis.
// Totals are written on top of the columns where they fit (else the latest and the largest only).
export function columns(el, groups, series, { ref = null, refLabel = '', fmt = (v) => String(v), tickFmt = (v, d) => axisNum(v, d), height = 170, ariaLabel = 'Column chart' } = {}) {
  if (!groups.length) { el.innerHTML = ''; return; }
  const W = Math.max(240, el.clientWidth || 600), H = height, R = 8, T = 20, B = 22;
  const totals = groups.map((g) => series.reduce((s, x) => s + (g.values[x.key] ?? 0), 0));
  const max = Math.max(...totals, ref ?? 0) * 1.08 || 1;
  const { step, decimals } = niceStep(0, max, 4);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = niceTicks(0, top, Math.round(top / step));
  const L = Math.max(...ticks.map((t) => textWidth(tickFmt(t, decimals), 11))) + 10;
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const slot = Math.min(96, (W - L - R) / groups.length);
  const colW = Math.min(24, slot * 0.6);
  const maxI = totals.indexOf(Math.max(...totals));
  const labelFits = totals.every((t) => textWidth(fmt(t), 12, 600) <= slot - 4);
  const tips = [];
  const totalBoxes = [];
  // Month names under the columns: the last always, then the others from the left that fit.
  const n = groups.length, cx = (i) => L + i * slot + slot / 2;
  const texts = groups.map((g) => g.axis ?? g.label);
  const box = (i) => axisLabel(cx(i), H - 6, texts[i], W);
  const shown = new Set([n - 1]);
  let prevRight = -Infinity;
  for (let i = 0; i < n - 1; i++) {
    const b = box(i);
    if (b.left >= prevRight + 4 && b.right <= box(n - 1).left - 4) { shown.add(i); prevRight = b.right; }
  }
  for (let i = 0; i < n; i++) {
    // A year left out goes on the next name shown, if the longer name still fits there.
    if (shown.has(i) || !groups[i].axisLong || texts[i] !== groups[i].axisLong) continue;
    for (const j of [...shown].filter((k) => k > i).sort((a, b) => a - b)) {
      if (!groups[j].axisLong || texts[j] === groups[j].axisLong) break;
      const before = texts[j];
      texts[j] = groups[j].axisLong;
      const b = box(j), right = [...shown].filter((k) => k > j).sort((a, b) => a - b)[0];
      let left = [...shown].filter((k) => k < j).sort((a, b) => b - a)[0];
      // Room for the year can come from leaving out the name before (never the first).
      if (left > 0 && b.left < box(left).right + 4) { shown.delete(left); left = [...shown].filter((k) => k < j).sort((a, b) => b - a)[0]; }
      if ((left != null && b.left < box(left).right + 4) || (right != null && b.right > box(right).left - 4) || b.right > W) texts[j] = before;
      else break;
    }
  }
  const cols = groups.map((g, i) => {
    const x = L + i * slot + (slot - colW) / 2;
    let acc = 0;
    const present = series.filter((s) => (g.values[s.key] ?? 0) > 0);
    const segs = present.map((s, j) => {
      const v = g.values[s.key];
      const y0 = y(acc) - (j ? 1 : 0), y1 = y(acc + v) + (j < present.length - 1 ? 1 : 0);
      acc += v;
      return j === present.length - 1 ? `<path d="${columnPath(x, colW, y0, y1)}" fill="${s.color}"/>` : `<rect x="${x}" y="${y1}" width="${colW}" height="${Math.max(0, y0 - y1)}" fill="${s.color}"/>`;
    }).join('');
    tips.push([{ value: fmt(totals[i]), label: g.label }, ...present.map((s) => ({ value: fmt(g.values[s.key]), label: s.label, key: s.color }))]);
    let total = '';
    if (labelFits || i === groups.length - 1 || i === maxI) {
      const lab = axisLabel(x + colW / 2, y(totals[i]) - 5, fmt(totals[i]), W, 12, 600, 'val');
      totalBoxes.push({ left: lab.left, right: lab.right, top: y(totals[i]) - 18, bottom: y(totals[i]) - 2 });
      total = lab.svg;
    }
    return `<g data-tip="${i}" tabindex="0" role="listitem" aria-label="${escText(`${g.label}: ${fmt(totals[i])}`)}">
      <rect class="hit" x="${L + i * slot + 1}" y="${T}" width="${slot - 2}" height="${H - T - B}" rx="4"/>${segs}
      ${total}${shown.has(i) ? box(i).svg : ''}</g>`;
  }).join('');
  // The reference's label goes where it doesn't cover a column's total, or is left to the caption.
  let refText = '';
  if (ref && refLabel) {
    const w = textWidth(refLabel, 11);
    for (const [xx, anchor, yy] of [[W - R, 'end', y(ref) - 5], [L + 4, 'start', y(ref) - 5], [W - R, 'end', y(ref) + 13], [L + 4, 'start', y(ref) + 13]]) {
      const box = { left: anchor === 'end' ? xx - w : xx, right: anchor === 'end' ? xx : xx + w, top: yy - 11, bottom: yy + 2 };
      if (yy - 11 < 0 || totalBoxes.some((t) => overlaps(box, t, 4))) continue;
      refText = `<text class="axis ref-label" x="${xx}" y="${yy}" text-anchor="${anchor}">${escText(refLabel)}</text>`;
      break;
    }
  }
  el.innerHTML = `<svg class="chart cols" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="list" aria-label="${escText(ariaLabel)}">
    ${ticks.map((t) => `<line class="${t === 0 ? 'baseline' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${escText(tickFmt(t, decimals))}</text>`).join('')}
    ${ref ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>` : ''}
    ${cols}${refText}
  </svg>
  ${series.length > 1 ? `<ul class="legend-list">${series.map((s) => `<li><span class="swatch" style="background:${s.color}"></span><span>${escText(s.label)}</span></li>`).join('')}</ul>` : ''}`;
  wireTips(el.querySelector('svg'), tips);
}

// ---------- line over time ----------

// points: [{ label, axis?, t?, value, compare?, ref? }]: `label` for the tooltip, `axis` under the
// chart, `t` (ms) when `time` is set. `compare` draws a second, grey line (e.g. the index);
// `ref` (per point, or the `ref` option for a constant) a dashed reference such as the money put in,
// labelled `refLabel` (left out if it's constant and the value never leaves it). `step`: the value holds until the next
// point (e.g. realized profit), drawn on a `time` scale. `endLabel`: dot and value at the end.
// Hover, tap or drag to read it; it takes keyboard focus, and the arrow keys step through the points.
export function lineChart(el, points, {
  ref = null, refLabel = '', fmt = (v) => String(v), height = 180, compareLabel = '', mainLabel = 'Value',
  time = false, step = false, endLabel = false, title = 'Line chart', axisFmt = null,
} = {}) {
  if (points.length < 2) { el.innerHTML = '<p class="muted small">Not enough data for a chart yet.</p>'; return; }
  const n = points.length;
  const W = Math.max(240, el.clientWidth || 600), H = height, R = 12, T = endLabel ? 24 : 12, B = 22;
  const refs = points.map((p) => p.ref ?? ref);
  const firstRef = refs.find((v) => v != null);
  const refVaries = refs.some((v) => v != null && v !== firstRef);
  const hasRef = firstRef != null && (refVaries || !points.every((p, i) => refs[i] == null || Math.abs(p.value - refs[i]) < 0.005));
  const hasCompare = points.filter((p) => p.compare != null).length >= 2;
  const vals = points.map((p) => p.value).concat(hasRef ? refs.filter((v) => v != null) : [], hasCompare ? points.map((p) => p.compare).filter((v) => v != null) : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < Math.abs(hi) * 1e-6 || hi === lo) { const d = Math.abs(lo) * 0.02 || 1; lo -= d; hi += d; }
  const pad = (hi - lo) * 0.06;
  lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  hi = hi <= 0 && hi + pad > 0 ? 0 : hi + pad;
  const { step: tickStep, decimals } = niceStep(lo, hi, 4);
  lo = Math.floor(lo / tickStep + 1e-9) * tickStep;
  hi = Math.ceil(hi / tickStep - 1e-9) * tickStep;
  const ticks = [];
  for (let k = Math.round(lo / tickStep); k * tickStep <= hi + tickStep * 1e-9; k++) ticks.push(Number((k * tickStep).toFixed(decimals)) || 0);
  const L = Math.max(28, ...ticks.map((t) => textWidth(axisNum(t, decimals), 11))) + 10;
  const plotW = W - L - R;
  const t0 = time ? points[0].t : 0, t1 = time ? points.at(-1).t : 1;
  const px = points.map((p, i) => L + (time ? (t1 > t0 ? (p.t - t0) / (t1 - t0) : 1) : i / (n - 1)) * plotW);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const f1 = (v) => v.toFixed(1);
  const line = (vs, stepped) => {
    let d = '', on = false;
    vs.forEach((v, i) => {
      if (v == null) { on = false; return; }
      if (!on) d += `M${f1(px[i])},${f1(y(v))}`;
      else d += stepped ? `H${f1(px[i])}V${f1(y(v))}` : `L${f1(px[i])},${f1(y(v))}`;
      on = true;
    });
    return d;
  };
  const path = line(points.map((p) => p.value), step);
  const path2 = hasCompare ? line(points.map((p) => p.compare), false) : '';
  const refPath = hasRef ? line(refs, true) : '';
  const lastRef = hasRef ? refs.filter((v) => v != null).at(-1) : null;

  // Date labels along the bottom: the ends, and ones between that don't collide: on a time scale,
  // the first of every month, quarter or year that fits; otherwise evenly spaced points.
  const xLabels = [];
  const labelAt = (i) => points[i].axis ?? points[i].label;
  const firstSvg = `<text class="axis" x="${L}" y="${H - 4}">${escText(labelAt(0))}</text>`;
  const lastSvg = `<text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${escText(labelAt(n - 1))}</text>`;
  const firstRight = L + textWidth(labelAt(0), 11), lastLeft = W - R - textWidth(labelAt(n - 1), 11);
  const place = (list) => {
    const out = [];
    let prevRight = firstRight, prevText = labelAt(0), clash = false;
    for (const [xx, text] of list) {
      if (text === prevText) continue;
      const lab = axisLabel(xx, H - 4, text, W);
      if (lab.left < firstRight + 16 || lab.right > lastLeft - 16) continue; // too close to an end label
      if (lab.left < prevRight + 16) { clash = true; continue; }
      out.push(`<line class="grid" x1="${xx}" x2="${xx}" y1="${H - B}" y2="${H - B + 4}"/>${lab.svg}`);
      prevRight = lab.right; prevText = text;
    }
    return { out, clash };
  };
  if (time && t1 > t0) {
    // The finest regular step (1, 2, 3, 6 or 12 months, or more) whose labels all fit.
    const fmtT = axisFmt ?? ((t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
    for (const stepM of [1, 2, 3, 6, 12, 24, 60, 120]) {
      const list = [];
      const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
      for (; d.getTime() < t1; d.setMonth(d.getMonth() + 1)) {
        if ((d.getFullYear() * 12 + d.getMonth()) % stepM) continue;
        list.push([L + ((d.getTime() - t0) / (t1 - t0)) * plotW, fmtT(d.getTime())]);
      }
      const r = place(list);
      if (!r.clash) { xLabels.push(...r.out); break; }
    }
  } else if (!time) {
    const slots = Math.max(0, Math.floor(plotW / (textWidth(labelAt(0), 11) + 32)) - 1);
    const list = [];
    for (let k = 1; k <= slots; k++) { const i = Math.round((k / (slots + 1)) * (n - 1)); list.push([px[i], labelAt(i)]); }
    xLabels.push(...place(list).out);
  }

  // Does a drawn line pass through a label's box? Used to place labels where they don't.
  const drawn = [[points.map((p) => p.value), step], ...(hasCompare ? [[points.map((p) => p.compare), false]] : [])];
  const crosses = (box) => drawn.some(([vs, stepped]) => {
    for (let i = 0; i < n - 1; i++) {
      const a = vs[i], b = vs[i + 1];
      if (a == null || b == null || px[i + 1] < box.left || px[i] > box.right) continue;
      let ys;
      if (stepped) ys = px[i + 1] <= box.right ? [y(a), y(b)] : [y(a)];
      else {
        const at = (xx) => y(a + (b - a) * ((xx - px[i]) / (px[i + 1] - px[i] || 1)));
        ys = [at(Math.max(px[i], box.left)), at(Math.min(px[i + 1], box.right))];
      }
      if (Math.max(...ys) >= box.top - 2 && Math.min(...ys) <= box.bottom + 2) return true;
    }
    return false;
  });
  // The first of `spots` ([x, baseline y, anchor]) where `text` fits inside the plot without
  // touching a line, or null.
  const clearSpot = (text, spots, size = 11, weight = 400) => {
    const w = textWidth(text, size, weight) + (weight >= 600 ? 3 : 0);
    for (const [xx, yy, anchor] of spots) {
      const box = { left: anchor === 'end' ? xx - w : xx, right: anchor === 'end' ? xx : xx + w, top: yy - size + 1, bottom: yy + 3 };
      if (box.top >= 2 && box.bottom <= H - B && box.left >= 0 && !crosses(box)) return [xx, yy, anchor];
    }
    return null;
  };

  // The end: a dot and the value, above or below the end of the line, wherever no line runs.
  const last = points.at(-1), yLast = y(last.value);
  let endSvg = '';
  if (endLabel) {
    const text = fmt(last.value);
    let k = n - 1;
    while (k > 0 && points[k - 1].value === last.value) k--;
    const spot = clearSpot(text, [[px[n - 1] - 6, yLast - 8, 'end'], [px[n - 1] - 6, yLast + 18, 'end'], [px[k] - 6, yLast - 8, 'end'], [px[k] - 6, yLast + 18, 'end']], 12, 600);
    endSvg = `<circle class="end-dot" cx="${px[n - 1]}" cy="${yLast}" r="4"/>${spot ? `<text class="val" x="${spot[0]}" y="${spot[1]}" text-anchor="${spot[2]}">${escText(text)}</text>` : ''}`;
  }
  // The reference's name, at either end above or below it where no line runs; else in the legend.
  const firstRefV = refs.find((v) => v != null);
  const refSpot = refPath && refLabel ? clearSpot(refLabel, [[W - R, y(lastRef) - 5, 'end'], [W - R, y(lastRef) + 14, 'end'], [L + 4, y(firstRefV) - 5, 'start'], [L + 4, y(firstRefV) + 14, 'start']]) : null;
  const refInLegend = Boolean(refPath && refLabel && !refSpot);
  const pointText = (i) => {
    const p = points[i];
    return [`${p.label}: ${fmt(p.value)}`, hasCompare && p.compare != null ? `${compareLabel} ${fmt(p.compare)}` : '', refVaries && refs[i] != null ? `${refLabel} ${fmt(refs[i])}` : ''].filter(Boolean).join(', ');
  };
  const summary = `${title}: ${fmt(points[0].value)} (${points[0].label}) to ${fmt(last.value)} (${last.label}). Use the arrow keys to read each point.`;
  el.innerHTML = `
    <svg class="chart line-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" tabindex="0" role="slider" aria-roledescription="line chart" aria-label="${escText(summary)}"
      aria-valuemin="0" aria-valuemax="${n - 1}" aria-valuenow="${n - 1}" aria-valuetext="${escText(pointText(n - 1))}">
      ${ticks.map((v) => `<line class="${v === 0 ? 'baseline' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${escText(axisNum(v, decimals))}</text>`).join('')}
      ${refPath ? `<path class="ref" d="${refPath}"/>` : ''}
      ${firstSvg}${xLabels.join('')}${lastSvg}
      ${path2 ? `<path class="line2" d="${path2}"/>` : ''}
      <path class="line" d="${path}"/>
      ${refSpot ? `<text class="axis ref-label" x="${refSpot[0]}" y="${refSpot[1]}" text-anchor="${refSpot[2]}">${escText(refLabel)}</text>` : ''}
      ${endSvg}
      <line class="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <circle class="dot" r="4" visibility="hidden"/>
      <rect class="hit" x="${L}" y="0" width="${plotW}" height="${H}"/>
    </svg>${path2 || refInLegend ? `<ul class="legend-list"><li><span class="line-key"></span><span>${escText(mainLabel)}</span></li>${path2 ? `<li><span class="line-key compare"></span><span>${escText(compareLabel)}</span></li>` : ''}${refInLegend ? `<li><span class="line-key ref"></span><span>${escText(refLabel)}</span></li>` : ''}</ul>` : ''}`;

  const svg = el.querySelector('svg'), cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot');
  const hit = svg.querySelector('.hit'), tip = document.getElementById('tooltip');
  let cur = null;
  const indexAt = (clientX) => {
    const box = svg.getBoundingClientRect();
    const xx = (clientX - box.left) * (W / box.width);
    if (step) { let i = 0; while (i < n - 1 && px[i + 1] <= xx) i++; return i; }
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(px[i] - xx) < Math.abs(px[best] - xx)) best = i;
    return best;
  };
  const show = (i, cx, cy) => {
    cur = i;
    const p = points[i];
    svg.dataset.at = p.label;
    svg.setAttribute('aria-valuenow', i);
    svg.setAttribute('aria-valuetext', pointText(i));
    cross.setAttribute('x1', px[i]); cross.setAttribute('x2', px[i]); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px[i]); dot.setAttribute('cy', y(p.value)); dot.setAttribute('visibility', 'visible');
    if (!tip) return;
    hostTip(svg, tip);
    owner = { el: svg, byFocus: cx == null };
    if (cx == null) { const b = dot.getBoundingClientRect(); cx = b.left + b.width / 2; cy = b.top; }
    const many = hasCompare || refVaries;
    showTip(tip, [
      many ? { label: p.label } : null,
      { value: fmt(p.value), label: many ? mainLabel : p.label, key: many ? 'var(--series-1)' : null },
      hasCompare && p.compare != null ? { value: fmt(p.compare), label: compareLabel, key: 'var(--series-compare)' } : null,
      refVaries && refs[i] != null ? { value: fmt(refs[i]), label: refLabel } : null,
    ], cx, cy);
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    if (tip && owner?.el === svg) { tip.hidden = true; owner = null; }
  };
  const onPointer = (e) => show(indexAt(e.clientX), e.clientX, e.clientY);
  hit.addEventListener('pointermove', onPointer);
  hit.addEventListener('pointerdown', onPointer);
  hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !(owner?.byFocus && svg === document.activeElement)) hide(); });
  // Where keyboard reading starts: the point read before a redraw (kept in data-at by the app), else the end.
  const start = () => { const k = svg.dataset.at ? points.findIndex((p) => p.label === svg.dataset.at) : -1; return k >= 0 ? k : n - 1; };
  svg.addEventListener('focus', () => {
    const i = cur ?? start();
    if (!quietFocus && svg.matches(':focus-visible')) { show(i); return; }
    // Focus put back after a redraw, or from a click: just say which point reading continues from.
    svg.setAttribute('aria-valuenow', i);
    svg.setAttribute('aria-valuetext', pointText(i));
  });
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const at = cur ?? start();
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, ArrowDown: at - 1, ArrowUp: at + 1, Home: 0, End: n - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    show(Math.max(0, Math.min(n - 1, to)));
  });
}

// ---------- table view ----------

// A "Table" switch under a chart that shows the same numbers as a table (for screen readers,
// exact values, and anyone who'd rather read than hover). `head`: column titles; `rows`: arrays of text.
export function tableToggle(head, rows, numericFrom = 1, { className = '' } = {}) {
  if (!rows.length) return '';
  return `<details class="chart-table${className ? ` ${escText(className)}` : ''}"><summary>Table</summary><div class="table-wrap" tabindex="0"><table>
    <thead><tr>${head.map((h, i) => `<th class="${i >= numericFrom ? 'num' : ''}">${escText(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i >= numericFrom ? 'num' : ''}">${escText(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div></details>`;
}

export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const OTHER = 'var(--series-other)';
export const CASH = 'var(--series-cash)';
export const TRACK = 'var(--grid)';
