/* Risk Sheet — report builder. Produces a PDF, PowerPoint or Excel file in the browser
   from the same figures and chart definitions the screen uses. */

const LIBS = {
  pdf: ["https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js", "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"],
  pptx: ["https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js"],
  xlsx: ["https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"],
};
const loaded = {};
function loadScript(src) {
  loaded[src] = loaded[src] || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => { delete loaded[src]; reject(new Error("A report library couldn't be downloaded. Check your connection and try again.")); };
    document.head.append(s);
  });
  return loaded[src];
}

const BLUE = "2A78D6";
const POSITION_SETS = [
  { title: "Positions: holdings", keys: ["ticker", "sector", "date_bought", "shares", "price_bought", "value_paid", "current_price", "position_value", "pct_change"] },
  { title: "Positions: ATR levels", keys: ["ticker", "entry_atr", "no_atrs", "take_profit", "stop_loss", "current_tp", "current_sl"] },
  { title: "Positions: risk", keys: ["ticker", "beta", "weight", "beta_weighted", "expected_return", "weighted_expected_return", "var", "iv", "holding_period", "cap_formatted", "cap_tier"] },
];
const colsFor = (keys) => keys.map((k) => COLS.find((c) => c.k === k));

function summaryItems(d) {
  const t = d.totals;
  return [
    ["Total portfolio value", money(t.total)],
    ["Invested", money(t.invested)],
    ["Cash", money(t.cash)],
    ["Unrealised profit / loss", isNum(t.pnl) ? `${t.pnl < 0 ? "−" : "+"}${money(Math.abs(t.pnl))} (${signedPct(t.pnl_pct)})` : "—"],
    ["Portfolio beta", num(t.beta, 2)],
    ["Expected return (CAPM)", pct(t.expected_return)],
    ["Value at risk (1 day, 95%)", money(t.var)],
    ["Positions", String(t.positions)],
  ];
}
const sectorTable = (d) => ({
  head: ["Sector", "Stocks", "Total value", "Weight", "Target", "Target value", "S&P 500 weight"],
  body: d.sectors.map((s) => [s.sector, String(s.count), money(s.total_value), pct(s.weight), pct(s.set_allocation), money(s.allocation_goal), s.market_weight ? pct(s.market_weight) : "—"]),
});
const capTable = (d) => ({ head: ["Category", "Count", "Share of value"], body: d.caps.map((c) => [c.category, String(c.count), pct(c.pct)]) });

/* Render every chart off-screen at a fixed size on a white background. */
function chartImages(d) {
  const host = document.getElementById("offscreen");
  const prevSize = Chart.defaults.font.size;
  Chart.defaults.font.size = 17;
  const white = { id: "white", beforeDraw(c) { c.ctx.save(); c.ctx.fillStyle = "#ffffff"; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } };
  const out = [];
  try {
    for (const def of chartDefs(d, "light", { sectorChart: state.sectorChart })) {
      if (def.empty) continue;
      const w = 1100, h = Math.round(Math.min(900, Math.max(520, def.height * 1.7)));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      host.append(canvas);
      def.config.options = { ...def.config.options, responsive: false, animation: false, devicePixelRatio: 2, layout: { padding: 16 } };
      def.config.data.datasets.forEach((ds) => { if (ds.maxBarThickness) ds.maxBarThickness *= 1.6; });
      def.config.plugins = [white];
      const chart = new Chart(canvas, def.config);
      out.push({ id: def.id, title: def.title, note: def.note, w, h, data: chart.toBase64Image("image/png", 1) });
      chart.destroy();
      canvas.remove();
    }
  } finally { Chart.defaults.font.size = prevSize; }
  return out;
}

const stamp = () => new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
const fileName = (ext) => `risk-sheet-report-${new Date().toISOString().slice(0, 10)}.${ext}`;
function fit(w, h, maxW, maxH) { const k = Math.min(maxW / w, maxH / h); return { w: w * k, h: h * k }; }

