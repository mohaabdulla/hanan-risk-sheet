/* Formula workbook and native Excel charts. ExcelJS writes cells; the final ZIP
   pass adds DrawingML charts (ExcelJS itself does not author charts).
   Chart parts follow https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-insert-a-chart-into-a-spreadsheet */
function createExcelReport(d, want) {
  const wb = new window.ExcelJS.Workbook();
  wb.creator = "Risk Sheet";
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  const charts = [];
  const currency = d.market === "bh" ? '"BD "#,##0.000' : '"$"#,##0.00';
  const decimals = d.market === "bh" ? 3 : 2;
  const formula = (f, result) => ({ formula: f, result: result ?? "" });
  const ref = (name, cell) => `'${name.replace(/'/g, "''")}'!${cell}`;
  const sheet = (name, headers, widths = []) => {
    const ws = wb.addWorksheet(name);
    ws.columns = headers.map((header, i) => ({ header, width: widths[i] || Math.max(18, header.length + 3) }));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A78D6" } };
    ws.getRow(1).height = 26;
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };
  const guide = sheet("Read me", ["Excel report", "How to use"], [30, 110]);
  [
    ["Market", d.marketLabel], ["Market data as of", d.asOf || "Export time"],
    ["Edit inputs", "Blue text is editable input; dark text is calculated. Change holdings on Positions, cash on Inputs, and targets on Sectors."],
    ["Automatic calculations", "Excel recalculates formulas and linked charts when existing inputs change. Each chart sheet has its own source table beside the graph."],
    ["Chart ranges", "Chart ranges cover exported rows. If you add rows or a new category, extend the formulas and use Excel Chart Design > Select Data to include them."],
    ["Market data", "Prices, ATR, beta, expected returns, volatility and VaR rates are export-date inputs. This workbook does not download prices or rerun historical market models."],
    ["Risk calculation", "Position VaR = current position value times the exported VaR rate. Portfolio VaR sums positions; it does not account for diversification."],
    ["Performance", "Historical portfolio and benchmark returns are exported observations, not reconstructed from edited holdings. Edit the history tables to update their charts."],
    ["Missing data", "Missing market inputs stay blank; priced holdings alone contribute to value, allocation and cost totals."],
    ["Supporting sheets", "Inputs and Positions are included whenever calculations need them. Charts also include their sector, cap and historical source sheets."],
  ].forEach((r) => guide.addRow(r));
  guide.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  for (let i = 2; i <= guide.rowCount; i++) guide.getRow(i).height = 34;

  const needHoldings = want.summary || want.positions || want.sectors || want.caps || want.charts;
  if (!needHoldings) return { wb, charts };
  const inputs = sheet("Inputs", ["Input", "Value"]);
  inputs.addRow(["Cash", d.totals.cash]); inputs.getCell("B2").numFmt = currency;
  inputs.addRow(["As of date", new Date()]); inputs.getCell("B3").numFmt = "yyyy-mm-dd";
  const keys = ["ticker", "sector", "date_bought", "shares", "price_bought", "value_paid", "current_price", "position_value", "pct_change", "entry_atr", "no_atrs", "take_profit", "stop_loss", "current_tp", "current_sl", "beta", "weight", "beta_weighted", "expected_return", "weighted_expected_return", "var", "iv", "holding_period", "market_cap", "cap_tier", "atr", "var_rate", "sector_count"];
  const headers = ["Ticker", "Sector", "Date bought", "Shares", "Price bought", "Value paid", "Current price", "Current value", "Profit / loss", "Entry ATR", "No. ATRs", "Take profit (entry)", "Stop loss (entry)", "Take profit (now)", "Stop loss (now)", "Beta", "Weight", "Beta x weight", "Expected return", "Weighted exp. return", "VaR (95%)", "Volatility input", "Days held", "Market cap", "Cap tier", "Current ATR", "VaR rate input", "Sector stock count"];
  const pos = sheet("Positions", headers);
  const end = Math.max(2, d.rows.length + 1);
  const range = (col) => `Positions!$${col}$2:$${col}$${end}`;
  const sum = (col) => `SUM(${range(col)})`;
  d.rows.forEach((r, i) => {
    const n = i + 2;
    const values = keys.map((k) => r[k] ?? null);
    values[2] = r.date_bought ? new Date(r.date_bought + "T00:00:00Z") : null;
    values[26] = isNum(r.var) && r.position_value > 0 ? r.var / r.position_value : null;
    pos.addRow(values);
    const formulas = {
      F: [`ROUND(D${n}*E${n},${decimals})`, r.value_paid],
      H: [`IF(ISNUMBER(G${n}),ROUND(D${n}*G${n},${decimals}),"")`, r.position_value],
      I: [`IF(AND(ISNUMBER(G${n}),E${n}>0),ROUND(G${n}/E${n}-1,4),"")`, r.pct_change],
      K: [`IF(AND(J${n}>0,ISNUMBER(G${n})),ROUND((G${n}-E${n})/J${n},4),"")`, r.no_atrs],
      L: [`IF(J${n}>0,ROUND(E${n}+2*J${n},${decimals}),"")`, r.take_profit],
      M: [`IF(J${n}>0,ROUND(E${n}-2*J${n},${decimals}),"")`, r.stop_loss],
      N: [`IF(AND(Z${n}>0,ISNUMBER(G${n})),ROUND(G${n}+2*Z${n},${decimals}),"")`, r.current_tp],
      O: [`IF(AND(Z${n}>0,ISNUMBER(G${n})),ROUND(G${n}-2*Z${n},${decimals}),"")`, r.current_sl],
      Q: [`IF(AND(ISNUMBER(H${n}),${sum("H")}>0),ROUND(H${n}/${sum("H")},4),"")`, r.weight],
      R: [`IF(AND(ISNUMBER(P${n}),ISNUMBER(Q${n})),ROUND(P${n}*Q${n},6),"")`, r.beta_weighted],
      T: [`IF(AND(ISNUMBER(S${n}),ISNUMBER(Q${n})),ROUND(S${n}*Q${n},6),"")`, r.weighted_expected_return],
      U: [`IF(AND(ISNUMBER(AA${n}),ISNUMBER(H${n})),ROUND(H${n}*AA${n},2),"")`, r.var],
      W: [`IF(ISNUMBER(C${n}),MAX(0,INT(Inputs!B3-C${n})),"")`, r.holding_period],
      Y: [`IF(X${n}>0,IF(X${n}>=100000000000,"Mega Cap",IF(X${n}>=10000000000,"Large Cap",IF(X${n}>=2000000000,"Mid Cap",IF(X${n}>=500000000,"Small Cap","Micro Cap")))),"")`, r.cap_tier],
      AB: [`IF(ISNUMBER(H${n}),IF(COUNTIFS($A$2:A${n},A${n},$B$2:B${n},B${n},$G$2:G${n},">=0")=1,1,0),0)`, d.rows.slice(0, i).some((p) => p.ticker === r.ticker && p.sector === r.sector && isNum(p.current_price)) || !isNum(r.current_price) ? 0 : 1],
    };
    Object.entries(formulas).forEach(([col, [f, cached]]) => { pos.getCell(`${col}${n}`).value = formula(f, cached); });
  });
  [5, 6, 7, 8, 12, 13, 14, 15, 21].forEach((c) => { pos.getColumn(c).numFmt = currency; });
  [9, 17, 19, 20, 22, 27].forEach((c) => { pos.getColumn(c).numFmt = "0.00%"; });
  [10, 11, 16, 18, 26].forEach((c) => { pos.getColumn(c).numFmt = "0.0000"; });
  pos.getColumn(3).numFmt = "yyyy-mm-dd";
  pos.getColumn(4).numFmt = "#,##0.####";
  pos.getColumn(24).numFmt = '"$"#,##0';
  pos.getColumn(28).hidden = true;
  if (!d.hasCaps) [24, 25].forEach((c) => { pos.getColumn(c).hidden = true; });
  pos.autoFilter = { from: "A1", to: `AB${end}` };

  const t = d.totals;
  if (want.summary) {
    const ws = sheet("Summary", ["Metric", "Value"], [36, 24]);
    const metrics = [
      ["Total portfolio value", `${sum("H")}+Inputs!B2`, t.total, currency],
      ["Invested", sum("H"), t.invested, currency],
      ["Cash", "Inputs!B2", t.cash, currency],
      ["Cost of priced positions", `SUMIF(${range("H")},">=0",${range("F")})`, t.cost, currency],
      ["Unrealised profit / loss", "B3-B5", t.pnl, currency],
      ["Unrealised profit / loss %", 'IF(B5>0,ROUND(B6/B5,4),"")', t.pnl_pct, "0.00%"],
      ["Portfolio beta", `IF(COUNT(${range("R")})>0,ROUND(${sum("R")},4),"")`, t.beta, "0.0000"],
      ["Expected return (CAPM inputs)", `IF(COUNT(${range("T")})>0,ROUND(${sum("T")},6),"")`, t.expected_return, "0.00%"],
      ["Value at risk (1 day, 95%)", `IF(COUNT(${range("H")})>0,${sum("U")},"")`, t.var, currency],
      ["Positions", `COUNTA(${range("A")})`, d.rows.length, "0"],
    ];
    metrics.forEach(([label, f, value, fmt]) => { const row = ws.addRow([label, formula(f, value)]); row.getCell(2).numFmt = fmt; });
  }

  if (want.sectors || want.charts) {
    const ws = sheet("Sectors", ["Sector", "Stocks", "Total value", "Weight", "Target", "Target value", ...(d.hasMarketWeights ? ["S&P 500 weight"] : [])]);
    d.sectors.forEach((s, i) => {
      const n = i + 2;
      ws.addRow([s.sector,
        formula(`SUMIF(${range("B")},A${n},${range("AB")})`, s.count),
        formula(`SUMIF(${range("B")},A${n},${range("H")})`, s.total_value),
        formula(`IFERROR(C${n}/${sum("H")},0)`, s.weight), s.set_allocation,
        formula(`${sum("H")}*E${n}`, s.allocation_goal), ...(d.hasMarketWeights ? [s.market_weight] : [])]);
    });
    [3, 6].forEach((c) => { ws.getColumn(c).numFmt = currency; });
    [4, 5, 7].forEach((c) => { ws.getColumn(c).numFmt = "0.00%"; });
  }
  if ((want.caps || want.charts) && d.hasCaps) {
    const ws = sheet("Market cap", ["Category", "Count", "Share of value"]);
    d.caps.filter((c) => c.category !== "Total").forEach((c, i) => {
      const n = i + 2;
      ws.addRow([c.category,
        formula(`COUNTIFS(${range("Y")},A${n},${range("H")},">=0")`, c.count),
        formula(`IFERROR(SUMIF(${range("Y")},A${n},${range("H")})/${sum("H")},0)`, c.pct)]);
    });
    ws.getColumn(3).numFmt = "0.00%";
  }
  if ((want.summary || want.charts) && d.performance) {
    const p = d.performance;
    const ws = sheet("Performance", ["Day", "Your portfolio return", `${d.benchmark.name} return`]);
    p.days.forEach((day, i) => ws.addRow([day, p.portfolio[i], p.benchmark?.[i] ?? null]));
    [2, 3].forEach((c) => { ws.getColumn(c).numFmt = "0.00%"; });
    if (want.summary) {
      const summary = wb.getWorksheet("Summary");
      [2, 3].forEach((c) => {
        const col = ws.getColumn(c).letter;
        const last = Math.max(2, ws.rowCount);
        const observed = (c === 2 ? p.portfolio : p.benchmark) || [];
        const latest = [...observed].reverse().find(isNum);
        const row = summary.addRow([c === 2 ? "Your return (history)" : `${d.benchmark.name} return (history)`, formula(`IFERROR(LOOKUP(2,1/(ISNUMBER(Performance!${col}2:${col}${last})),Performance!${col}2:${col}${last}),"")`, latest)]);
        row.getCell(2).numFmt = "0.00%";
      });
    }
  }
  if ((want.summary || want.charts) && d.history.length) {
    const ws = sheet("Value history", ["Day", "Invested", "Cash", "Total"]);
    d.history.forEach((h, i) => ws.addRow([h.day, h.invested, h.cash, formula(`B${i + 2}+C${i + 2}`, h.total)]));
    [2, 3, 4].forEach((c) => { ws.getColumn(c).numFmt = currency; });
  }

  // Every graph uses contiguous cells on its own sheet, linked by formulas to
  // editable supporting sheets. No screen-rendered images are used in Excel.
  const graph = (name, title, source, columns, rowNumbers, kind, fmt, note) => {
    const ws = wb.addWorksheet(name);
    ws.getCell("A1").value = title; ws.getCell("A1").font = { bold: true, size: 16 };
    ws.mergeCells("A1:F1"); ws.mergeCells("A2:F3");
    ws.getCell("A2").value = note; ws.getCell("A2").alignment = { wrapText: true, vertical: "top" };
    ws.views = [{ state: "frozen", ySplit: 4 }];
    const src = wb.getWorksheet(source);
    columns.forEach((col, i) => {
      ws.getColumn(i + 1).width = i ? 24 : 32;
      const cell = ws.getCell(4, i + 1);
      cell.value = src.getCell(`${col}1`).value;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2A78D6" } };
    });
    rowNumbers.forEach((r, i) => columns.forEach((col, j) => {
      const sourceCell = src.getCell(`${col}${r}`);
      const value = sourceCell.type === window.ExcelJS.ValueType.Formula ? sourceCell.result : sourceCell.value;
      const cell = ws.getCell(i + 5, j + 1);
      cell.value = formula(`IF(${ref(source, `${col}${r}`)}="","",${ref(source, `${col}${r}`)})`, value);
      if (j) cell.numFmt = fmt;
    }));
    if (rowNumbers.length) charts.push({ ws, title, kind, fmt, count: rowNumbers.length, series: columns.length - 1 });
    else ws.getCell("H5").value = "No data available for this chart at export time.";
  };
  const rowsOf = (name) => Array.from({ length: wb.getWorksheet(name).rowCount - 1 }, (_, i) => i + 2);
  if (want.charts) {
    if (d.performance) graph("Chart - Performance", "Your performance vs the market", "Performance", d.performance.benchmark ? ["A", "B", "C"] : ["A", "B"], rowsOf("Performance"), "line", "0.00%", `Exported historical returns compared with ${d.benchmark.name}.${d.benchmark.source === "estimate" ? " Benchmark is an equal-weight market estimate." : ""} Edit the Performance table to update this graph.`);
    graph("Chart - Sectors", "Sector allocation", "Sectors", ["A", "D"], rowsOf("Sectors"), "bar", "0.00%", "Share of invested value by sector. Updates from Positions.");
    graph("Chart - Targets", "Portfolio vs target" + (d.hasMarketWeights ? " vs market" : ""), "Sectors", d.hasMarketWeights ? ["A", "D", "E", "G"] : ["A", "D", "E"], rowsOf("Sectors"), "bar", "0.00%", "Sector weights compared with editable targets and exported market weights.");
    [["Profit loss", "Profit / loss by position", "I", "0.00%"], ["Weights", "Position weights", "Q", "0.00%"], ["VaR", "Value at risk by position", "U", currency]].forEach(([name, title, col, fmt]) => {
      graph(`Chart - ${name}`, title, "Positions", ["A", col], d.rows.flatMap((r, i) => isNum(r.position_value) ? [i + 2] : []), "bar", fmt, col === "U" ? "One day, 95%. Updates position value using the exported VaR rate; historical models are not rerun." : "Updates when shares or prices change on Positions. Repeated tickers represent separate purchase lots.");
    });
    if (d.hasCaps) graph("Chart - Market cap", "Market cap mix", "Market cap", ["A", "C"], rowsOf("Market cap"), "col", "0.00%", "Share of invested value by company size. Market caps are editable export-date inputs.");
    if (d.history.length) graph("Chart - Value history", "Portfolio value over time", "Value history", ["A", "D"], rowsOf("Value history"), "line", currency, "Invested value plus cash. Edit the Value history table to update historical observations.");
  }
  wb.worksheets.forEach((ws) => ws.eachRow((row) => row.eachCell((cell) => {
    if (cell.row > 1 && cell.type !== window.ExcelJS.ValueType.Formula && !ws.name.startsWith("Chart -")) {
      cell.font = { ...cell.font, color: { argb: "FF2A78D6" } };
    }
  })));
  return { wb, charts };
}

