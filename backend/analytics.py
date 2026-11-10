"""
Market data + risk calculations for both markets (United States and Bahrain).

Same measures as the original RiskSheet: 14-day ATR (entry and current), ATR-based
take-profit / stop-loss, beta, CAPM expected return, Monte Carlo VaR (95%), a
Black-Scholes volatility estimate, weights, market-cap tier and sector. Added: a
performance series comparing the portfolio with the market benchmark.
"""
import json
import math
import re
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import yfinance as yf

from backend import db
from backend.currencies import quote_currency, quote_to_base, BH_USD_SYMBOLS, USD_BHD

RISK_FREE_RATE = 0.0488
SECTOR_WEIGHTS_FUND = "SPY"   # S&P 500 sector mix, shown on the US sector page
ATR_WINDOW = 14
VAR_SIMULATIONS = 5000
VAR_CONFIDENCE = 0.95
IV_TENOR_DAYS = 30
MIN_HISTORY_YEARS = 5
PRICE_TTL = 300            # seconds
META_TTL = 7 * 24 * 3600   # seconds
MISSING_TTL = 600          # seconds before an unknown symbol is tried again
MAX_CHART_POINTS = 400

US_BENCHMARKS = {
    "^GSPC": "S&P 500",
    "^NDX": "Nasdaq 100",
    "^IXIC": "Nasdaq Composite",
    "^DJI": "Dow Jones Industrial Average",
    "^RUT": "Russell 2000",
}
US_SECTORS = ["Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy",
              "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities"]
BH_SECTORS = ["Communication Services", "Consumer Discretionary", "Consumer Staples", "Financials",
              "Industrials", "Materials", "Real Estate"]

MARKETS = {
    "us": {"name": "United States", "currency": "USD", "decimals": 2, "sectors": US_SECTORS, "suffix": ""},
    "bh": {"name": "Bahrain", "currency": "BHD", "decimals": 3, "sectors": BH_SECTORS, "suffix": ".BH"},
}
BH_INDEX_NAME = "Bahrain All Share Index"
BH_ESTIMATE_NAME = "Bahrain market estimate"
# Bahrain Bourse listings with free daily price history. With no free feed for the official
# index, the actively traded ones are averaged into a market estimate (see _bh_market_estimate).
BH_MARKET_BASKET = ["ALBH", "NBB", "BBK", "SALAM", "BISB", "GFH", "ABC", "ITHMR", "ESTERAD", "INOVEST", "BCFC",
                    "BKIC", "SOLID", "ARIG", "BNH", "ZAINBH", "SEEF", "BASREC", "BMMI", "DUTYF", "GHG", "CINECO"]
BH_ACTIVE_SHARE = 0.20     # a stock counts as actively traded if its price moved on this share of days
BH_MAX_DAILY_MOVE = 0.15   # larger one-day moves are treated as data errors (the Bourse limit is 10%)

# The price feed has no company details for Bahrain Bourse listings, so names and sectors
# for the main listings are kept here. Anything not listed shows as "Unknown".
BH_COMPANIES = {
    "ALBH": ("Aluminium Bahrain (Alba)", "Materials"),
    "NBB": ("National Bank of Bahrain", "Financials"),
    "BBK": ("BBK", "Financials"),
    "SALAM": ("Al Salam Bank", "Financials"),
    "BISB": ("Bahrain Islamic Bank", "Financials"),
    "KHCB": ("Khaleeji Bank", "Financials"),
    "GFH": ("GFH Financial Group", "Financials"),
    "ABC": ("Bank ABC", "Financials"),
    "ITHMR": ("Ithmaar Holding", "Financials"),
    "BARKA": ("Al Baraka Group", "Financials"),
    "ESTERAD": ("Esterad Investment Company", "Financials"),
    "INOVEST": ("Inovest", "Financials"),
    "BCFC": ("Bahrain Commercial Facilities Company", "Financials"),
    "BKIC": ("Bahrain Kuwait Insurance Company", "Financials"),
    "SOLID": ("Solidarity Bahrain", "Financials"),
    "ARIG": ("Arab Insurance Group", "Financials"),
    "BNH": ("Bahrain National Holding", "Financials"),
    "TAKAFUL": ("Takaful International", "Financials"),
    "UGH": ("United Gulf Holding", "Financials"),
    "BEYON": ("Beyon", "Communication Services"),
    "BATELCO": ("Batelco", "Communication Services"),
    "ZAINBH": ("Zain Bahrain", "Communication Services"),
    "SEEF": ("Seef Properties", "Real Estate"),
    "APMTB": ("APM Terminals Bahrain", "Industrials"),
    "NASS": ("Nass Corporation", "Industrials"),
    "BASREC": ("Bahrain Ship Repairing and Engineering", "Industrials"),
    "BMMI": ("BMMI", "Consumer Staples"),
    "TRAFCO": ("Trafco Group", "Consumer Staples"),
    "POLTRY": ("Delmon Poultry", "Consumer Staples"),
    "BFM": ("Bahrain Flour Mills", "Consumer Staples"),
    "DUTYF": ("Bahrain Duty Free", "Consumer Discretionary"),
    "GHG": ("Gulf Hotels Group", "Consumer Discretionary"),
    "CINECO": ("Bahrain Cinema Company", "Consumer Discretionary"),
}

