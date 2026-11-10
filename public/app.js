/* Risk Sheet — interface logic. All figures are calculated by the server; this file only displays them.
   Two separate portfolios are shown as two pages: #/us (United States) and #/bh (Bahrain). */

const CAP_TIERS = ["Mega Cap", "Large Cap", "Mid Cap", "Small Cap", "Micro Cap"];
const MARKET_UI = {
  us: { label: "United States", prefix: "$", decimals: 2, placeholder: "AAPL", hint: "" },
  bh: { label: "Bahrain", prefix: "BD ", decimals: 3, placeholder: "ALBH", hint: "Use the Bahrain Bourse symbol, for example ALBH, NBB or BBK." },
};

const state = {
  market: "us", config: null,
  positions: [], cash: 0, allocations: {}, analytics: null,
  loading: true, sort: { key: null, dir: 1 }, filter: "", sectorChart: "bar",
  view: "overview", signature: "", editingId: null, customBenchmark: false,
};
const charts = [];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ui = (m) => MARKET_UI[m || state.market] || MARKET_UI.us;

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNum = (v) => typeof v === "number" && isFinite(v);
function money(v, d, m) {
  if (!isNum(v)) return "—";
  const u = ui(m), digits = d ?? u.decimals;
  return (v < 0 ? "−" : "") + u.prefix + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const moneyShort = (v) => (isNum(v) ? ui().prefix + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v) : "—");