async function excelReportBuffer(d, want) {
  const { wb, charts } = createExcelReport(d, want);
  const buffer = await wb.xlsx.writeBuffer();
  if (!charts.length) return buffer;
  const zip = await window.JSZip.loadAsync(buffer);
  const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const relNS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const officeNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const chartNS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
  const drawingNS = "http://schemas.openxmlformats.org/drawingml/2006/main";
  let types = await zip.file("[Content_Types].xml").async("string");
  for (let i = 0; i < charts.length; i++) {
    const g = charts[i], id = i + 1;
    const sheetId = wb.worksheets.indexOf(g.ws) + 1;
    const prefix = `'${g.ws.name.replace(/'/g, "''")}'!`;
    const cached = (cell) => cell.type === window.ExcelJS.ValueType.Formula ? cell.result : cell.value;
    const points = (col, numeric) => Array.from({ length: g.count }, (_, j) => {
      const value = cached(g.ws.getCell(j + 5, col));
      return value === "" || value == null || (numeric && !Number.isFinite(value)) ? "" : `<c:pt idx="${j}"><c:v>${xml(value)}</c:v></c:pt>`;
    }).join("");
    const cat = `<c:cat><c:strRef><c:f>${xml(prefix + `$A$5:$A$${g.count + 4}`)}</c:f><c:strCache><c:ptCount val="${g.count}"/>${points(1, false)}</c:strCache></c:strRef></c:cat>`;
    const series = Array.from({ length: g.series }, (_, s) => {
      const col = g.ws.getColumn(s + 2).letter;
      const color = ["2A78D6", "EB6834", "1BAF7A"][s % 3];
      return `<c:ser><c:idx val="${s}"/><c:order val="${s}"/><c:tx><c:strRef><c:f>${xml(prefix + `$${col}$4`)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xml(g.ws.getCell(4, s + 2).value)}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr>${g.kind === "line" ? `<a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>` : `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`}</c:spPr>${cat}<c:val><c:numRef><c:f>${xml(prefix + `$${col}$5:$${col}$${g.count + 4}`)}</c:f><c:numCache><c:formatCode>${xml(g.fmt)}</c:formatCode><c:ptCount val="${g.count}"/>${points(s + 2, true)}</c:numCache></c:numRef></c:val></c:ser>`;
    }).join("");
    const kind = g.kind === "line" ? "lineChart" : "barChart";
    const plot = `<c:${kind}>${kind === "barChart" ? `<c:barDir val="${g.kind === "bar" ? "bar" : "col"}"/>` : ""}<c:grouping val="${kind === "barChart" ? "clustered" : "standard"}"/>${series}<c:axId val="100"/><c:axId val="200"/></c:${kind}>`;
    const axes = `<c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${g.kind === "bar" ? "l" : "b"}"/><c:crossAx val="200"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${g.kind === "bar" ? "b" : "l"}"/><c:majorGridlines/><c:numFmt formatCode="${xml(g.fmt)}" sourceLinked="0"/><c:crossAx val="100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
    zip.file(`xl/charts/chart${id}.xml`, `${declaration}<c:chartSpace xmlns:c="${chartNS}" xmlns:a="${drawingNS}"><c:lang val="en-US"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(g.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${g.series > 1 ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : ""}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`);
    zip.file(`xl/drawings/drawing${id}.xml`, `${declaration}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawingNS}"><xdr:twoCellAnchor><xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>20</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>29</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNS}"><c:chart xmlns:c="${chartNS}" xmlns:r="${officeNS}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${id}.xml.rels`, `${declaration}<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/chart" Target="../charts/chart${id}.xml"/></Relationships>`);
    const path = `xl/worksheets/sheet${sheetId}.xml`;
    const sheetXml = await zip.file(path).async("string");
    zip.file(path, sheetXml.replace("</worksheet>", '<drawing r:id="rIdChart"/></worksheet>'));
    const relPath = `xl/worksheets/_rels/sheet${sheetId}.xml.rels`;
    const rels = zip.file(relPath) ? await zip.file(relPath).async("string") : `${declaration}<Relationships xmlns="${relNS}"></Relationships>`;
    zip.file(relPath, rels.replace("</Relationships>", `<Relationship Id="rIdChart" Type="${officeNS}/drawing" Target="../drawings/drawing${id}.xml"/></Relationships>`));
    types = types.replace("</Types>", `<Override PartName="/xl/charts/chart${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  }
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