/* ---------- PDF ---------- */
async function buildPdf(d, want, images) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = 297, M = 14;
  let first = true;
  const page = (title) => {
    if (!first) doc.addPage();
    first = false;
    doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(11, 11, 11);
    doc.text(title, M, 18);
    doc.setDrawColor(225, 224, 217); doc.line(M, 22, W - M, 22);
  };
  const table = (head, body, startY = 28, fontSize = 8) => doc.autoTable({
    head: [head], body, startY, margin: { left: M, right: M, top: 28 }, theme: "grid",
    styles: { font: "helvetica", fontSize, cellPadding: 1.6, halign: "right", lineColor: [225, 224, 217], textColor: [30, 30, 30] },
    headStyles: { fillColor: [42, 120, 214], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left", fontStyle: "bold" } }, alternateRowStyles: { fillColor: [249, 249, 247] },
  });

  page("Portfolio risk report");
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(118, 116, 110);
  doc.text(`Generated ${stamp()}`, M, 29);
  if (want.summary) {
    const items = summaryItems(d), bw = (W - 2 * M - 3 * 5) / 4, bh = 26;
    items.forEach(([label, value], i) => {
      const x = M + (i % 4) * (bw + 5), y = 36 + Math.floor(i / 4) * (bh + 5);
      doc.setDrawColor(225, 224, 217); doc.setFillColor(252, 252, 251); doc.roundedRect(x, y, bw, bh, 2.5, 2.5, "FD");
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(118, 116, 110); doc.text(label, x + 4, y + 8);
      doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(11, 11, 11); doc.text(value.replace("−", "-"), x + 4, y + 18);
    });
  }
  if (want.charts) {
    const boxW = (W - 2 * M - 8) / 2, boxH = 150;
    images.forEach((img, i) => {
      if (i % 2 === 0) page("Charts");
      const x = M + (i % 2) * (boxW + 8);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(11, 11, 11); doc.text(img.title, x, 31);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(118, 116, 110); doc.text(img.note, x, 36);
      const s = fit(img.w, img.h, boxW, boxH);
      doc.addImage(img.data, "PNG", x, 40, s.w, s.h, undefined, "FAST");
    });
  }
  if (want.positions) {
    POSITION_SETS.forEach((set) => {
      const cols = colsFor(set.keys);
      page(set.title);
      table(cols.map((c) => c.h), d.rows.map((r) => cols.map((c) => fmtCell(c, r).replace("−", "-"))), 28, 7.5);
    });
  }
  if (want.sectors) { page("Sector allocation"); const t = sectorTable(d); table(t.head, t.body); }
  if (want.caps) { page("Market cap mix"); const t = capTable(d); table(t.head, t.body); }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(137, 135, 129);
    doc.text(`Risk Sheet · ${stamp()}`, M, 203); doc.text(`${i} / ${pages}`, W - M, 203, { align: "right" });
  }
  doc.save(fileName("pdf"));
}

