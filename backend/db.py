"""
Storage layer.

Production: PostgreSQL (DATABASE_URL / POSTGRES_URL).
Local dev:  SQLite file in ./data (created automatically).

Data-safety rules this module enforces:
  * Tables are only ever created with IF NOT EXISTS. Nothing is dropped or truncated.
  * Positions are never physically deleted. "Delete" sets deleted_at, and the row
    can be restored at any time.
  * Every change is appended to activity_log.
  * On a serverless host with no database configured we refuse to run rather than
    silently writing to a temporary disk that would be wiped.
"""
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _pg_url() -> str:
    for key in ("DATABASE_URL", "POSTGRES_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"):
        val = os.getenv(key, "").strip()
        if val:
            return val
    return ""


PG_URL = _pg_url()
IS_PG = bool(PG_URL)
ON_SERVERLESS = bool(os.getenv("VERCEL"))
SQLITE_PATH = Path(os.getenv("RISKSHEET_DB", Path(__file__).resolve().parent.parent / "data" / "risksheet.db"))

_lock = threading.RLock()
_conn = None
_schema_ready = False

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        market TEXT NOT NULL DEFAULT 'us',
        ticker TEXT NOT NULL,
        shares DOUBLE PRECISION NOT NULL,
        price_bought DOUBLE PRECISION NOT NULL,
        date_bought TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sector_targets (
        market TEXT NOT NULL,
        sector TEXT NOT NULL,
        allocation DOUBLE PRECISION NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (market, sector)
    )""",
    """CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS ticker_meta (
        ticker TEXT PRIMARY KEY,
        sector TEXT,
        market_cap DOUBLE PRECISION,
        name TEXT,
        updated_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS metrics_cache (
        position_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS value_points (
        market TEXT NOT NULL,
        day TEXT NOT NULL,
        invested DOUBLE PRECISION NOT NULL,
        cash DOUBLE PRECISION NOT NULL,
        total DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (market, day)
    )""",
    # Index levels entered or imported by the user (used for markets with no automatic index feed).
    """CREATE TABLE IF NOT EXISTS index_history (
        market TEXT NOT NULL,
        day TEXT NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (market, day)
    )""",
]


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def describe() -> Dict[str, Any]:
    return {
        "engine": "postgres" if IS_PG else "sqlite",
        "configured": IS_PG or not ON_SERVERLESS,
        "durable": IS_PG or not ON_SERVERLESS,
    }


def _connect():
    if IS_PG:
        import psycopg2

        conn = psycopg2.connect(PG_URL, connect_timeout=10)
        conn.autocommit = True
        return conn
    if ON_SERVERLESS:
        raise RuntimeError(
            "No database is configured. Set DATABASE_URL to a PostgreSQL connection string. "
            "Refusing to fall back to temporary storage, which would lose data."
        )
    SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(SQLITE_PATH), check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def _is_connection_error(exc: Exception) -> bool:
    if not IS_PG:
        return False
    import psycopg2

    return isinstance(exc, (psycopg2.OperationalError, psycopg2.InterfaceError))


def _execute(sql: str, params: tuple) -> List[Dict[str, Any]]:
    global _conn
    if _conn is None:
        _conn = _connect()
    cur = _conn.cursor()
    try:
        cur.execute(sql.replace("?", "%s") if IS_PG else sql, params)
        if cur.description:
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        return []
    finally:
        cur.close()


def run(sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
    """Run one statement. Reconnects once if a pooled connection has gone stale."""
    global _conn, _schema_ready
    with _lock:
        for attempt in (0, 1):
            try:
                if not _schema_ready:
                    for stmt in SCHEMA:
                        _execute(stmt, ())
                    _schema_ready = True
                return _execute(sql, params)
            except Exception as exc:
                if attempt == 0 and _is_connection_error(exc):
                    try:
                        _conn.close()
                    except Exception:
                        pass
                    _conn = None
                    continue
                raise
    return []


# ---------- activity log ----------

def log(action: str, detail: Dict[str, Any]) -> None:
    run(
        "INSERT INTO activity_log (id, at, action, detail) VALUES (?, ?, ?, ?)",
        (uuid.uuid4().hex, now(), action, json.dumps(detail, default=str)),
    )


def list_activity(limit: int = 200) -> List[Dict[str, Any]]:
    rows = run("SELECT id, at, action, detail FROM activity_log ORDER BY at DESC, id DESC LIMIT ?", (limit,))
    for r in rows:
        try:
            r["detail"] = json.loads(r["detail"])
        except Exception:
            r["detail"] = {}
    return rows


# ---------- positions ----------

POS_COLS = "id, market, ticker, shares, price_bought, date_bought, created_at, updated_at, deleted_at"


def list_positions(market: Optional[str] = None, deleted: bool = False) -> List[Dict[str, Any]]:
    where = "deleted_at IS NOT NULL" if deleted else "deleted_at IS NULL"
    order = "deleted_at DESC" if deleted else "created_at ASC, id ASC"
    if market:
        return run(f"SELECT {POS_COLS} FROM positions WHERE {where} AND market = ? ORDER BY {order}", (market,))
    return run(f"SELECT {POS_COLS} FROM positions WHERE {where} ORDER BY {order}")


def get_position(pid: str) -> Optional[Dict[str, Any]]:
    rows = run(f"SELECT {POS_COLS} FROM positions WHERE id = ?", (pid,))
    return rows[0] if rows else None


def create_position(market: str, ticker: str, shares: float, price_bought: float, date_bought: Optional[str]) -> Dict[str, Any]:
    pid = uuid.uuid4().hex
    # Microsecond precision keeps positions in the order they were entered.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    run(
        "INSERT INTO positions (id, market, ticker, shares, price_bought, date_bought, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (pid, market, ticker, shares, price_bought, date_bought, ts, ts),
    )
    pos = get_position(pid)
    log("position_added", pos)
    return pos


def update_position(pid: str, ticker: str, shares: float, price_bought: float, date_bought: Optional[str]) -> Optional[Dict[str, Any]]:
    before = get_position(pid)
    if not before:
        return None
    run(
        "UPDATE positions SET ticker = ?, shares = ?, price_bought = ?, date_bought = ?, updated_at = ? WHERE id = ?",
        (ticker, shares, price_bought, date_bought, now(), pid),
    )
    after = get_position(pid)
    log("position_edited", {"before": before, "after": after})
    return after


def soft_delete_position(pid: str) -> Optional[Dict[str, Any]]:
    pos = get_position(pid)
    if not pos:
        return None
    ts = now()
    run("UPDATE positions SET deleted_at = ?, updated_at = ? WHERE id = ?", (ts, ts, pid))
    log("position_removed", pos)
    return get_position(pid)


def restore_position(pid: str) -> Optional[Dict[str, Any]]:
    pos = get_position(pid)
    if not pos:
        return None
    run("UPDATE positions SET deleted_at = NULL, updated_at = ? WHERE id = ?", (now(), pid))
    log("position_restored", pos)
    return get_position(pid)


# ---------- settings / cash ----------

def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    rows = run("SELECT value FROM settings WHERE key = ?", (key,))
    return rows[0]["value"] if rows else default


def get_setting_row(key: str) -> Optional[Dict[str, Any]]:
    rows = run("SELECT value, updated_at FROM settings WHERE key = ?", (key,))
    return rows[0] if rows else None


def set_setting(key: str, value: str) -> None:
    run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, now()),
    )


def get_cash(market: str) -> float:
    try:
        return float(get_setting(f"cash:{market}", "0") or 0)
    except ValueError:
        return 0.0


def set_cash(market: str, amount: float) -> float:
    before = get_cash(market)
    set_setting(f"cash:{market}", repr(float(amount)))
    log("cash_changed", {"market": market, "before": before, "after": amount})
    return amount


# ---------- sector targets ----------

def get_allocations(market: str) -> Dict[str, float]:
    rows = run("SELECT sector, allocation FROM sector_targets WHERE market = ?", (market,))
    return {r["sector"]: float(r["allocation"]) for r in rows}


def set_allocation(market: str, sector: str, allocation: float) -> None:
    before = get_allocations(market).get(sector, 0.0)
    run(
        "INSERT INTO sector_targets (market, sector, allocation, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (market, sector) DO UPDATE SET allocation = excluded.allocation, updated_at = excluded.updated_at",
        (market, sector, allocation, now()),
    )
    log("target_changed", {"market": market, "sector": sector, "before": before, "after": allocation})


# ---------- index levels supplied by the user ----------

def upsert_index_points(market: str, points: List[Dict[str, Any]]) -> int:
    for i in range(0, len(points), 400):
        chunk = points[i:i + 400]
        marks = ",".join("(?, ?, ?)" for _ in chunk)
        params: list = []
        for pt in chunk:
            params += [market, pt["day"], float(pt["close"])]
        run(f"INSERT INTO index_history (market, day, close) VALUES {marks} "
            "ON CONFLICT (market, day) DO UPDATE SET close = excluded.close", tuple(params))
    if points:
        days = sorted(pt["day"] for pt in points)
        log("index_imported", {"market": market, "count": len(points), "from": days[0], "to": days[-1]})
    return len(points)


def list_index_history(market: str) -> List[Dict[str, Any]]:
    return run("SELECT day, close FROM index_history WHERE market = ? ORDER BY day ASC", (market,))


# ---------- market-data caches (safe to lose, kept so the app works when the feed is down) ----------

def get_meta(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    if not tickers:
        return {}
    marks = ",".join("?" for _ in tickers)
    rows = run(f"SELECT ticker, sector, market_cap, name, updated_at FROM ticker_meta WHERE ticker IN ({marks})", tuple(tickers))
    return {r["ticker"]: r for r in rows}


def set_meta(ticker: str, sector: Optional[str], market_cap: Optional[float], name: Optional[str]) -> None:
    run(
        "INSERT INTO ticker_meta (ticker, sector, market_cap, name, updated_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT (ticker) DO UPDATE SET sector = excluded.sector, market_cap = excluded.market_cap, "
        "name = excluded.name, updated_at = excluded.updated_at",
        (ticker, sector, market_cap, name, now()),
    )


def get_metrics() -> Dict[str, Dict[str, Any]]:
    out = {}
    for r in run("SELECT position_id, data, updated_at FROM metrics_cache"):
        try:
            out[r["position_id"]] = {"data": json.loads(r["data"]), "updated_at": r["updated_at"]}
        except Exception:
            pass
    return out


def set_metrics(position_id: str, data: Dict[str, Any]) -> None:
    run(
        "INSERT INTO metrics_cache (position_id, data, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT (position_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        (position_id, json.dumps(data), now()),
    )


def record_value(market: str, day: str, invested: float, cash: float) -> None:
    run(
        "INSERT INTO value_points (market, day, invested, cash, total) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT (market, day) DO UPDATE SET invested = excluded.invested, cash = excluded.cash, total = excluded.total",
        (market, day, invested, cash, invested + cash),
    )


def list_value_history(market: str) -> List[Dict[str, Any]]:
    return run("SELECT day, invested, cash, total FROM value_points WHERE market = ? ORDER BY day ASC", (market,))
