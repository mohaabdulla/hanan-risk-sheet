"""Risk Sheet API. No login: every endpoint is open to anyone who can reach the site."""
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from backend import db

app = FastAPI(title="Risk Sheet", version="2.0.0")

TICKER_RE = re.compile(r"^[A-Z0-9.\-^=]{1,12}$")


class PositionIn(BaseModel):
    ticker: str
    shares: float = Field(..., ge=0)
    price_bought: float = Field(..., ge=0)
    date_bought: Optional[str] = None

    @field_validator("ticker")
    @classmethod
    def _ticker(cls, v: str) -> str:
        v = (v or "").strip().upper()
        if not TICKER_RE.match(v):
            raise ValueError("Enter a valid ticker symbol, for example AAPL")
        return v

    @field_validator("date_bought")
    @classmethod
    def _date(cls, v: Optional[str]) -> Optional[str]:
        v = (v or "").strip()
        if not v:
            return None
        try:
            parsed = datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("Date must be YYYY-MM-DD")
        if parsed > datetime.now():
            raise ValueError("Purchase date can't be in the future")
        return v


class CashIn(BaseModel):
    amount: float = Field(..., ge=0)


class AllocationIn(BaseModel):
    sector: str = Field(..., min_length=1, max_length=80)
    allocation: float = Field(..., ge=0, le=1)


@app.exception_handler(RuntimeError)
def _runtime_error(_, exc: RuntimeError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/api/health")
def health():
    info = db.describe()
    try:
        db.run("SELECT 1")
        info["connected"] = True
    except Exception as exc:
        info["connected"] = False
        info["error"] = str(exc)
    return info


@app.get("/api/portfolio")
def portfolio():
    return {
        "positions": db.list_positions(),
        "cash": db.get_cash(),
        "allocations": db.get_allocations(),
    }


@app.get("/api/analytics")
def analytics():
    from backend import analytics as calc  # heavy imports, loaded only when needed

    return calc.compute(db.list_positions(), db.get_cash())


@app.post("/api/positions")
def add_position(pos: PositionIn):
    return db.create_position(pos.ticker, pos.shares, pos.price_bought, pos.date_bought)


@app.put("/api/positions/{pid}")
def edit_position(pid: str, pos: PositionIn):
    updated = db.update_position(pid, pos.ticker, pos.shares, pos.price_bought, pos.date_bought)
    if not updated:
        raise HTTPException(status_code=404, detail="Position not found")
    return updated


@app.delete("/api/positions/{pid}")
def remove_position(pid: str):
    """Moves the position to the bin. Nothing is erased; it can be restored."""
    removed = db.soft_delete_position(pid)
    if not removed:
        raise HTTPException(status_code=404, detail="Position not found")
    return removed


@app.post("/api/positions/{pid}/restore")
def restore_position(pid: str):
    restored = db.restore_position(pid)
    if not restored:
        raise HTTPException(status_code=404, detail="Position not found")
    return restored


@app.get("/api/bin")
def removed_positions():
    return db.list_positions(deleted=True)


@app.put("/api/cash")
def set_cash(cash: CashIn):
    return {"amount": db.set_cash(cash.amount)}


@app.put("/api/allocations")
def set_allocation(alloc: AllocationIn):
    db.set_allocation(alloc.sector.strip(), alloc.allocation)
    return db.get_allocations()


@app.get("/api/activity")
def activity():
    return db.list_activity()


@app.get("/api/backup")
def backup():
    """Everything the app stores, as one JSON file."""
    body = {
        "exported_at": db.now(),
        "positions": db.list_positions(),
        "removed_positions": db.list_positions(deleted=True),
        "cash": db.get_cash(),
        "allocations": db.get_allocations(),
        "value_history": db.list_value_history(),
        "activity": db.list_activity(limit=100000),
    }
    name = f"risk-sheet-backup-{datetime.now().strftime('%Y-%m-%d')}.json"
    return JSONResponse(body, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# Local runs serve the frontend from here. On Vercel the CDN serves /public directly.
_public = Path(__file__).resolve().parent.parent / "public"
if _public.is_dir():
    app.mount("/", StaticFiles(directory=_public, html=True), name="static")