const pct = (v, d = 2) => (isNum(v) ? (v * 100).toFixed(d) + "%" : "—");
const signedPct = (v) => (isNum(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(2) + "%" : "—");
const num = (v, d = 2) => (isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const shares = (v) => (isNum(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—");
const signClass = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");

/* Column definitions, shared by the positions table and the report builder. */
const COLS = [
  { k: "ticker", h: "Ticker", type: "text" },
  { k: "sector", h: "Sector", type: "text" },
  { k: "date_bought", h: "Date bought", type: "text" },
  { k: "shares", h: "Shares", type: "shares" },
  { k: "price_bought", h: "Price bought", type: "money" },
  { k: "value_paid", h: "Value paid", type: "money" },
  { k: "current_price", h: "Current price", type: "money" },
  { k: "position_value", h: "Current value", type: "money" },
  { k: "pct_change", h: "Profit / loss", type: "delta" },
  { k: "entry_atr", h: "Entry ATR", type: "num", d: 4 },
  { k: "no_atrs", h: "No. ATRs", type: "num", d: 2 },
  { k: "take_profit", h: "Take profit (entry)", type: "money" },
  { k: "stop_loss", h: "Stop loss (entry)", type: "money" },
  { k: "current_tp", h: "Take profit (now)", type: "money" },
  { k: "current_sl", h: "Stop loss (now)", type: "money" },
  { k: "beta", h: "Beta", type: "num", d: 2 },
  { k: "weight", h: "Weight", type: "pct" },
  { k: "beta_weighted", h: "Beta × weight", type: "num", d: 4 },
  { k: "expected_return", h: "Expected return", type: "pct" },
  { k: "weighted_expected_return", h: "Weighted exp. return", type: "pct" },
  { k: "var", h: "VaR (95%)", type: "money" },
  { k: "iv", h: "Implied volatility", type: "pct" },
  { k: "holding_period", h: "Days held", type: "num", d: 0 },
  { k: "cap_formatted", h: "Market cap", type: "text", sortKey: "market_cap", capOnly: true },
  { k: "cap_tier", h: "Cap tier", type: "text", capOnly: true },
];
/* Columns that apply to the market being shown (Bahrain listings have no market-cap data). */
const activeCols = (d) => COLS.filter((c) => !c.capOnly || d.hasCaps);

function fmtCell(col, row) {
  const v = row[col.k];
  if (v === null || v === undefined || v === "") return "—";
  switch (col.type) {
    case "money": return money(v);
    case "pct": return pct(v);
    case "delta": return signedPct(v);
    case "num": return num(v, col.d ?? 2);
    case "shares": return shares(v);
    default: return String(v);
  }
}

/* ---------- server ---------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method, cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = msg.map((m) => String(m.msg || "").replace(/^Value error, /, "")).join(". ");
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data;
}

/* ---------- derived data (also used by reports) ---------- */
function derive() {
  const a = state.analytics && state.analytics.market === state.market ? state.analytics : null;
  const byId = new Map((a ? a.rows : []).map((r) => [r.id, r]));
  const rows = state.positions.map((p) => {
    const m = byId.get(p.id);
    if (!m || m.ticker !== p.ticker) return { ...p, pending: true };
    return { ...m, ticker: p.ticker, shares: p.shares, price_bought: p.price_bought, date_bought: p.date_bought || m.date_bought };
  });
  const seen = {};
  rows.forEach((r) => { seen[r.ticker] = (seen[r.ticker] || 0) + 1; r.label = seen[r.ticker] > 1 ? `${r.ticker} (${seen[r.ticker]})` : r.ticker; });

  const priced = rows.filter((r) => isNum(r.position_value));
  const invested = priced.reduce((s, r) => s + r.position_value, 0);
  const t = a ? a.totals : {};
  const totals = {
    cash: state.cash, invested: a ? invested : null, total: a ? invested + state.cash : null,
    cost: t.cost ?? null, pnl: t.pnl ?? null, pnl_pct: t.pnl_pct ?? null,
    beta: t.beta ?? null, expected_return: t.expected_return ?? null, var: t.var ?? null,
    positions: rows.length,
  };

  const map = {};
  priced.forEach((r) => {
    const s = (r.sector || "").trim();
    if (!s || r.error) return;
    map[s] = map[s] || { tickers: new Set(), value: 0 };
    map[s].tickers.add(r.ticker);
    map[s].value += r.position_value;
  });
  const market = (a && a.market_sector_weights) || {};
  const known = (state.config && state.config.sectors) || [];
  const names = [...new Set([...known, ...Object.keys(map)])].sort();
  const sectors = names.map((s) => {
    const info = map[s] || { tickers: new Set(), value: 0 };
    const target = state.allocations[s] || 0;
    return {
      sector: s, count: info.tickers.size, total_value: info.value,
      weight: invested ? info.value / invested : 0,
      set_allocation: target, allocation_goal: invested * target, market_weight: market[s] || 0,
    };
  });

  const caps = CAP_TIERS.map((c) => {
    const inTier = priced.filter((r) => r.cap_tier === c);
    return { category: c, count: inTier.length, pct: inTier.reduce((s, r) => s + (r.weight || 0), 0) };
  });
  caps.push({ category: "Total", count: caps.reduce((s, c) => s + c.count, 0), pct: caps.reduce((s, c) => s + c.pct, 0) });

  const benchmark = (a && a.benchmark) || (state.config && state.config.benchmark) || { name: "Market" };
  return {
    market: state.market, marketLabel: ui().label, rows, priced, totals, sectors, caps,
    hasCaps: state.market === "us" || priced.some((r) => r.cap_tier),
    hasMarketWeights: Object.keys(market).length > 0,
    performance: a ? a.performance : null, benchmark,
    history: (a && a.value_history) || [], asOf: a && a.as_of,
  };
}

/* ---------- charts ---------- */
function palette(mode) {
  return mode === "dark"
    ? { surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835",
        series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"], neg: "#e66767", other: "#6b6a64" }
    : { surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7",
        series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"], neg: "#e34948", other: "#b5b3aa" };
}
const currentMode = () => document.documentElement.dataset.theme || "light";
const legendLabels = (t) => ({ color: t.ink2, boxWidth: 12, boxHeight: 12, borderRadius: 3, useBorderRadius: true });

function barChart(t, labels, datasets, fmt, { horizontal = true, legend = false } = {}) {
  const valueAxis = { grid: { color: t.grid }, border: { color: t.axis }, ticks: { color: t.muted, callback: (v) => fmt(v) }, beginAtZero: true };
  const catAxis = { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.ink2, autoSkip: false } };
  return {
    type: "bar",
    data: { labels, datasets: datasets.map((d) => ({ borderRadius: 4, maxBarThickness: 22, borderWidth: 0, categoryPercentage: 0.78, barPercentage: 0.9, ...d })) },
    options: {
      indexAxis: horizontal ? "y" : "x",
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
      plugins: {
        legend: { display: legend, position: "top", align: "start", labels: legendLabels(t) },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` } },
      },
    },
  };
}
const rowsHeight = (n, per = 28) => Math.max(240, n * per + 70);
const pctTick = (v) => `${(+v).toFixed(Math.abs(v) < 10 && v % 1 ? 1 : 0)}%`;
const pctTip = (v) => `${(+v).toFixed(2)}%`;

function chartDefs(d, mode, opts = {}) {
  const t = palette(mode);
  const defs = [];
  const has = d.priced.length > 0;
  const none = "Add a position to see this chart.";

  /* 1. Performance against the market */
  const p = d.performance;
  const bName = d.benchmark.name;
  let perfNote = `Return on the money you invested, next to the same money put into the ${bName} on the same dates`;
  let perfEmpty = null;
  if (!p) perfEmpty = has ? "Performance appears once each position has its purchase date and price history." : none;
  else if (!p.benchmark) perfNote = d.market === "bh"
    ? "Return on the money you invested. Import Bahrain All Share Index data to add the market line"
    : `Return on the money you invested. Market data for ${bName} isn't available right now`;
  else if (p.compare_from && p.compare_from > p.starts) perfNote += `. Index data starts ${p.compare_from}, so the market line begins there`;
  const perfSets = p ? [{ label: "Your portfolio", data: p.portfolio.map((v) => (v == null ? null : v * 100)), borderColor: t.series[0], backgroundColor: t.series[0] }] : [];
  if (p && p.benchmark) perfSets.push({ label: bName, data: p.benchmark.map((v) => (v == null ? null : v * 100)), borderColor: t.series[1], backgroundColor: t.series[1] });
  defs.push({ id: "performance", title: "Your performance vs the market", note: perfNote, height: 340, wide: true, perf: true, empty: perfEmpty,
    config: { type: "line",
      data: { labels: p ? p.days : [], datasets: perfSets.map((s) => ({ borderWidth: 2, tension: 0.15, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderColor: t.surface, pointHoverBorderWidth: 2, spanGaps: false, ...s })) },
      options: { interaction: { mode: "index", intersect: false },
        scales: { x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted, maxTicksLimit: 8, maxRotation: 0 } },
                  y: { grid: { color: (c) => (c.tick.value === 0 ? t.axis : t.grid) }, border: { display: false }, ticks: { color: t.muted, callback: pctTick } } },
        plugins: { legend: { display: true, position: "top", align: "start", labels: legendLabels(t) },
                   tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw >= 0 ? "+" : ""}${pctTip(c.raw)}` } } } } } });

  /* 2. Sector allocation — bar / donut / radar */
  const held = d.sectors.filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
  const kind = opts.sectorChart || "bar";
  let sectorCfg, sectorH = 320;
  if (kind === "donut") {
    const top = held.slice(0, 7);
    const rest = held.slice(7).reduce((s, x) => s + x.weight, 0);
    const parts = rest > 0 ? [...top, { sector: "Other", weight: rest }] : top;
    sectorCfg = {
      type: "doughnut",
      data: { labels: parts.map((x) => `${x.sector}  ${pct(x.weight, 1)}`),
              datasets: [{ label: "Weight", data: parts.map((x) => x.weight * 100),
                           backgroundColor: parts.map((x, i) => (x.sector === "Other" ? t.other : t.series[i])),
                           borderColor: t.surface, borderWidth: 2 }] },
      options: { cutout: "58%", plugins: { legend: { position: "right", labels: legendLabels(t) }, tooltip: { callbacks: { label: (c) => pctTip(c.raw) } } } },
    };
  } else if (kind === "radar") {
    sectorCfg = {
      type: "radar",
      data: { labels: d.sectors.map((s) => s.sector),
              datasets: [{ label: "Weight", data: d.sectors.map((s) => s.weight * 100), borderColor: t.series[0], borderWidth: 2,
                           backgroundColor: t.series[0] + "33", pointBackgroundColor: t.series[0], pointRadius: 4 }] },
      options: { scales: { r: { beginAtZero: true, grid: { color: t.grid }, angleLines: { color: t.grid },
                                pointLabels: { color: t.ink2, font: { size: 11 } },
                                ticks: { color: t.muted, backdropColor: "transparent", callback: pctTick } } },
                 plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => pctTip(c.raw) } } } },
    };
    sectorH = 380;
  } else {
    sectorCfg = barChart(t, held.map((s) => s.sector), [{ label: "Weight", data: held.map((s) => s.weight * 100), backgroundColor: t.series[0] }], pctTick);
    sectorCfg.options.plugins.tooltip.callbacks.label = (c) => `Weight: ${pctTip(c.raw)}`;
    sectorH = rowsHeight(held.length);
  }
  defs.push({ id: "sector", title: "Sector allocation", note: "Share of invested value by sector", height: sectorH, config: sectorCfg, empty: has ? null : none, switcher: true });

  /* 3. Holdings vs target (and the S&P 500 sector mix on the US page) */
  const cmp = d.sectors.filter((s) => s.weight > 0 || s.set_allocation > 0 || s.market_weight > 0);
  const cmpSets = [
    { label: "Your portfolio", data: cmp.map((s) => s.weight * 100), backgroundColor: t.series[0] },
    { label: "Your target", data: cmp.map((s) => s.set_allocation * 100), backgroundColor: t.series[1] },
  ];
  if (d.hasMarketWeights) cmpSets.push({ label: "S&P 500", data: cmp.map((s) => s.market_weight * 100), backgroundColor: t.series[2] });
  const cmpCfg = barChart(t, cmp.map((s) => s.sector), cmpSets, pctTick, { legend: true });
  cmpCfg.options.plugins.tooltip.callbacks.label = (c) => `${c.dataset.label}: ${pctTip(c.raw)}`;
  defs.push({ id: "compare", title: d.hasMarketWeights ? "Portfolio vs target vs market" : "Portfolio vs target", note: "Sector weight, percent",
    height: rowsHeight(cmp.length, d.hasMarketWeights ? 46 : 36), config: cmpCfg, empty: cmp.length ? null : none });

  /* 4. Profit / loss by position */
  const pl = d.priced.filter((r) => isNum(r.pct_change)).sort((a, b) => b.pct_change - a.pct_change);
  const plCfg = barChart(t, pl.map((r) => r.label), [{ label: "Profit / loss", data: pl.map((r) => r.pct_change * 100), backgroundColor: pl.map((r) => (r.pct_change >= 0 ? t.series[0] : t.neg)) }], pctTick);
  plCfg.options.plugins.tooltip.callbacks.label = (c) => `${c.raw >= 0 ? "Gain" : "Loss"}: ${pctTip(c.raw)}`;
  defs.push({ id: "pnl", title: "Profit / loss by position", note: "Change since purchase. Blue is a gain, red is a loss", height: rowsHeight(pl.length), config: plCfg, empty: pl.length ? null : none });

  /* 5. Position weights */
  const w = d.priced.filter((r) => isNum(r.weight)).sort((a, b) => b.weight - a.weight);
  const wCfg = barChart(t, w.map((r) => r.label), [{ label: "Weight", data: w.map((r) => r.weight * 100), backgroundColor: t.series[0] }], pctTick);
  wCfg.options.plugins.tooltip.callbacks.label = (c) => `Weight: ${pctTip(c.raw)}`;
  defs.push({ id: "weights", title: "Position weights", note: "Share of invested value", height: rowsHeight(w.length), config: wCfg, empty: w.length ? null : none });

  /* 6. Value at risk */
  const vr = d.priced.filter((r) => isNum(r.var)).sort((a, b) => b.var - a.var);
  defs.push({ id: "var", title: "Value at risk by position", note: "One-day loss not expected to be exceeded 95% of the time", height: rowsHeight(vr.length),
    config: barChart(t, vr.map((r) => r.label), [{ label: "VaR", data: vr.map((r) => r.var), backgroundColor: t.series[0] }], moneyShort), empty: vr.length ? null : none });

  /* 7. Market cap mix (only where market-cap data exists) */
  if (d.hasCaps) {
    const caps = d.caps.filter((c) => c.category !== "Total");
    const capCfg = barChart(t, caps.map((c) => c.category), [{ label: "Weight", data: caps.map((c) => c.pct * 100), backgroundColor: t.series[0] }], pctTick, { horizontal: false });
    capCfg.options.plugins.tooltip.callbacks.label = (c) => `Weight: ${pctTip(c.raw)} · ${caps[c.dataIndex].count} position${caps[c.dataIndex].count === 1 ? "" : "s"}`;
    capCfg.data.datasets[0].maxBarThickness = 44;
    defs.push({ id: "caps", title: "Market cap mix", note: "Share of invested value by company size", height: 280, config: capCfg, empty: has ? null : none });
  }

  /* 8. Portfolio value over time */
  const h = d.history;
  defs.push({ id: "history", title: "Portfolio value over time", note: "Total value including cash, recorded once a day", height: 280, wide: true,
    empty: h.length >= 2 ? null : "One point is saved each day the app is opened. The trend line appears once there are two days of data.",
    config: { type: "line",
      data: { labels: h.map((x) => x.day), datasets: [{ label: "Total value", data: h.map((x) => x.total), borderColor: t.series[0], backgroundColor: t.series[0], borderWidth: 2, tension: 0.25, pointRadius: h.length > 40 ? 0 : 4, pointHoverRadius: 6, pointBorderColor: t.surface, pointBorderWidth: 2 }] },
      options: { interaction: { mode: "index", intersect: false },
        scales: { x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted, maxTicksLimit: 8 } },
                  y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, callback: moneyShort } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Total value: ${money(c.raw)}` } } } } } });

  return defs;
}

/* Controls and headline numbers shown on the performance card. */
function perfTools() {
  const cfg = state.config;
  if (!cfg) return "";
  if (state.market === "bh") {
    const range = cfg.index_points ? `Index data: ${cfg.index_from} to ${cfg.index_to}` : "No index data yet";
    return `<div class="chart-tools"><span class="muted">${esc(range)}</span><button class="btn small" type="button" data-action="index">${cfg.index_points ? "Update index data" : "Import index data"}</button></div>`;
  }
  const options = cfg.benchmark_options || [];
  const current = cfg.benchmark.symbol;
  const isCustom = state.customBenchmark || !options.some((o) => o.symbol === current);
  return `<div class="chart-tools">
    <label class="muted" for="benchSelect">Compare with</label>
    <select class="input" id="benchSelect" aria-label="Market index to compare with">
      ${options.map((o) => `<option value="${esc(o.symbol)}" ${!isCustom && o.symbol === current ? "selected" : ""}>${esc(o.name)}</option>`).join("")}
      <option value="__custom" ${isCustom ? "selected" : ""}>Other symbol…</option>
    </select>
    ${isCustom ? `<input class="input custom" id="benchCustom" value="${esc(options.some((o) => o.symbol === current) ? "" : current)}" placeholder="e.g. QQQ" maxlength="12" aria-label="Index or fund symbol" /><button class="btn small" type="button" data-action="bench-apply">Apply</button>` : ""}
  </div>`;
}
function perfStats(d, t) {
  const p = d.performance;
  if (!p) return "";
  const diff = isNum(p.portfolio_return) && isNum(p.benchmark_return) ? p.portfolio_return - p.benchmark_return : null;
  const pts = (v) => (isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(2)} pts` : "—");
  return `<div class="perf-stats">
    <div><strong class="${signClass(p.portfolio_return)}">${signedPct(p.portfolio_return)}</strong><span class="key" style="background:${t.series[0]}"></span>Your portfolio</div>
    ${p.benchmark ? `<div><strong class="${signClass(p.benchmark_return)}">${signedPct(p.benchmark_return)}</strong><span class="key" style="background:${t.series[1]}"></span>${esc(d.benchmark.name)}</div>
    <div><strong class="${signClass(diff)}">${pts(diff)}</strong>${diff == null ? "Difference" : diff >= 0 ? "Ahead of the market" : "Behind the market"}</div>` : ""}
  </div>`;
}

function renderCharts(d) {
  charts.splice(0).forEach((c) => c.destroy());
  const host = $("#charts");
  if (!state.positions.length) { host.innerHTML = ""; return; }
  if (state.view !== "overview") return; // a hidden canvas has no size; drawn when the tab is opened
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  const mode = currentMode();
  const defs = chartDefs(d, mode, { sectorChart: state.sectorChart });
  const waiting = state.loading && !d.asOf;
  host.innerHTML = defs.map((def) => `
    <div class="card chart-card${def.wide ? " wide" : ""}">
      <div class="card-head">
        <div><h2>${esc(def.title)}</h2><p class="muted">${esc(def.note)}</p></div>
        ${def.switcher ? `<div class="seg" role="group" aria-label="Chart type">${["bar", "donut", "radar"].map((k) => `<button type="button" data-sector-chart="${k}" class="${state.sectorChart === k ? "active" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>` : ""}
        ${def.perf ? perfTools() : ""}
      </div>
      ${def.perf && !waiting ? perfStats(d, palette(mode)) : ""}
      ${waiting ? `<div class="chart-empty"><span class="skeleton" style="width:70%;height:120px"></span></div>`
        : def.empty ? `<div class="chart-empty">${esc(def.empty)}</div>`
        : `<div class="chart-box" style="height:${def.height}px"><canvas id="chart-${def.id}" role="img" aria-label="${esc(def.title)}"></canvas></div>`}
    </div>`).join("");
  defs.forEach((def) => {
    const el = $(`#chart-${def.id}`);
    if (!el) return;
    def.config.options = { responsive: true, maintainAspectRatio: false, animation: false, ...def.config.options };
    charts.push(new Chart(el, def.config));
  });
}

/* ---------- overview ---------- */
function renderKpis(d) {
  const t = d.totals, p = d.performance;
  const wait = state.loading && !d.asOf;
  const v = (text) => (wait ? '<span class="skeleton"></span>' : text);
  const diff = p && isNum(p.portfolio_return) && isNum(p.benchmark_return) ? p.portfolio_return - p.benchmark_return : null;
  const diffText = isNum(diff) ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff * 100).toFixed(2)} pts` : "—";
  const tiles = [
    ["Total portfolio value", v(money(t.total)), "Invested plus cash"],
    ["Invested", v(money(t.invested)), `${t.positions} position${t.positions === 1 ? "" : "s"}`],
    ['Cash <button class="link" type="button" data-action="cash">Edit</button>', money(t.cash), "Uninvested balance"],
    ["Unrealised profit / loss", v(`<span class="${signClass(t.pnl)}">${isNum(t.pnl) ? (t.pnl > 0 ? "+" : "") + money(t.pnl) : "—"}</span>`), isNum(t.pnl_pct) ? `${signedPct(t.pnl_pct)} on ${money(t.cost)} paid` : "Against purchase cost"],
    ["Versus the market", v(`<span class="${signClass(diff)}">${diffText}</span>`), isNum(diff) ? `${d.benchmark.name}: ${signedPct(p.benchmark_return)}` : d.market === "bh" && !(state.config && state.config.index_points) ? "Import index data to compare" : `Compared with ${d.benchmark.name}`],
    ["Portfolio beta", v(num(t.beta, 2)), `Weighted, against ${d.benchmark.name}`],
    ["Expected return", v(pct(t.expected_return)), "CAPM, yearly"],
    ["Value at risk", v(money(t.var)), "One day, 95%, sum of positions"],
  ];
  $("#kpis").innerHTML = tiles.map(([label, value, note]) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-note">${esc(note)}</div></div>`).join("");
}