SECTOR_NAMES = {
    "realestate": "Real Estate", "consumer_cyclical": "Consumer Cyclical", "basic_materials": "Basic Materials",
    "consumer_defensive": "Consumer Defensive", "technology": "Technology",
    "communication_services": "Communication Services", "financial_services": "Financial Services",
    "utilities": "Utilities", "industrials": "Industrials", "energy": "Energy", "healthcare": "Healthcare",
}
BENCHMARK_RE = re.compile(r"^[A-Z0-9.\-^=]{1,12}$")

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


def feed_symbol(market: str, ticker: str) -> str:
    suffix = MARKETS[market]["suffix"]
    return ticker if not suffix or "." in ticker else ticker + suffix


# ---------- benchmark ----------

def get_benchmark(market: str) -> Dict[str, Any]:
    if market == "bh":
        if len(db.list_index_history(market)) >= 2:
            return {"symbol": None, "name": BH_INDEX_NAME, "source": "import"}
        return {"symbol": None, "name": BH_ESTIMATE_NAME, "source": "estimate"}
    symbol = db.get_setting("benchmark:us", "^GSPC") or "^GSPC"
    return {"symbol": symbol, "name": US_BENCHMARKS.get(symbol, symbol), "source": "feed"}


def set_benchmark(symbol: str) -> Dict[str, Any]:
    symbol = (symbol or "").strip().upper()
    if not BENCHMARK_RE.match(symbol):
        raise ValueError("Enter a valid index or fund symbol, for example ^GSPC or QQQ")
    if symbol not in US_BENCHMARKS:
        start = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")
        if symbol not in _history([symbol], start):
            raise ValueError(f"No market data was found for {symbol}")
    before = db.get_setting("benchmark:us", "^GSPC")
    db.set_setting("benchmark:us", symbol)
    db.log("benchmark_changed", {"market": "us", "before": before, "after": symbol})
    return get_benchmark("us")


def market_config(market: str) -> Dict[str, Any]:
    cfg = {k: v for k, v in MARKETS[market].items() if k != "suffix"}
    cfg["market"] = market
    cfg["benchmark"] = get_benchmark(market)
    cfg["usd_quote_symbols"] = sorted(BH_USD_SYMBOLS) if market == "bh" else []
    cfg["usd_to_bhd"] = USD_BHD
    if market == "us":
        cfg["benchmark_options"] = [{"symbol": s, "name": n} for s, n in US_BENCHMARKS.items()]
    else:
        pts = db.list_index_history(market)
        cfg["index_points"] = len(pts)
        cfg["index_from"] = pts[0]["day"] if pts else None
        cfg["index_to"] = pts[-1]["day"] if pts else None
    return cfg


# ---------- data fetch ----------

