# Risk Sheet

Portfolio risk tracker: enter ticker, shares, purchase price and (optionally) date; the server
calculates ATR, take-profit / stop-loss levels, beta vs SPY, CAPM expected return, Monte Carlo VaR,
volatility, weights, sector allocation and market-cap mix from Yahoo Finance data.

No login. Anyone with the link can view and edit.

## Run locally

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn backend.main:app --port 8000
```

Open http://localhost:8000. Without `DATABASE_URL`, data is stored in `data/risksheet.db` (SQLite).

## Deploy (Vercel + Postgres)

1. `npx vercel link`
2. Add a Postgres database (Vercel dashboard → Storage → Neon) so `DATABASE_URL` is set.
3. `npx vercel deploy --prod`

Tables are created automatically on first request.

## Data safety

- Positions are never erased. "Remove" hides a position; History → Restore brings it back.
- Every change is written to a change log (History tab).
- History → "Download full backup" exports everything as JSON.
- On a host with no database configured the API refuses to run instead of writing to temporary disk.

## Reports

Reports tab → choose PDF, PowerPoint or Excel and what to include. Files are built in the browser
from the figures on screen. PDF and PowerPoint contain chart images. Excel contains native editable
charts, each beside a linked source table, and formulas for position values, P/L, weights, ATR levels,
weighted risk, sector allocation, market-cap mix and totals. Supporting sheets are included as needed.
Blue cells contain editable inputs. Market prices and historical model outputs are export-date
snapshots; VaR scales with position value using the exported rate. Historical returns are observations,
not rebuilt from edited holdings. Existing-row edits recalculate in Excel; when adding rows, extend
formulas and chart ranges through Chart Design > Select Data.

## Capital and performance

Overview → **Set capital and start date** accepts the entire amount allocated to a
portfolio, including cash. With capital set, remaining cash follows capital minus
the purchase costs of active holdings. Capital must cover those purchases. Leave
capital blank to manage cash manually. Settings are saved separately for US and
Bahrain and included in full backups.

Performance includes cash at 0% from the selected date, even before the first
trade. The benchmark invests the full starting account value on that date. A
later reporting date rebases already-owned holdings. Prices are carried forward
from known observations, never backfilled from future prices. An index without
history covering the selected start is not compared; stale benchmark observations
are compared only with portfolio returns from the same day. These calculations
model the current purchase lots and exclude sales, deposits, withdrawals, fees and
cash dividends. Changes to the holdings reconstruct this model's past series.

Bahrain prices retain their quote currency; position values, costs and VaR are in
BHD. USD-quoted stocks use the 0.376 BHD/USD peg. The default Bahrain stock basket
is an estimate, **not the official All Share Index**. Import actual daily index
closes for that comparison. See [the dated Bahrain data audit](docs/bahrain-data-audit.md).

## Layout

- `backend/db.py` storage (Postgres / SQLite)
- `backend/analytics.py` market data and calculations
- `backend/main.py` API routes
- `public/` interface (`app.js`), report builder (`report.js`)
- `api/index.py` Vercel entry point

## Excel export checks

Download the ExcelJS 4.4.0 and JSZip 3.10.1 browser bundles used in `public/report.js`
to a temporary directory, then run:

```powershell
node tests/test_excel_report.cjs <exceljs-bundle-path> <jszip-bundle-path> <output-directory>
# Optional: open the generated fixtures in desktop Excel and verify recalculation.
./tests/test_excel_report.ps1 -WorkbookDirectory <output-directory>
```

The fixtures cover US and Bahrain workbooks, charts-only and positions-only exports,
missing market data, repeated purchase lots, zero returns and gaps in benchmark data.
