"""
Market data + risk calculations.

Same measures as the original RiskSheet: 14-day ATR (entry and current), ATR-based
take-profit / stop-loss, beta vs SPY, CAPM expected return, Monte Carlo VaR (95%),
a Black-Scholes volatility estimate, weights, market-cap tier and sector.
"""
import json
import math
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import yfinance as yf

from backend import db

RISK_FREE_RATE = 0.0488
MARKET_PROXY = "SPY"
ATR_WINDOW = 14
VAR_SIMULATIONS = 5000
VAR_CONFIDENCE = 0.95
IV_TENOR_DAYS = 30
MIN_HISTORY_YEARS = 5
MISSING_TTL = 600          # seconds before an unknown symbol is tried again
PRICE_TTL = 300            # seconds
META_TTL = 7 * 24 * 3600   # seconds

SECTOR_NAMES = {
    "realestate": "Real Estate",
    "consumer_cyclical": "Consumer Cyclical",
    "basic_materials": "Basic Materials",
    "consumer_defensive": "Consumer Defensive",
    "technology": "Technology",
    "communication_services": "Communication Services",
    "financial_services": "Financial Services",
    "utilities": "Utilities",
    "industrials": "Industrials",
    "energy": "Energy",
    "healthcare": "Healthcare",
}

_HIST: Dict[str, tuple] = {}
_MISSING: Dict[str, float] = {}


def _clean(value):
    """Make a value JSON-safe (no NaN / inf / numpy scalars)."""
    if value is None:
        return None
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return value if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def _age_seconds(iso: Optional[str]) -> float:
    if not iso:
        return float("inf")
    try:
        then = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - then).total_seconds()
    except ValueError:
        return float("inf")


# ---------- data fetch ----------

def _history(tickers: List[str], start: str) -> Dict[str, pd.DataFrame]:
    """Daily bars from `start` for each ticker, fetched in one batch and cached in memory."""
    now = time.time()

    def fresh(t):
        hit = _HIST.get(t)
        return hit and now - hit[0] < PRICE_TTL and hit[2] <= start

    need = [t for t in tickers if not fresh(t) and now - _MISSING.get(t, 0) > MISSING_TTL]
    if need:
        try:
            data = yf.download(need, start=start, auto_adjust=True, group_by="ticker",
                               threads=True, progress=False)
        except Exception as exc:
            print(f"price download failed: {exc}")
            data = None
        for t in need:
            df = None
            try:
                if data is not None and not data.empty:
                    df = data[t] if isinstance(data.columns, pd.MultiIndex) else data
                    df = df.dropna(subset=["Close"])
                    if getattr(df.index, "tz", None) is not None:
                        df.index = df.index.tz_localize(None)
            except Exception:
                df = None
            if df is not None and not df.empty:
                _HIST[t] = (now, df, start)
            elif data is not None and not data.empty:
                _MISSING[t] = now  # the feed answered, but not for this symbol
    # A stale cached series is better than nothing when the feed is failing.
    return {t: _HIST[t][1] for t in tickers if t in _HIST}


def _fetch_info(ticker: str) -> Optional[Dict[str, Any]]:
    try:
        info = yf.Ticker(ticker).info or {}
        if not info.get("sector") and not info.get("marketCap"):
            return None
        return {"sector": info.get("sector"), "market_cap": info.get("marketCap"),
                "name": info.get("shortName") or info.get("longName")}
    except Exception as exc:
        print(f"info fetch failed for {ticker}: {exc}")
        return None