/* ---------- positions ---------- */
function renderPositions(d) {
  const table = $("#posTable");
  const cols = activeCols(d);
  const q = state.filter.trim().toLowerCase();
  let rows = d.rows.filter((r) => !q || r.ticker.toLowerCase().includes(q) || (r.sector || "").toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q));
  const { key, dir } = state.sort;
  if (key) {
    rows = [...rows].sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  const head = `<thead><tr>${cols.map((c, i) => {
    const sk = c.sortKey || c.k;
    const arrow = state.sort.key === sk ? (dir > 0 ? " ↑" : " ↓") : "";
    return `<th class="sortable ${i === 0 ? "pin" : ""} ${c.type === "text" ? "l" : ""}" data-sort="${sk}" aria-sort="${state.sort.key === sk ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(c.h)}${arrow}</th>`;
  }).join("")}<th></th></tr></thead>`;

  let body;
  if (!d.rows.length) {
    body = `<tr><td class="none" colspan="${cols.length + 1}">No ${esc(ui().label)} positions yet. Use “Add position” to enter your first holding.</td></tr>`;
  } else if (!rows.length) {
    body = `<tr><td class="none" colspan="${cols.length + 1}">Nothing matches “${esc(state.filter)}”.</td></tr>`;
  } else {
    body = rows.map((r) => `<tr>${cols.map((c, i) => {
      if (i === 0) {
        const tag = r.error ? '<span class="tag">No market data</span>' : r.stale ? '<span class="tag">Last saved prices</span>' : "";
        return `<td class="pin">${esc(r.ticker)}${tag}${r.name ? `<span class="sub">${esc(r.name)}</span>` : ""}</td>`;
      }
      if (r.pending && !["shares", "price_bought", "date_bought"].includes(c.k)) return `<td>${state.loading ? '<span class="skeleton" style="width:40px"></span>' : "—"}</td>`;
      let text = esc(fmtCell(c, r));
      if (c.k === "date_bought" && !r.date_bought) text = '<span class="tag">Date needed</span>';
      else if (c.k === "date_bought" && r.date_inferred && !state.positions.find((x) => x.id === r.id)?.date_bought) text += ' <span class="tag">Estimated, please edit</span>';
      return `<td class="${c.type === "text" ? "l" : ""} ${c.type === "delta" ? signClass(r[c.k]) : ""}">${text}</td>`;
    }).join("")}<td><span class="actions"><button class="link" type="button" data-edit="${r.id}">Edit</button><button class="link danger" type="button" data-remove="${r.id}">Remove</button></span></td></tr>`).join("");
  }
  const t = d.totals;
  const foot = d.rows.length && d.asOf ? `<tfoot><tr>${cols.map((c, i) => {
    const map = { ticker: "Total", value_paid: money(t.cost), position_value: money(t.invested), pct_change: signedPct(t.pnl_pct), weight: pct(d.priced.reduce((s, r) => s + (r.weight || 0), 0)), beta_weighted: num(t.beta, 4), weighted_expected_return: pct(t.expected_return), var: money(t.var) };
    return `<td class="${i === 0 ? "pin" : ""}">${map[c.k] ?? ""}</td>`;
  }).join("")}<td></td></tr></tfoot>` : "";
  table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
}

/* ---------- sectors ---------- */
function renderSectors(d) {
  const sum = d.sectors.reduce((s, x) => s + x.set_allocation, 0);
  const mw = d.hasMarketWeights;
  $("#targetSum").textContent = `Targets add up to ${pct(sum, 1)}`;
  $("#sectorNote").textContent = mw
    ? "Set a target for each sector. Targets are saved as you type and compared with your holdings and the S&P 500."
    : "Set a target for each sector. Targets are saved as you type and compared with your holdings.";
  $("#sectorTable").innerHTML = `<thead><tr><th class="pin">Sector</th><th>Stocks</th><th>Total value</th><th>Weight</th><th>Target</th><th>Target value</th>${mw ? "<th>S&amp;P 500 weight</th>" : ""}</tr></thead><tbody>${
    d.sectors.map((s) => `<tr><td class="pin">${esc(s.sector)}</td><td>${s.count}</td><td>${money(s.total_value)}</td><td>${pct(s.weight)}</td>
      <td><input class="input pct-input" type="number" min="0" max="100" step="0.5" value="${+(s.set_allocation * 100).toFixed(2)}" data-sector="${esc(s.sector)}" aria-label="Target percent for ${esc(s.sector)}" /> %</td>
      <td>${money(s.allocation_goal)}</td>${mw ? `<td>${s.market_weight ? pct(s.market_weight) : "—"}</td>` : ""}</tr>`).join("")
  }</tbody><tfoot><tr><td class="pin">Total</td><td>${d.priced.length}</td><td>${money(d.totals.invested)}</td><td>${pct(d.sectors.reduce((s, x) => s + x.weight, 0))}</td><td>${pct(sum)}</td><td>${money(d.sectors.reduce((s, x) => s + x.allocation_goal, 0))}</td>${mw ? "<td></td>" : ""}</tr></tfoot>`;

  $("#capCard").hidden = !d.hasCaps;
  $("#capTable").innerHTML = `<thead><tr><th class="pin">Category</th><th>Count</th><th>Share of value</th></tr></thead><tbody>${
    d.caps.slice(0, -1).map((c) => `<tr><td class="pin">${c.category}</td><td>${c.count}</td><td>${pct(c.pct)}</td></tr>`).join("")
  }</tbody><tfoot><tr><td class="pin">Total</td><td>${d.caps.at(-1).count}</td><td>${pct(d.caps.at(-1).pct)}</td></tr></tfoot>`;

  $("#summaryTable").innerHTML = `<thead><tr><th class="pin">Metric</th><th>Value</th></tr></thead><tbody>
    <tr><td class="pin">Cash <button class="link" type="button" data-action="cash">Edit</button></td><td>${money(d.totals.cash)}</td></tr>
    <tr><td class="pin">Total invested</td><td>${money(d.totals.invested)}</td></tr>
    <tr><td class="pin">Total portfolio value</td><td>${money(d.totals.total)}</td></tr></tbody>`;
}

/* ---------- history ---------- */
const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function describe(a) {
  const x = a.detail || {};
  const m = x.market || (x.after && x.after.market) || "us";
  const where = `${ui(m).label}: `;
  switch (a.action) {
    case "position_added": return `${where}added ${x.ticker}, ${shares(x.shares)} shares at ${money(x.price_bought, null, m)}`;
    case "position_edited": {
      const b = x.before || {}, f = x.after || {};
      const ch = ["ticker", "shares", "price_bought", "date_bought"].filter((k) => b[k] !== f[k]).map((k) => `${k.replace("_", " ")} ${b[k] ?? "empty"} → ${f[k] ?? "empty"}`);
      return `${where}edited ${f.ticker}${ch.length ? " (" + ch.join(", ") + ")" : ""}`;
    }
    case "position_removed": return `${where}removed ${x.ticker} (${shares(x.shares)} shares)`;
    case "position_restored": return `${where}restored ${x.ticker}`;
    case "cash_changed": return `${where}cash changed from ${money(x.before, null, m)} to ${money(x.after, null, m)}`;
    case "target_changed": return `${where}${x.sector} target set to ${pct(x.after, 1)} (was ${pct(x.before, 1)})`;
    case "benchmark_changed": return `${where}comparison index changed from ${x.before} to ${x.after}`;
    case "index_imported": return `${where}saved ${x.count} day${x.count === 1 ? "" : "s"} of index data (${x.from} to ${x.to})`;
    default: return a.action;
  }
}
async function loadHistory() {
  try {
    const [bin, log] = await Promise.all([api("GET", `/api/bin?market=${state.market}`), api("GET", "/api/activity")]);
    $("#binTable").innerHTML = `<thead><tr><th class="pin">Ticker</th><th>Shares</th><th>Price bought</th><th class="l">Date bought</th><th class="l">Removed</th><th></th></tr></thead><tbody>${
      bin.length ? bin.map((p) => `<tr><td class="pin">${esc(p.ticker)}</td><td>${shares(p.shares)}</td><td>${money(p.price_bought)}</td><td class="l">${esc(p.date_bought || "—")}</td><td class="l">${esc(when(p.deleted_at))}</td><td><button class="link" type="button" data-restore="${p.id}">Restore</button></td></tr>`).join("")
        : `<tr><td class="none" colspan="6">No ${esc(ui().label)} positions have been removed.</td></tr>`}</tbody>`;
    $("#activityLog").innerHTML = log.length ? log.map((a) => `<li><span>${esc(describe(a))}</span><time datetime="${esc(a.at)}">${esc(when(a.at))}</time></li>`).join("") : '<li class="muted">No changes yet.</li>';
  } catch (e) { toast(`Couldn't load history: ${e.message}`); }
}

