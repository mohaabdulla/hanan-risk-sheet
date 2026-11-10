"""Risk Sheet API. No login: every endpoint is open to anyone who can reach the site.

Two separate portfolios are kept, one per market: "us" (United States) and "bh" (Bahrain).
"""
import re
from datetime import datetime
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from backend import db

app = FastAPI(title="Risk Sheet", version="3.0.0")

Market = Literal["us", "bh"]
TICKER_RE = re.compile(r"^[A-Z0-9.\-^=]{1,12}$")


def _day(v: str) -> str:
    v = (v or "").strip()
    try:
        parsed = datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise ValueError("Enter the date as YYYY-MM-DD")
    if parsed > datetime.now():
        raise ValueError("The date can't be in the future")
    return v


class PositionIn(BaseModel):
    ticker: str
    shares: float = Field(..., gt=0)
    price_bought: float = Field(..., gt=0)
    date_bought: str

    @field_validator("ticker")
    @classmethod
    def _ticker(cls, v: str) -> str:
        v = (v or "").strip().upper()
        if not TICKER_RE.match(v):
            raise ValueError("Enter a valid ticker symbol")
        return v

    @field_validator("date_bought")
    @classmethod
    def _date(cls, v: str) -> str:
        if not (v or "").strip():
            raise ValueError("Enter the date you bought the shares")
        return _day(v)


class NewPosition(PositionIn):
    market: Market


class CashIn(BaseModel):
    market: Market
    amount: float = Field(..., ge=0)


class AllocationIn(BaseModel):
    market: Market
    sector: str = Field(..., min_length=1, max_length=80)
    allocation: float = Field(..., ge=0, le=1)


class BenchmarkIn(BaseModel):
    symbol: str


class IndexPoint(BaseModel):
    day: str
    close: float = Field(..., gt=0)

    @field_validator("day")
    @classmethod
    def _d(cls, v: str) -> str:
        return _day(v)


class IndexImport(BaseModel):
    market: Literal["bh"]
    points: List[IndexPoint] = Field(..., min_length=1, max_length=20000)


@app.exception_handler(RuntimeError)
def _runtime_error(_, exc: RuntimeError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def _calc():
    from backend import analytics  # heavy imports, loaded only when needed

    return analytics


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
def portfolio(market: Market = "us"):
    return {
        "positions": db.list_positions(market),
        "cash": db.get_cash(market),
        "allocations": db.get_allocations(market),
        "config": _calc().market_config(market),
    }


@app.get("/api/analytics")
def analytics(market: Market = "us"):
    return _calc().compute(market)


@app.post("/api/positions")
def add_position(pos: NewPosition):
    return db.create_position(pos.market, pos.ticker, pos.shares, pos.price_bought, pos.date_bought)


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
def removed_positions(market: Market = "us"):
    return db.list_positions(market, deleted=True)


@app.put("/api/cash")
def set_cash(cash: CashIn):
    return {"amount": db.set_cash(cash.market, cash.amount)}


@app.put("/api/allocations")
def set_allocation(alloc: AllocationIn):
    db.set_allocation(alloc.market, alloc.sector.strip(), alloc.allocation)
    return db.get_allocations(alloc.market)


@app.put("/api/benchmark")
def set_benchmark(body: BenchmarkIn):
    """Choose the index the US portfolio is compared with."""
    try:
        return _calc().set_benchmark(body.symbol)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/index-history")
def import_index(body: IndexImport):
    """Store Bahrain All Share Index closing levels. Existing days are updated, never removed."""
    saved = db.upsert_index_points(body.market, [p.model_dump() for p in body.points])
    return {"saved": saved, "config": _calc().market_config(body.market)}


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
        "cash": {m: db.get_cash(m) for m in ("us", "bh")},
        "sector_targets": {m: db.get_allocations(m) for m in ("us", "bh")},
        "value_history": {m: db.list_value_history(m) for m in ("us", "bh")},
        "bahrain_index_history": db.list_index_history("bh"),
        "us_benchmark": db.get_setting("benchmark:us", "^GSPC"),
        "activity": db.list_activity(limit=100000),
    }
    name = f"risk-sheet-backup-{datetime.now().strftime('%Y-%m-%d')}.json"
    return JSONResponse(body, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# Local runs serve the frontend from here. On Vercel the CDN serves /public directly.
_public = Path(__file__).resolve().parent.parent / "public"
if _public.is_dir():
    app.mount("/", StaticFiles(directory=_public, html=True), name="static")
