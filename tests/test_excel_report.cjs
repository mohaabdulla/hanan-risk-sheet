/* Run: node tests/test_excel_report.cjs <exceljs.cjs> <jszip.cjs> <output-dir>
   Uses the same browser bundles as the report; no Node dependencies required. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ExcelJS = require(path.resolve(process.argv[2]));
const JSZip = require(path.resolve(process.argv[3]));
global.window = { ExcelJS, JSZip };
global.isNum = (v) => typeof v === "number" && Number.isFinite(v);
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../public/report-excel.js"), "utf8"));
const context = { createExcelReport, excelReportBuffer };
const fixture = {
  market: "us", marketLabel: "United States", asOf: "2026-11-10", hasCaps: true, hasMarketWeights: true,
  rows: [
    { ticker: "A&B", sector: "Tech & Services", date_bought: "2026-11-01", shares: 10, price_bought: 100, current_price: 120, position_value: 1200, value_paid: 1000, pct_change: .2, beta: 1.2, weight: .75, beta_weighted: .9, expected_return: .08, weighted_expected_return: .06, var: 24, iv: .3, market_cap: 200e9, cap_tier: "Mega Cap", entry_atr: 2, atr: 3 },
    { ticker: "A&B", sector: "Tech & Services", shares: 4, price_bought: 110, current_price: 100, position_value: 400, value_paid: 440, pct_change: -.0909, weight: .25, var: 8, market_cap: 200e9, cap_tier: "Mega Cap" },
    { ticker: "MISSING", sector: "Unknown", shares: 5, price_bought: 2, value_paid: 10, current_price: null, position_value: null },
  ],
  totals: { cash: 50, invested: 1600, total: 1650, cost: 1440, pnl: 160, pnl_pct: .1111, beta: .9, expected_return: .06, var: 32 },
  sectors: [{ sector: "Tech & Services", count: 1, total_value: 1600, weight: 1, set_allocation: .8, allocation_goal: 1280, market_weight: .3 }],
  caps: [{ category: "Mega Cap", count: 2, pct: 1 }, { category: "Total", count: 2, pct: 1 }],
  performance: { days: ["2026-11-01", "2026-11-10"], portfolio: [0, .1111], benchmark: [null, .05] },
  benchmark: { name: "Index & fund", source: "estimate" },
  history: [{ day: "2026-11-01", invested: 1440, cash: 50, total: 1490 }, { day: "2026-11-10", invested: 1600, cash: 50, total: 1650 }],
};

(async () => {
  const all = { summary: true, positions: true, sectors: true, caps: true, charts: true };
  const { wb, charts } = context.createExcelReport(fixture, all);
  assert.equal(charts.length, 8);
  const pos = wb.getWorksheet("Positions");
  assert.equal(pos.getCell("H2").result, 1200);
  assert.equal(pos.getCell("H4").result, "");
  assert.equal(pos.getCell("AB2").result, 1);
  assert.equal(pos.getCell("AB3").result, 0); // multiple lots count as one sector stock
  assert.equal(pos.getCell("AA2").value, .02);
  assert.match(pos.getCell("U2").formula, /H2\*AA2/);
  assert.match(wb.getWorksheet("Summary").getCell("B2").formula, /Inputs!B2/);
  assert.equal(wb.getWorksheet("Chart - Performance").getCell("C5").result, "");
  assert.equal(wb.getWorksheet("Chart - Performance").getCell("B5").result, 0);
  fs.mkdirSync(process.argv[4], { recursive: true });
  for (const [name, data, options, count] of [
    ["us", fixture, all, 8],
    ["charts-only", fixture, { charts: true }, 8],
    ["positions-only", fixture, { positions: true }, 0],
    ["bh", { ...fixture, market: "bh", marketLabel: "Bahrain", hasCaps: false, hasMarketWeights: false, performance: null, history: [] }, all, 5],
    ["missing", { ...fixture, rows: [fixture.rows[2]], sectors: [], caps: [], performance: null, history: [], hasCaps: false }, all, 0],
  ]) {
    const buffer = await context.excelReportBuffer(data, options);
    const zip = await JSZip.loadAsync(buffer);
    const chartFiles = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f));
    assert.equal(chartFiles.length, count, name);
    assert.equal(Object.keys(zip.files).filter((f) => f.startsWith("xl/media/")).length, 0);
    for (const f of chartFiles) {
      const xml = await zip.file(f).async("string");
      assert.match(xml, /<c:numRef><c:f>&apos;Chart - /);
      assert.doesNotMatch(xml, /NaN|undefined/);
    }
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer);
    assert.ok(reloaded.getWorksheet("Positions"));
    if (name === "bh") assert.equal(reloaded.getWorksheet("Positions").getCell("H2").numFmt, '"BD "#,##0.000');
    fs.writeFileSync(path.join(process.argv[4], `${name}.xlsx`), buffer);
  }
  console.log("Excel export: all 5 workbook scenarios passed.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