/* ---------- render all ---------- */
function render() {
  const d = derive();
  $("#emptyOverview").hidden = state.positions.length > 0 || state.loading;
  renderKpis(d);
  renderCharts(d);
  renderPositions(d);
  renderSectors(d);

  const a = d.asOf ? state.analytics : null;
  const banner = $("#banner");
  const bad = d.rows.filter((r) => r.error).map((r) => r.ticker);
  const stale = d.rows.some((r) => r.stale);
  const undated = d.rows.filter((r) => !state.positions.find((x) => x.id === r.id)?.date_bought).map((r) => r.ticker);
  const msgs = [];
  if (state.dbError) msgs.push(state.dbError);
  if (state.analyticsError) msgs.push(`Market data couldn't be loaded (${state.analyticsError}). Your saved positions are safe; use Refresh prices to try again.`);
  if (a && (!a.feed_ok || stale)) msgs.push("The market data feed isn't responding for some tickers, so the last saved figures are shown for them.");
  if (bad.length) msgs.push(`No market data found for ${bad.join(", ")}. Check the ticker symbol.`);
  if (undated.length) msgs.push(`${undated.join(", ")} ${undated.length === 1 ? "has" : "have"} no purchase date. Edit ${undated.length === 1 ? "it" : "them"} to add one so the performance comparison is accurate.`);
  banner.hidden = !msgs.length;
  banner.textContent = msgs.join(" ");

  const priceDay = d.priced.map((r) => r.price_date).filter(Boolean).sort().at(-1);
  $("#asOf").textContent = state.loading ? "Loading market data…" : a && state.positions.length
    ? `${priceDay ? `Closing prices to ${priceDay} · ` : ""}updated ${new Date(a.as_of).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : state.dbError ? "Database unavailable" : "Add a position to get started";
}

/* ---------- loading ---------- */
let analyticsRun = 0;
async function loadAnalytics() {
  const run = ++analyticsRun, market = state.market;
  state.loading = true;
  $("#refreshBtn").disabled = true;
  render();
  try {
    const a = await api("GET", `/api/analytics?market=${market}`);
    if (run !== analyticsRun) return;
    state.analytics = a;
    state.analyticsError = null;
  } catch (e) {
    if (run !== analyticsRun) return;
    state.analyticsError = e.message;
  }
  state.loading = false;
  $("#refreshBtn").disabled = false;
  render();
}

function applyPortfolio(p) {
  state.positions = p.positions;
  state.cash = p.cash;
  state.allocations = p.allocations;
  state.config = p.config;
  state.signature = JSON.stringify(p);
}

async function loadAll() {
  const market = state.market;
  try {
    const p = await api("GET", `/api/portfolio?market=${market}`);
    if (market !== state.market) return;
    applyPortfolio(p);
    setSaveState(true);
  } catch (e) {
    if (market !== state.market) return;
    setSaveState(false, e.message);
    state.loading = false;
    render();
    return;
  }
  await loadAnalytics();
}

function setSaveState(ok, message) {
  $("#saveState").className = "save-state " + (ok ? "ok" : "bad");
  $("#saveText").textContent = ok ? "All changes saved" : "Database unavailable";
  state.dbError = ok ? null : (message || "The database can't be reached.");
}

/* Pick up changes made by other people (or other tabs) without disturbing someone mid-edit. */
const busy = () => document.hidden || $("dialog[open]") || document.activeElement?.matches?.(".pct-input, #benchCustom, #benchSelect");
async function poll() {
  if (busy()) return;
  const market = state.market;
  try {
    const p = await api("GET", `/api/portfolio?market=${market}`);
    if (market !== state.market) return;
    const wasDown = !!state.dbError;
    setSaveState(true);
    if (JSON.stringify(p) !== state.signature || wasDown) { applyPortfolio(p); await loadAnalytics(); if (state.view === "history") loadHistory(); }
  } catch (e) { setSaveState(false, e.message); render(); }
}

/* ---------- actions ---------- */
function toast(text, actionLabel, action) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (actionLabel) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = actionLabel;
    b.onclick = () => { el.remove(); action(); };
    el.append(b);
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), actionLabel ? 9000 : 5000);
}

async function afterChange() {
  applyPortfolio(await api("GET", `/api/portfolio?market=${state.market}`));
  if (state.view === "history") loadHistory();
  await loadAnalytics();
}

function openPosition(id) {
  const form = $("#posForm");
  form.reset();
  $("#posError").textContent = "";
  state.editingId = id || null;
  const p = id && state.positions.find((x) => x.id === id);
  $("#posDialogTitle").textContent = p ? `Edit ${p.ticker}` : `Add ${ui().label} position`;
  $("#priceLabel").textContent = `Price bought (${ui().prefix.trim()})`;
  $("#tickerHint").textContent = ui().hint;
  $("#tickerHint").hidden = !ui().hint;
  form.ticker.placeholder = ui().placeholder;
  form.date_bought.max = new Date().toISOString().slice(0, 10);
  if (p) { form.ticker.value = p.ticker; form.shares.value = p.shares; form.price_bought.value = p.price_bought; form.date_bought.value = p.date_bought || ""; }
  $("#posDialog").showModal();
  form.ticker.focus();
}

$("#posForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, err = $("#posError");
  const body = { ticker: f.ticker.value.trim().toUpperCase(), shares: parseFloat(f.shares.value), price_bought: parseFloat(f.price_bought.value), date_bought: f.date_bought.value };
  if (!body.ticker) { err.textContent = "Enter a ticker symbol."; f.ticker.focus(); return; }
  if (!(body.shares > 0)) { err.textContent = "Enter how many shares you hold."; f.shares.focus(); return; }
  if (!(body.price_bought > 0)) { err.textContent = "Enter the price you paid per share."; f.price_bought.focus(); return; }
  if (!body.date_bought) { err.textContent = "Enter the date you bought the shares."; f.date_bought.focus(); return; }
  $("#posSave").disabled = true;
  try {
    if (state.editingId) await api("PUT", `/api/positions/${state.editingId}`, body);
    else await api("POST", "/api/positions", { ...body, market: state.market });
    $("#posDialog").close();
    toast(`${body.ticker} saved`);
    await afterChange();
  } catch (ex) { err.textContent = ex.message; }
  $("#posSave").disabled = false;
});

async function removePosition(id) {
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  try {
    await api("DELETE", `/api/positions/${id}`);
    toast(`${p.ticker} removed`, "Undo", () => restorePosition(id));
    await afterChange();
  } catch (e) { toast(`Couldn't remove ${p.ticker}: ${e.message}`); }
}
async function restorePosition(id) {
  try { const p = await api("POST", `/api/positions/${id}/restore`); toast(`${p.ticker} restored`); await afterChange(); }
  catch (e) { toast(`Couldn't restore: ${e.message}`); }
}