def _meta(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    cached = db.get_meta(tickers)
    now = time.time()
    stale = [t for t in tickers
             if (t not in cached or _age_seconds(cached[t].get("updated_at")) > META_TTL)
             and now - _MISSING.get(t, 0) > MISSING_TTL]
    if stale:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for t, info in zip(stale, pool.map(_fetch_info, stale)):
                if info:
                    db.set_meta(t, info["sector"], info["market_cap"], info["name"])
                    cached[t] = info
    return cached


def _market_sector_weights() -> Dict[str, float]:
    row = db.get_setting_row("market_sector_weights")
    if row and _age_seconds(row["updated_at"]) < META_TTL:
        try:
            return json.loads(row["value"])
        except Exception:
            pass
    weights: Dict[str, float] = {}
    try:
        raw = yf.Ticker(MARKET_PROXY).funds_data.sector_weightings or {}
        for key, val in raw.items():
            name = SECTOR_NAMES.get(str(key).lower().replace(" ", "_"), str(key))
            weights[name] = float(val)
    except Exception as exc:
        print(f"sector weights fetch failed: {exc}")
    if weights:
        db.set_setting("market_sector_weights", json.dumps(weights))
        return weights
    if row:
        try:
            return json.loads(row["value"])
        except Exception:
            pass
    return {}


# ---------- maths ----------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


def _bs_call(s: float, k: float, r: float, sigma: float, t: float) -> float:
    if s <= 0 or k <= 0 or sigma <= 0 or t <= 0:
        return 0.0
    d1 = (math.log(s / k) + (r + 0.5 * sigma ** 2) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    return s * _norm_cdf(d1) - k * math.exp(-r * t) * _norm_cdf(d2)


def _implied_vol(spot: float, returns: np.ndarray) -> Optional[float]:
    if spot <= 0 or returns.size < 5:
        return None
    guess = float(np.std(returns) * math.sqrt(252))
    if guess <= 0:
        return None
    t = IV_TENOR_DAYS / 365.0
    target = _bs_call(spot, spot, RISK_FREE_RATE, guess, t)
    if target <= 0:
        return None
    sigma = guess
    for _ in range(8):
        price = _bs_call(spot, spot, RISK_FREE_RATE, sigma, t)
        if price <= 0:
            break
        d1 = ((RISK_FREE_RATE + 0.5 * sigma ** 2) * t) / (sigma * math.sqrt(t))
        vega = spot * math.sqrt(t) * (1 / math.sqrt(2 * math.pi)) * math.exp(-0.5 * d1 ** 2)
        if vega <= 1e-8:
            break
        sigma -= (price - target) / vega
        if sigma <= 0:
            sigma = guess
            break
    return max(round(sigma, 4), 0.0)


def _atr_series(history: pd.DataFrame) -> pd.Series:
    prev = history["Close"].shift(1)
    tr = pd.concat([history["High"] - history["Low"],
                    (history["High"] - prev).abs(),
                    (history["Low"] - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(window=ATR_WINDOW).mean()


def _log_returns(history: pd.DataFrame) -> pd.Series:
    closes = history["Close"]
    return np.log(closes / closes.shift(1)).dropna()


def _beta(stock: pd.Series, market: pd.Series) -> Optional[float]:
    both = pd.concat([stock, market], axis=1, join="inner").dropna()
    if len(both) < 20:
        return None
    variance = both.iloc[:, 1].var()
    if not variance:
        return None
    return round(float(both.iloc[:, 0].cov(both.iloc[:, 1]) / variance), 4)


def _var(ticker: str, position_value: float, returns: np.ndarray) -> Optional[float]:
    if returns.size < 2:
        return None
    # Seeded per ticker so the figure doesn't jitter between refreshes.
    rng = np.random.default_rng(zlib.crc32(ticker.encode()))
    sims = np.sort(rng.normal(np.mean(returns), np.std(returns), VAR_SIMULATIONS))
    return round(abs(position_value * float(sims[int((1 - VAR_CONFIDENCE) * VAR_SIMULATIONS)])), 2)


def _cap_label(val: Optional[float]) -> Optional[str]:
    if not val:
        return None
    for limit, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if val >= limit:
            return f"{val / limit:.2f}{suffix}"
    return f"{val:.2f}"


def _cap_tier(val: Optional[float]) -> Optional[str]:
    if not val:
        return None
    if val >= 100e9:
        return "Mega Cap"
    if val >= 10e9:
        return "Large Cap"
    if val >= 2e9:
        return "Mid Cap"
    if val >= 500e6:
        return "Small Cap"
    return "Micro Cap"


def _row(pos: Dict[str, Any], history: pd.DataFrame, meta: Dict[str, Any],
         market_returns: Optional[pd.Series]) -> Dict[str, Any]:
    ticker = pos["ticker"]
    shares = float(pos["shares"])
    price_bought = float(pos["price_bought"])
    closes = history["Close"]
    current_price = round(float(closes.iloc[-1]), 4)
    returns = _log_returns(history)
    position_value = round(current_price * shares, 2)

    atr = _atr_series(history)
    current_atr = round(float(atr.iloc[-1]), 4) if not np.isnan(atr.iloc[-1]) else None

    # Purchase date: what the user entered, otherwise the most recent day the price traded there.
    date_bought = pos.get("date_bought") or None
    date_inferred = False
    if not date_bought and price_bought > 0:
        hits = history[(history["Low"] <= price_bought) & (history["High"] >= price_bought)]
        if not hits.empty:
            date_bought = hits.index[-1].strftime("%Y-%m-%d")
            date_inferred = True

    entry_atr = None
    holding_period = None
    if date_bought:
        try:
            dt = datetime.strptime(date_bought, "%Y-%m-%d")
            holding_period = max((datetime.now() - dt).days, 0)
            idx = history.index.get_indexer([dt], method="pad")[0]
            if idx != -1 and not np.isnan(atr.iloc[idx]):
                entry_atr = round(float(atr.iloc[idx]), 4)
        except Exception:
            pass

    beta = _beta(returns, market_returns) if market_returns is not None else None
    expected_return = None
    if beta is not None and market_returns is not None and len(market_returns):
        annual_market = float(market_returns.mean()) * 252
        expected_return = round(RISK_FREE_RATE + beta * (annual_market - RISK_FREE_RATE), 6)

    market_cap = meta.get("market_cap")
    return {
        "id": pos["id"],
        "ticker": ticker,
        "name": meta.get("name"),
        "shares": shares,
        "price_bought": price_bought,
        "date_bought": date_bought,
        "date_inferred": date_inferred,
        "sector": meta.get("sector") or "Unknown",
        "value_paid": round(price_bought * shares, 2),
        "current_price": current_price,
        "position_value": position_value,
        "pct_change": round((current_price - price_bought) / price_bought, 4) if price_bought > 0 else None,
        "atr": current_atr,
        "entry_atr": entry_atr,
        "atr_change": round(current_atr - entry_atr, 4) if current_atr is not None and entry_atr is not None else None,
        "no_atrs": round((current_price - price_bought) / entry_atr, 4) if entry_atr else None,
        "take_profit": round(price_bought + 2 * entry_atr, 2) if entry_atr else None,
        "stop_loss": round(price_bought - 2 * entry_atr, 2) if entry_atr else None,
        "current_tp": round(current_price + 2 * current_atr, 2) if current_atr else None,
        "current_sl": round(current_price - 2 * current_atr, 2) if current_atr else None,
        "beta": beta,
        "expected_return": expected_return,
        "var": _var(ticker, position_value, returns.to_numpy()),
        "iv": _implied_vol(current_price, returns.to_numpy()),
        "holding_period": holding_period,
        "market_cap": market_cap,
        "cap_formatted": _cap_label(market_cap),
        "cap_tier": _cap_tier(market_cap),
        "price_date": history.index[-1].strftime("%Y-%m-%d"),
        "stale": False,
        "error": None,
    }


def compute(positions: List[Dict[str, Any]], cash: float) -> Dict[str, Any]:
    tickers = sorted({p["ticker"] for p in positions})
    histories: Dict[str, pd.DataFrame] = {}
    meta: Dict[str, Dict[str, Any]] = {}
    sector_weights: Dict[str, float] = {}
    if tickers:
        # Go back far enough to cover the oldest purchase, and at least five years for beta / VaR.
        floor = datetime.now() - timedelta(days=365 * MIN_HISTORY_YEARS)
        dates = [floor]
        for p in positions:
            try:
                dates.append(datetime.strptime(p["date_bought"], "%Y-%m-%d") - timedelta(days=90))
            except (TypeError, ValueError):
                pass
        start = min(dates).strftime("%Y-%m-01")
        with ThreadPoolExecutor(max_workers=3) as pool:
            f_hist = pool.submit(_history, tickers + [MARKET_PROXY], start)
            f_weights = pool.submit(_market_sector_weights)
            histories = f_hist.result()
            sector_weights = f_weights.result()
        meta = _meta([t for t in tickers if t in histories])
    market_hist = histories.get(MARKET_PROXY)
    market_returns = _log_returns(market_hist) if market_hist is not None else None
    saved = db.get_metrics() if positions else {}

    rows: List[Dict[str, Any]] = []
    for pos in positions:
        hist = histories.get(pos["ticker"])
        row = None
        if hist is not None and not hist.empty:
            try:
                row = _row(pos, hist, meta.get(pos["ticker"], {}), market_returns)
                db.set_metrics(pos["id"], row)
            except Exception as exc:
                print(f"calc failed for {pos['ticker']}: {exc}")
        if row is None:
            # Feed unavailable: fall back to the last figures we computed for this position.
            last = saved.get(pos["id"])
            same = last and last["data"].get("ticker") == pos["ticker"]
            if same:
                row = dict(last["data"])
                row.update({"shares": float(pos["shares"]), "price_bought": float(pos["price_bought"]),
                            "stale": True, "error": None})
                row["position_value"] = round((row.get("current_price") or 0) * row["shares"], 2)
                row["value_paid"] = round(row["price_bought"] * row["shares"], 2)
            else:
                row = {"id": pos["id"], "ticker": pos["ticker"], "shares": float(pos["shares"]),
                       "price_bought": float(pos["price_bought"]), "date_bought": pos.get("date_bought"),
                       "value_paid": round(float(pos["price_bought"]) * float(pos["shares"]), 2),
                       "sector": None, "position_value": None, "stale": False,
                       "error": "No market data found for this ticker"}
        rows.append(row)

    invested = sum(r.get("position_value") or 0 for r in rows)
    for r in rows:
        value = r.get("position_value")
        r["weight"] = round(value / invested, 4) if invested and value is not None else None
        r["beta_weighted"] = round(r["beta"] * r["weight"], 6) if r.get("beta") is not None and r["weight"] is not None else None
        r["weighted_expected_return"] = (round(r["expected_return"] * r["weight"], 6)
                                         if r.get("expected_return") is not None and r["weight"] is not None else None)

    priced = [r for r in rows if r.get("position_value") is not None]
    cost = sum(r.get("value_paid") or 0 for r in priced)
    totals = {
        "cash": cash,
        "invested": round(invested, 2),
        "total": round(invested + cash, 2),
        "cost": round(cost, 2),
        "pnl": round(invested - cost, 2),
        "pnl_pct": round((invested - cost) / cost, 4) if cost else None,
        "beta": round(sum(r.get("beta_weighted") or 0 for r in rows), 4) if priced else None,
        "expected_return": round(sum(r.get("weighted_expected_return") or 0 for r in rows), 6) if priced else None,
        "var": round(sum(r.get("var") or 0 for r in rows), 2) if priced else None,
        "positions": len(rows),
    }

    if priced and not any(r.get("stale") for r in rows):
        db.record_value(datetime.now(timezone.utc).strftime("%Y-%m-%d"), invested, cash)

    clean_rows = [{k: _clean(v) for k, v in r.items()} for r in rows]
    return {
        "rows": clean_rows,
        "totals": {k: _clean(v) for k, v in totals.items()},
        "market_sector_weights": sector_weights,
        "value_history": db.list_value_history(),
        "as_of": db.now(),
        "risk_free_rate": RISK_FREE_RATE,
        "feed_ok": bool(not tickers or market_hist is not None),
    }