/* ---------- PowerPoint ---------- */
async function buildPptx(d, want, images) {
  const pptx = new window.PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = "Portfolio risk report";
  const head = (slide, title, note) => {
    slide.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.6, fontSize: 24, bold: true, color: "0B0B0B", fontFace: "Calibri" });
    if (note) slide.addText(note, { x: 0.5, y: 0.85, w: 12.3, h: 0.35, fontSize: 12, color: "76746E", fontFace: "Calibri" });
  };
  const tableSlides = (title, headRow, body, perSlide = 13) => {
    for (let i = 0; i < Math.max(body.length, 1); i += perSlide) {
      const slide = pptx.addSlide();
      head(slide, title + (body.length > perSlide ? ` (${i / perSlide + 1} of ${Math.ceil(body.length / perSlide)})` : ""));
      const rows = [headRow.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: BLUE }, align: "center" } })),
        ...body.slice(i, i + perSlide).map((r) => r.map((cell, c) => ({ text: cell, options: { align: c === 0 ? "left" : "right", bold: c === 0 } })))];
      slide.addTable(rows, { x: 0.5, y: 1.2, w: 12.3, fontSize: headRow.length > 9 ? 9 : 11, fontFace: "Calibri", color: "1E1E1E", border: { type: "solid", pt: 0.5, color: "E1E0D9" }, rowH: 0.36, valign: "middle" });
    }
  };

  const cover = pptx.addSlide();
  cover.background = { color: BLUE };
  cover.addText("Portfolio risk report", { x: 0.8, y: 2.6, w: 11.7, h: 1, fontSize: 44, bold: true, color: "FFFFFF", fontFace: "Calibri" });
  cover.addText(`Generated ${stamp()}`, { x: 0.8, y: 3.7, w: 11.7, h: 0.5, fontSize: 18, color: "E6F0FC", fontFace: "Calibri" });

  if (want.summary) {
    const slide = pptx.addSlide();
    head(slide, "Summary");
    summaryItems(d).forEach(([label, value], i) => {
      const x = 0.5 + (i % 4) * 3.1, y = 1.4 + Math.floor(i / 4) * 2.2;
      slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 2.9, h: 1.9, fill: { color: "F9F9F7" }, line: { color: "E1E0D9", width: 1 }, rectRadius: 0.08 });
      slide.addText(label, { x: x + 0.2, y: y + 0.25, w: 2.5, h: 0.4, fontSize: 13, color: "76746E", fontFace: "Calibri" });
      slide.addText(value, { x: x + 0.2, y: y + 0.75, w: 2.5, h: 0.8, fontSize: 20, bold: true, color: "0B0B0B", fontFace: "Calibri", fit: "shrink" });
    });
  }
  if (want.charts) {
    images.forEach((img) => {
      const slide = pptx.addSlide();
      head(slide, img.title, img.note);
      const s = fit(img.w, img.h, 12.3, 5.9);
      slide.addImage({ data: img.data, x: 0.5 + (12.3 - s.w) / 2, y: 1.35, w: s.w, h: s.h });
    });
  }
  if (want.positions) POSITION_SETS.forEach((set) => { const cols = colsFor(set.keys); tableSlides(set.title, cols.map((c) => c.h), d.rows.map((r) => cols.map((c) => fmtCell(c, r)))); });
  if (want.sectors) { const t = sectorTable(d); tableSlides("Sector allocation", t.head, t.body); }
  if (want.caps) { const t = capTable(d); tableSlides("Market cap mix", t.head, t.body); }
  await pptx.writeFile({ fileName: fileName("pptx") });
}