function openCash() {
  $("#cashError").textContent = "";
  $("#cashLabel").textContent = `Cash (${ui().prefix.trim()})`;
  $("#cashForm").amount.value = state.cash;
  $("#cashDialog").showModal();
  $("#cashForm").amount.select();
}
$("#cashForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = parseFloat(e.target.amount.value);
  if (!(amount >= 0)) { $("#cashError").textContent = "Enter an amount of zero or more."; return; }
  try { await api("PUT", "/api/cash", { market: state.market, amount }); $("#cashDialog").close(); toast("Cash saved"); await afterChange(); }
  catch (ex) { $("#cashError").textContent = ex.message; }
});

async function setBenchmark(symbol) {
  try {
    const b = await api("PUT", "/api/benchmark", { symbol });
    state.customBenchmark = false;
    toast(`Now comparing with ${b.name}`);
    await afterChange();
  } catch (e) { toast(`Couldn't change the index: ${e.message}`); renderCharts(derive()); }
}

/* ---------- Bahrain index import ---------- */
function splitCsvLine(line, sep) {
  const out = []; let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
    else if (ch === sep && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function parseIndexCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("The file has no data rows.");
  const sep = [",", ";", "\t"].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const table = lines.map((l) => splitCsvLine(l, sep));
  const header = table[0].map((h) => h.toLowerCase());
  const hasHeader = header.some((h) => /[a-z]/.test(h) && !/^\d/.test(h));
  let dateCol = header.findIndex((h) => /date|day/.test(h));
  let closeCol = header.findIndex((h) => /^(price|close|closing|value|last|index)/.test(h));
  if (dateCol < 0) dateCol = 0;
  if (closeCol < 0) closeCol = dateCol === 0 ? 1 : 0;
  const body = hasHeader ? table.slice(1) : table;

  const parts = body.map((r) => (r[dateCol] || "").match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/));
  const dayFirst = parts.some((m) => m && +m[1] > 12) && !parts.some((m) => m && +m[2] > 12);
  const pad = (n) => String(n).padStart(2, "0");
  const toDay = (raw, m) => {
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    if (m) return `${m[3]}-${pad(dayFirst ? m[2] : m[1])}-${pad(dayFirst ? m[1] : m[2])}`;
    const t = Date.parse(raw);
    if (isNaN(t)) return null;
    const dt = new Date(t);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  const points = new Map();
  body.forEach((r, i) => {
    const day = toDay(r[dateCol] || "", parts[i]);
    const close = parseFloat(String(r[closeCol] || "").replace(/[, ]/g, ""));
    if (day && close > 0) points.set(day, close);
  });
  if (!points.size) throw new Error("No rows with a date and an index value were found in the file.");
  return [...points].map(([day, close]) => ({ day, close })).sort((a, b) => a.day.localeCompare(b.day));
}
function openIndex() {
  const cfg = state.config || {};
  $("#indexForm").reset();
  $("#indexError").textContent = "";
  $("#indexForm").day.max = new Date().toISOString().slice(0, 10);
  $("#indexStatus").textContent = cfg.index_points
    ? `${cfg.index_points} days saved, from ${cfg.index_from} to ${cfg.index_to}. Importing again adds new days and updates existing ones; nothing is removed.`
    : "There is no automatic feed for this index, so its daily closing values are kept in your database. Import them once, then add new days whenever you like.";
  $("#indexDialog").showModal();
}
$("#indexForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, err = $("#indexError");
  err.textContent = "";
  try {
    let points = [];
    if (f.file.files[0]) points = parseIndexCsv(await f.file.files[0].text());
    const close = parseFloat(f.close.value);
    if (f.day.value || f.close.value) {
      if (!f.day.value || !(close > 0)) throw new Error("To add one day, fill in both the date and the index close.");
      points = points.filter((p) => p.day !== f.day.value).concat({ day: f.day.value, close });
    }
    const today = new Date().toISOString().slice(0, 10);
    points = points.filter((p) => p.day <= today);
    if (!points.length) throw new Error("Choose a CSV file or enter a date and index close.");
    $("#indexSave").disabled = true;
    const res = await api("POST", "/api/index-history", { market: "bh", points });
    $("#indexDialog").close();
    const days = points.map((p) => p.day).sort();
    toast(`Saved ${res.saved} day${res.saved === 1 ? "" : "s"} of index data (${days[0]} to ${days.at(-1)})`);
    await afterChange();
  } catch (ex) { err.textContent = ex.message; }
  $("#indexSave").disabled = false;
});

