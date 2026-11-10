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
from the figures on screen and contain every chart plus the positions, sector and market-cap tables.

## Layout

- `backend/db.py` storage (Postgres / SQLite)
- `backend/analytics.py` market data and calculations
- `backend/main.py` API routes
- `public/` interface (`app.js`), report builder (`report.js`)
- `api/index.py` Vercel entry point