/* ---------- Excel ---------- */
async function buildXlsx(d, want, images) {
  const wb = new window.ExcelJS.Workbook();
  wb.created = new Date();
  const styleHead = (ws) => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + BLUE } };
    row.alignment = { vertical: "middle", horizontal: "center" };
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  };
  const fmts = { money: "$#,##0.00", pct: "0.00%", delta: "0.00%", shares: "#,##0.####" };

  if (want.summary) {
    const ws = wb.addWorksheet("Summary");
    ws.columns = [{ header: "Metric", key: "m", width: 34 }, { header: "Value", key: "v", width: 22 }];
    const t = d.totals;
    [["Total portfolio value", t.total, fmts.money], ["Invested", t.invested, fmts.money], ["Cash", t.cash, fmts.money],
     ["Cost of positions", t.cost, fmts.money], ["Unrealised profit / loss", t.pnl, fmts.money], ["Unrealised profit / loss %", t.pnl_pct, fmts.pct],
     ["Portfolio beta", t.beta, "0.00"], ["Expected return (CAPM)", t.expected_return, fmts.pct], ["Value at risk (1 day, 95%)", t.var, fmts.money],
     ["Positions", t.positions, "0"], ["Generated", stamp(), null]].forEach(([m, v, f]) => { const r = ws.addRow({ m, v }); if (f) r.getCell(2).numFmt = f; });
    styleHead(ws);
  }
  if (want.positions) {
    const ws = wb.addWorksheet("Positions");
    const cols = COLS.map((c) => (c.k === "cap_formatted" ? { ...c, k: "market_cap", type: "money0" } : c));
    ws.columns = cols.map((c) => ({ header: c.h, key: c.k, width: Math.max(13, c.h.length + 3) }));
    d.rows.forEach((r) => ws.addRow(Object.fromEntries(cols.map((c) => [c.k, r[c.k] ?? null]))));
    cols.forEach((c, i) => {
      const f = c.type === "money0" ? "$#,##0" : c.type === "num" ? (c.d === 0 ? "0" : "0." + "0".repeat(c.d ?? 2)) : fmts[c.type];
      if (f) ws.getColumn(i + 1).numFmt = f;
    });
    styleHead(ws);
  }
  if (want.sectors) {
    const ws = wb.addWorksheet("Sectors");
    ws.columns = [["Sector", "sector", 28], ["Stocks", "count", 10], ["Total value", "total_value", 16], ["Weight", "weight", 12], ["Target", "set_allocation", 12], ["Target value", "allocation_goal", 16], ["S&P 500 weight", "market_weight", 16]].map(([header, key, width]) => ({ header, key, width }));
    d.sectors.forEach((s) => ws.addRow(s));
    [3, 6].forEach((i) => (ws.getColumn(i).numFmt = fmts.money));
    [4, 5, 7].forEach((i) => (ws.getColumn(i).numFmt = fmts.pct));
    styleHead(ws);
  }
  if (want.caps) {
    const ws = wb.addWorksheet("Market cap");
    ws.columns = [{ header: "Category", key: "category", width: 18 }, { header: "Count", key: "count", width: 10 }, { header: "Share of value", key: "pct", width: 16 }];
    d.caps.forEach((c) => ws.addRow(c));
    ws.getColumn(3).numFmt = fmts.pct;
    styleHead(ws);
  }
  if (want.summary && d.history.length) {
    const ws = wb.addWorksheet("Value history");
    ws.columns = [{ header: "Day", key: "day", width: 14 }, { header: "Invested", key: "invested", width: 16 }, { header: "Cash", key: "cash", width: 16 }, { header: "Total", key: "total", width: 16 }];
    d.history.forEach((h) => ws.addRow(h));
    [2, 3, 4].forEach((i) => (ws.getColumn(i).numFmt = fmts.money));
    styleHead(ws);
  }
  if (want.charts && images.length) {
    const ws = wb.addWorksheet("Charts");
    ws.getColumn(1).width = 4;
    let row = 1;
    images.forEach((img) => {
      ws.getCell(row, 2).value = img.title; ws.getCell(row, 2).font = { bold: true, size: 14 };
      ws.getCell(row + 1, 2).value = img.note; ws.getCell(row + 1, 2).font = { color: { argb: "FF76746E" } };
      const s = fit(img.w, img.h, 760, 620);
      ws.addImage(wb.addImage({ base64: img.data, extension: "png" }), { tl: { col: 1, row: row + 1.5 }, ext: { width: s.w, height: s.h } });
      row += Math.ceil(s.h / 20) + 5;
    });
  }
  if (!wb.worksheets.length) wb.addWorksheet("Report");
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = fileName("xlsx");
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- entry point ---------- */
async function makeReport() {
  const status = document.getElementById("reportStatus"), btn = document.getElementById("makeReport");
  const format = document.querySelector('input[name="fmt"]:checked').value;
  const want = Object.fromEntries([...document.querySelectorAll("#reportSections input")].map((i) => [i.value, i.checked]));
  if (!Object.values(want).some(Boolean)) { status.textContent = "Tick at least one thing to include."; return; }
  if (!state.positions.length) { status.textContent = "Add a position first, then the report will have something to show."; return; }
  if (!state.analytics) { status.textContent = state.loading ? "Market data is still loading. Try again in a moment." : "Market data hasn't loaded. Use Refresh prices, then try again."; return; }
  btn.disabled = true;
  status.textContent = "Building your report…";
  try {
    for (const src of LIBS[format]) await loadScript(src);
    const d = derive();
    const images = want.charts ? chartImages(d) : [];
    await { pdf: buildPdf, pptx: buildPptx, xlsx: buildXlsx }[format](d, want, images);
    status.textContent = `Done. ${fileName(format)} is in your downloads.`;
  } catch (e) {
    console.error(e);
    status.textContent = `The report couldn't be built: ${e.message}`;
  }
  btn.disabled = false;
}
document.getElementById("makeReport").addEventListener("click", makeReport);