/* ---------- navigation ---------- */
function showView(name) {
  state.view = name;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  $("#viewTitle").textContent = { overview: "Overview", positions: "Positions", sectors: "Sectors", reports: "Reports", history: "History" }[name];
  if (name === "history") loadHistory();
  if (name === "overview") renderCharts(derive()); // charts can't draw while their tab is hidden
}

function setMarket(market) {
  if (!MARKET_UI[market]) market = "us";
  state.market = market;
  Object.assign(state, { positions: [], cash: 0, allocations: {}, analytics: null, config: null, loading: true, signature: "", filter: "", sort: { key: null, dir: 1 }, analyticsError: null, customBenchmark: false });
  analyticsRun++;
  try { localStorage.setItem("risk-sheet-market", market); } catch { /* private window */ }
  if (location.hash !== `#/${market}`) history.replaceState(null, "", `#/${market}`);
  $$(".market-link").forEach((a) => { const on = a.dataset.market === market; a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("#marketName").textContent = `${ui().label} market`;
  $("#posSearch").value = "";
  document.title = `Risk Sheet · ${ui().label}`;
  render();
  if (state.view === "history") loadHistory();
  loadAll();
}
const marketFromHash = () => (location.hash.match(/^#\/(us|bh)/) || [])[1];
window.addEventListener("hashchange", () => { const m = marketFromHash(); if (m && m !== state.market) setMarket(m); });

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, a");
  if (!el) return;
  if (el.dataset.view) showView(el.dataset.view);
  else if (el.dataset.action === "add" || el.id === "addBtn") openPosition();
  else if (el.dataset.action === "cash") openCash();
  else if (el.dataset.action === "index") openIndex();
  else if (el.dataset.action === "bench-apply") { const v = ($("#benchCustom").value || "").trim().toUpperCase(); if (v) setBenchmark(v); else $("#benchCustom").focus(); }
  else if (el.dataset.edit) openPosition(el.dataset.edit);
  else if (el.dataset.remove) removePosition(el.dataset.remove);
  else if (el.dataset.restore) restorePosition(el.dataset.restore);
  else if (el.dataset.sectorChart) { state.sectorChart = el.dataset.sectorChart; renderCharts(derive()); }
  else if (el.hasAttribute("data-close")) el.closest("dialog").close();
  else if (el.id === "refreshBtn") loadAnalytics();
  else if (el.id === "reportBtn") showView("reports");
  else if (el.id === "themeBtn") setTheme(currentMode() === "dark" ? "light" : "dark");
});
document.addEventListener("change", (e) => {
  if (e.target.id !== "benchSelect") return;
  if (e.target.value === "__custom") { state.customBenchmark = true; renderCharts(derive()); $("#benchCustom")?.focus(); }
  else setBenchmark(e.target.value);
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "benchCustom") { e.preventDefault(); $('[data-action="bench-apply"]').click(); } });
$("#posTable").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = state.sort.key === key ? (state.sort.dir === 1 ? { key, dir: -1 } : { key: null, dir: 1 }) : { key, dir: 1 };
  renderPositions(derive());
});
$("#posSearch").addEventListener("input", (e) => { state.filter = e.target.value; renderPositions(derive()); });
$("#sectorTable").addEventListener("change", async (e) => {
  const input = e.target.closest(".pct-input");
  if (!input) return;
  const value = Math.min(100, Math.max(0, parseFloat(input.value) || 0));
  try {
    state.allocations = await api("PUT", "/api/allocations", { market: state.market, sector: input.dataset.sector, allocation: value / 100 });
    state.signature = "";
    const d = derive();
    renderSectors(d);
    renderCharts(d);
  } catch (ex) { toast(`Couldn't save target: ${ex.message}`); }
});

function setTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $("#themeBtn").textContent = mode === "dark" ? "Light mode" : "Dark mode";
  try { localStorage.setItem("risk-sheet-theme", mode); } catch { /* private window */ }
  if (state.positions.length) renderCharts(derive());
}

(function start() {
  let mode = null, market = marketFromHash();
  try { mode = localStorage.getItem("risk-sheet-theme"); market = market || localStorage.getItem("risk-sheet-market"); } catch { /* private window */ }
  if (!mode) mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(mode);
  setMarket(market || "us");
  setInterval(poll, 20000);
  setInterval(() => { if (!busy() && state.positions.length) loadAnalytics(); }, 5 * 60 * 1000);
})();