def _history(symbols: List[str], start: str) -> Dict[str, pd.DataFrame]:
    """Daily bars from `start` for each symbol, fetched in one batch and cached in memory."""
    now = time.time()

    def fresh(t):
        hit = _HIST.get(t)
        return hit and now - hit[0] < PRICE_TTL and hit[2] <= start

    need = [t for t in symbols if not fresh(t) and now - _MISSING.get(t, 0) > MISSING_TTL]
    if need:
        try:
            data = yf.download(need, start=start, auto_adjust=False, group_by="ticker",
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
    return {t: _HIST[t][1] for t in symbols if t in _HIST}


def _fetch_info(symbol: str) -> Optional[Dict[str, Any]]:
    try:
        info = yf.Ticker(symbol).info or {}
        if not info.get("sector") and not info.get("marketCap"):
            return None
        return {"sector": info.get("sector"), "market_cap": info.get("marketCap"),
                "name": info.get("shortName") or info.get("longName")}
    except Exception as exc:
        print(f"info fetch failed for {symbol}: {exc}")
        return None


def _meta_us(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
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


def _meta_bh(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    out = {}
    for t in tickers:
        name, sector = BH_COMPANIES.get(t.split(".")[0], (None, None))
        out[t] = {"name": name, "sector": sector, "market_cap": None}
    return out


def _market_sector_weights() -> Dict[str, float]:
    row = db.get_setting_row("market_sector_weights")
    if row and _age_seconds(row["updated_at"]) < META_TTL:
        try:
            return json.loads(row["value"])
        except Exception:
            pass
    weights: Dict[str, float] = {}
    try:
        raw = yf.Ticker(SECTOR_WEIGHTS_FUND).funds_data.sector_weightings or {}
        for key, val in raw.items():
            weights[SECTOR_NAMES.get(str(key).lower().replace(" ", "_"), str(key))] = float(val)
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


def _imported_index(market: str) -> Optional[pd.Series]:
    pts = db.list_index_history(market)
    if len(pts) < 2:
        return None
    return pd.Series([float(p["close"]) for p in pts], index=pd.to_datetime([p["day"] for p in pts])).sort_index()


def _bh_market_estimate(histories: Dict[str, pd.DataFrame]) -> tuple:
    """
    Stand-in for the Bahrain All Share Index, which has no free data feed: the average daily
    move of the actively traded Bahrain Bourse stocks, chained into an index starting at 1000.
    It is equal-weighted (the official index is weighted by company size) and uses
    price returns, so it will not match the official index level or performance.
    """
    closes = {t: histories[t + ".BH"]["Close"] for t in BH_MARKET_BASKET if t + ".BH" in histories}
    if len(closes) < 3:
        return None, 0
    moves = pd.DataFrame(closes).sort_index().pct_change(fill_method=None)
    moves = moves.where(moves.abs() <= BH_MAX_DAILY_MOVE)
    active = [c for c in moves.columns if ((moves[c] != 0) & moves[c].notna()).mean() >= BH_ACTIVE_SHARE]
    if len(active) < 5:
        active = list(moves.columns)
    level = (1 + moves[active].mean(axis=1, skipna=True).fillna(0)).cumprod() * 1000
    return level, len(active)


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


def _log_returns(closes: pd.Series) -> pd.Series:
    r = np.log(closes / closes.shift(1))
    return r.replace([np.inf, -np.inf], np.nan).dropna()


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


def _parse_day(value: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.strptime(value, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _row(pos: Dict[str, Any], history: pd.DataFrame, meta: Dict[str, Any],
         market_returns: Optional[pd.Series], decimals: int, market: str = "us") -> Dict[str, Any]:
    ticker = pos["ticker"]
    shares = float(pos["shares"])
    price_bought = float(pos["price_bought"])
    closes = history["Close"]
    current_price = round(float(closes.iloc[-1]), 4)
    returns = _log_returns(closes)
    fx = quote_to_base(market, ticker)
    position_value = round(current_price * shares * fx, decimals)

    atr = _atr_series(history)
    current_atr = round(float(atr.iloc[-1]), 4) if not np.isnan(atr.iloc[-1]) else None

    # Purchase date: what the user entered. Older rows saved without one fall back to the
    # most recent day the price traded there.
    date_bought = pos.get("date_bought") or None
    date_inferred = False
    if not date_bought and price_bought > 0:
        hits = history[(history["Low"] <= price_bought) & (history["High"] >= price_bought)]
        if not hits.empty:
            date_bought = hits.index[-1].strftime("%Y-%m-%d")
            date_inferred = True

    entry_atr = None
    holding_period = None
    dt = _parse_day(date_bought)
    if dt:
        holding_period = max((datetime.now() - dt).days, 0)
        idx = history.index.get_indexer([dt], method="pad")[0]
        if idx != -1 and not np.isnan(atr.iloc[idx]):
            entry_atr = round(float(atr.iloc[idx]), 4)

    beta = _beta(returns, market_returns) if market_returns is not None else None
    expected_return = None
    if beta is not None and market_returns is not None and len(market_returns):
        annual_market = float(market_returns.mean()) * 252
        expected_return = round(RISK_FREE_RATE + beta * (annual_market - RISK_FREE_RATE), 6)

    market_cap = meta.get("market_cap")
    traded = history.loc[history["Volume"] > 0] if "Volume" in history else history
    last_trade_date = traded.index[-1].strftime("%Y-%m-%d") if not traded.empty else None
    px = max(decimals, 2)
    return {
        "id": pos["id"],
        "ticker": ticker,
        "name": meta.get("name"),
        "shares": shares,
        "price_bought": price_bought,
        "date_bought": date_bought,
        "date_inferred": date_inferred,
        "sector": meta.get("sector") or "Unknown",
        "value_paid": round(price_bought * shares * fx, decimals),
        "quote_currency": quote_currency(market, ticker),
        "quote_to_base": fx,
        "current_price": current_price,
        "position_value": position_value,
        "pct_change": round((current_price - price_bought) / price_bought, 4) if price_bought > 0 else None,
        "atr": current_atr,
        "entry_atr": entry_atr,
        "atr_change": round(current_atr - entry_atr, 4) if current_atr is not None and entry_atr is not None else None,
        "no_atrs": round((current_price - price_bought) / entry_atr, 4) if entry_atr else None,
        "take_profit": round(price_bought + 2 * entry_atr, px) if entry_atr else None,
        "stop_loss": round(price_bought - 2 * entry_atr, px) if entry_atr else None,
        "current_tp": round(current_price + 2 * current_atr, px) if current_atr else None,
        "current_sl": round(current_price - 2 * current_atr, px) if current_atr else None,
        "beta": beta,
        "expected_return": expected_return,
        "var": _var(ticker, position_value, returns.to_numpy()),
        "iv": _implied_vol(current_price, returns.to_numpy()),
        "holding_period": holding_period,
        "market_cap": market_cap,
        "cap_formatted": _cap_label(market_cap),
        "cap_tier": _cap_tier(market_cap),
        "price_date": history.index[-1].strftime("%Y-%m-%d"),
        "last_trade_date": last_trade_date,
        "stale": (datetime.now(timezone(timedelta(hours=3))).date() - history.index[-1].date()).days > 4,
        "data_source": "Yahoo Finance daily unadjusted close (split-adjusted, cash dividends excluded)",
        "source_url": f"https://finance.yahoo.com/quote/{feed_symbol(market, ticker)}/history/",
        "error": None,
    }


def _performance(items: List[tuple], bench: Optional[pd.Series], bench_name: str,
                 initial_capital: Optional[float] = None, cash: float = 0.0,
                 start_date: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Track the entire account, including cash reserved before each purchase.

    Capital is funded at the start, cash earns zero, and purchases transfer cash
    into shares. No deposits, sales, fees or cash dividends are inferred. A later
    reporting start rebases existing holdings at their last known closing price.
    Never backfill prices from future observations.
    """
    lots = []
    for pos, hist in items:
        dt = _parse_day(pos.get("date_bought"))
        if not dt or hist is None or hist.empty:
            return None
        fx = float(pos.get("quote_to_base", 1.0))
        lots.append((dt, float(pos["shares"]), float(pos["price_bought"]) * fx,
                     hist["Close"].dropna().sort_index() * fx))
    requested = _parse_day(start_date)
    start = requested or (min(l[0] for l in lots) if lots else None)
    if start is None:
        return None
    today = datetime.now(timezone(timedelta(hours=3))).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
    if start > today:
        return None
    principal = initial_capital if initial_capital is not None else cash + sum(shares * price for _, shares, price, _ in lots)
    if principal <= 0:
        return None
    idx = pd.date_range(start, today, freq="D")

    def align(series):
        return series.reindex(series.index.union(idx)).ffill().reindex(idx)

    equity = pd.Series(float(principal), index=idx)
    baseline = float(principal)
    for dt, shares, price, closes in lots:
        prices = align(closes)
        held = idx >= dt
        # A missing quote for a held stock makes that day's return unavailable.
        equity += ((prices - price) * shares).where(held, 0.0)
        if dt < start:
            if pd.isna(prices.iloc[0]):
                return None
            baseline += float((prices.iloc[0] - price) * shares)
    if baseline <= 0:
        return None
    portfolio = equity / baseline - 1
    benchmark = None
    benchmark_warning = None
    compare_from = None
    comparison_day = None
    portfolio_comparison_return = None
    benchmark_comparison_return = None
    benchmark_last_day = None
    if bench is not None and len(bench.dropna()) >= 2:
        source = bench.dropna().sort_index()
        b = align(source)
        benchmark_last_day = source.index[-1].strftime("%Y-%m-%d")
        if pd.notna(b.iloc[0]) and b.iloc[0] > 0:
            benchmark = (b / float(b.iloc[0]) - 1).where(idx <= source.index[-1])
            common = portfolio.notna() & benchmark.notna()
            if common.any():
                comparison_day = idx[common][-1].strftime("%Y-%m-%d")
                portfolio_comparison_return = round(float(portfolio[common].iloc[-1]), 5)
                benchmark_comparison_return = round(float(benchmark[common].iloc[-1]), 5)
                compare_from = start.strftime("%Y-%m-%d")
        else:
            benchmark_warning = "Benchmark history does not cover the selected start date. Add earlier index data or choose a later start date."
    else:
        benchmark_warning = "Benchmark history is unavailable for this period."
    step = max(1, math.ceil(len(idx) / MAX_CHART_POINTS))
    keep = sorted(set([0, len(idx) - 1] + list(range(0, len(idx), step)) +
                      ([idx.get_loc(pd.Timestamp(comparison_day))] if comparison_day else [])))
    pick = lambda series: [_clean(round(float(x), 5)) if pd.notna(x) else None for x in series.iloc[keep]]
    latest = portfolio.dropna()
    return {
        "days": [day.strftime("%Y-%m-%d") for day in idx[keep]],
        "portfolio": pick(portfolio), "benchmark": pick(benchmark) if benchmark is not None else None,
        "benchmark_name": bench_name, "starts": start.strftime("%Y-%m-%d"),
        "compare_from": compare_from, "comparison_day": comparison_day,
        "portfolio_return": round(float(latest.iloc[-1]), 5) if len(latest) else None,
        "benchmark_return": benchmark_comparison_return,
        "portfolio_comparison_return": portfolio_comparison_return,
        "benchmark_warning": benchmark_warning, "benchmark_last_day": benchmark_last_day,
        "baseline_value": round(baseline, 6), "initial_capital": principal,
        "basis": "whole_account", "cash_included": True,
    }


def compute(market: str) -> Dict[str, Any]:
    cfg = MARKETS[market]
    decimals = cfg["decimals"]
    positions = db.list_positions(market)
    cash = db.get_cash(market)
    settings = db.get_portfolio_settings(market)
    bench_info = get_benchmark(market)

    symbols = {p["id"]: feed_symbol(market, p["ticker"]) for p in positions}
    wanted = sorted(set(symbols.values()))
    histories: Dict[str, pd.DataFrame] = {}
    meta: Dict[str, Dict[str, Any]] = {}
    sector_weights: Dict[str, float] = {}
    bench_close: Optional[pd.Series] = None
    feed_ok = True

    if wanted or settings["start_date"]:
        # Go back far enough to cover the oldest purchase, and at least five years for beta / VaR.
        dates = [datetime.now() - timedelta(days=365 * MIN_HISTORY_YEARS)]
        dates += [d - timedelta(days=90) for d in (_parse_day(p.get("date_bought")) for p in positions) if d]
        if settings["start_date"]:
            dates.append(_parse_day(settings["start_date"]) - timedelta(days=90))
        start = min(dates).strftime("%Y-%m-01")
        extra = [bench_info["symbol"]] if bench_info["symbol"] else []
        if bench_info["source"] == "estimate":
            extra = [t + ".BH" for t in BH_MARKET_BASKET if t + ".BH" not in wanted]
        with ThreadPoolExecutor(max_workers=3) as pool:
            f_hist = pool.submit(_history, wanted + extra, start)
            f_weights = pool.submit(_market_sector_weights) if market == "us" else None
            histories = f_hist.result()
            sector_weights = f_weights.result() if f_weights else {}
        found = [s for s in wanted if s in histories]
        feed_ok = bool(found) or not wanted
        meta = _meta_us(found) if market == "us" else _meta_bh(found)
        if bench_info["symbol"]:
            bh = histories.get(bench_info["symbol"])
            bench_close = bh["Close"] if bh is not None else None
    if market == "bh":
        if bench_info["source"] == "import":
            bench_close = _imported_index(market)
        elif histories:
            bench_close, used = _bh_market_estimate(histories)
            bench_info["stocks"] = used
    market_returns = _log_returns(bench_close) if bench_close is not None else None

    saved = db.get_metrics() if positions else {}
    rows: List[Dict[str, Any]] = []
    perf_items = []
    for pos in positions:
        sym = symbols[pos["id"]]
        hist = histories.get(sym)
        row = None
        if hist is not None and not hist.empty:
            try:
                row = _row(pos, hist, meta.get(sym, {}), market_returns, decimals, market)
                if sym in _HIST and time.time() - _HIST[sym][0] > PRICE_TTL:
                    row["stale"] = True
                db.set_metrics(pos["id"], row)
                perf_items.append(({**pos, "quote_to_base": quote_to_base(market, pos["ticker"])}, hist))
            except Exception as exc:
                print(f"calc failed for {pos['ticker']}: {exc}")
        if row is None:
            # Feed unavailable: fall back to the last figures we computed for this position.
            last = saved.get(pos["id"])
            if last and last["data"].get("ticker") == pos["ticker"]:
                row = dict(last["data"])
                row.update({"shares": float(pos["shares"]), "price_bought": float(pos["price_bought"]),
                            "stale": True, "error": None})
                fx = quote_to_base(market, pos["ticker"])
                row["quote_currency"] = quote_currency(market, pos["ticker"])
                row["quote_to_base"] = fx
                old_value = row.get("position_value")
                row["position_value"] = round((row.get("current_price") or 0) * row["shares"] * fx, decimals)
                row["value_paid"] = round(row["price_bought"] * row["shares"] * fx, decimals)
                row["var"] = round(row["var"] / old_value * row["position_value"], 2) if old_value and row.get("var") is not None else None
                # Recompute purchase-dependent metrics from the edited inputs.
                row["date_bought"] = pos.get("date_bought")
                row["pct_change"] = round(row["current_price"] / row["price_bought"] - 1, 4) if row.get("current_price") and row["price_bought"] else None
            else:
                row = {"id": pos["id"], "ticker": pos["ticker"], "shares": float(pos["shares"]),
                       "price_bought": float(pos["price_bought"]), "date_bought": pos.get("date_bought"),
                       "value_paid": round(float(pos["price_bought"]) * float(pos["shares"]) * quote_to_base(market, pos["ticker"]), decimals),
                       "quote_currency": quote_currency(market, pos["ticker"]), "quote_to_base": quote_to_base(market, pos["ticker"]),
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
    has_beta = any(r.get("beta") is not None for r in rows)
    totals = {
        "cash": cash,
        "invested": round(invested, decimals),
        "total": round(invested + cash, decimals),
        "cost": round(cost, decimals),
        "pnl": round(invested - cost, decimals),
        "pnl_pct": round((invested - cost) / cost, 4) if cost else None,
        "beta": round(sum(r.get("beta_weighted") or 0 for r in rows), 4) if has_beta else None,
        "expected_return": round(sum(r.get("weighted_expected_return") or 0 for r in rows), 6) if has_beta else None,
        "var": round(sum(r.get("var") or 0 for r in rows), 2) if priced else None,
        "positions": len(rows),
    }

    if priced and not any(r.get("stale") for r in rows):
        db.record_value(market, datetime.now(timezone.utc).strftime("%Y-%m-%d"), invested, cash)

    performance = None
    try:
        if len(perf_items) == len(positions):
            performance = _performance(perf_items, bench_close, bench_info["name"], settings["initial_capital"], cash, settings["start_date"])
    except Exception as exc:
        print(f"performance series failed: {exc}")

    return {
        "market": market,
        "rows": [{k: _clean(v) for k, v in r.items()} for r in rows],
        "totals": {k: _clean(v) for k, v in totals.items()},
        "market_sector_weights": sector_weights,
        "value_history": db.list_value_history(market),
        "performance": performance,
        "benchmark": bench_info,
        "as_of": db.now(),
        "risk_free_rate": RISK_FREE_RATE,
        "portfolio_settings": settings,
        "performance_warning": "Performance needs a purchase date and price history for every holding; partial portfolios are not compared." if positions and performance is None else None,
        "feed_ok": feed_ok,
    }
