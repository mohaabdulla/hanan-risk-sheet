"""Deterministic account-return and source-handling checks; no network or real DB."""
from datetime import datetime, timezone

import pandas as pd
import pytest

from backend import analytics
from backend.currencies import quote_currency, quote_to_base


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            stamp = cls(2024, 1, 10, 12, tzinfo=timezone.utc)
            return stamp.astimezone(tz) if tz else stamp.replace(tzinfo=None)
    monkeypatch.setattr(analytics, "datetime", Clock)


def series(days, values):
    return pd.Series(values, index=pd.to_datetime(days))


def lot(day="2024-01-04", fx=1):
    return {"date_bought": day, "shares": 10, "price_bought": 10, "quote_to_base": fx}


def test_cash_waits_until_purchase_and_benchmark_starts_before_trading():
    hist = pd.DataFrame({"Close": series(["2024-01-04", "2024-01-10"], [10, 12])})
    bench = series(["2024-01-01", "2024-01-10"], [100, 110])
    p = analytics._performance([(lot(), hist)], bench, "Index", 1000, 900, "2024-01-01")
    assert p["days"][0] == "2024-01-01"
    assert p["portfolio"][:4] == [0, 0, 0, 0]
    assert p["portfolio_return"] == .02  # BHD/USD 20 gain on all 1000, not 20% on invested 100
    assert p["benchmark_return"] == .1
    assert p["comparison_day"] == "2024-01-10"


def test_manual_cash_also_dilutes_stock_returns():
    hist = pd.DataFrame({"Close": series(["2024-01-04", "2024-01-10"], [10, 12])})
    p = analytics._performance([(lot(), hist)], None, "Index", cash=900)
    assert p["initial_capital"] == 1000 and p["portfolio_return"] == .02


def test_later_start_rebases_already_owned_holdings():
    hist = pd.DataFrame({"Close": series(["2024-01-04", "2024-01-08", "2024-01-10"], [10, 11, 12])})
    p = analytics._performance([(lot(), hist)], None, "Index", 1000, 900, "2024-01-08")
    assert p["baseline_value"] == 1010
    assert p["portfolio"][0] == 0
    assert p["portfolio_return"] == round(1020 / 1010 - 1, 5)


def test_cash_only_account_can_compare_before_first_trade():
    bench = series(["2024-01-01", "2024-01-10"], [100, 105])
    p = analytics._performance([], bench, "Index", 1000, 1000, "2024-01-01")
    assert p["portfolio_return"] == 0 and p["benchmark_return"] == .05


def test_missing_benchmark_start_is_not_silently_moved_forward():
    bench = series(["2024-01-05", "2024-01-10"], [100, 105])
    p = analytics._performance([], bench, "Index", 1000, 1000, "2024-01-01")
    assert p["benchmark"] is None
    assert "selected start date" in p["benchmark_warning"]


def test_benchmark_ends_at_actual_data_and_comparison_uses_same_day():
    hist = pd.DataFrame({"Close": series(["2024-01-04", "2024-01-08", "2024-01-10"], [10, 11, 12])})
    bench = series(["2024-01-01", "2024-01-08"], [100, 105])
    p = analytics._performance([(lot(), hist)], bench, "Index", 1000, 900, "2024-01-01")
    assert p["benchmark"][-1] is None
    assert p["comparison_day"] == "2024-01-08"
    assert p["portfolio_comparison_return"] == .01
    assert p["portfolio_return"] == .02


def test_no_future_quotes_backfilled_into_held_positions():
    hist = pd.DataFrame({"Close": series(["2024-01-05", "2024-01-10"], [11, 12])})
    p = analytics._performance([(lot(), hist)], None, "Index", 1000, 900, "2024-01-01")
    assert p["portfolio"][3] is None  # stock held on Jan 4, first quote is Jan 5
    assert analytics._performance([(lot(), hist)], None, "Index", 1000, 900, "2024-01-04") is not None
    assert analytics._performance([(lot(), hist)], None, "Index", 1000, 900, "2024-01-02")["portfolio"][0] == 0
    assert analytics._performance([(lot("2024-01-01"), hist)], None, "Index", 1000, 900, "2024-01-03") is None


def test_usd_prices_stay_in_quote_currency_but_values_are_bhd():
    days = pd.date_range("2023-12-01", "2024-01-10")
    hist = pd.DataFrame({"Close": .435, "High": .44, "Low": .43, "Volume": 100}, index=days)
    row = analytics._row({"id": "x", "ticker": "GFH", "shares": 5000, "price_bought": .25, "date_bought": "2024-01-01"}, hist, {}, None, 3, "bh")
    assert row["quote_currency"] == "USD" and row["current_price"] == .435
    assert row["position_value"] == 817.8 and row["value_paid"] == 470
    assert row["pct_change"] == .74
    p = analytics._performance([(lot(fx=.376), pd.DataFrame({"Close": series(["2024-01-04", "2024-01-10"], [10, 12])}))], None, "Index", 1000, 962.4, "2024-01-01")
    assert p["portfolio_return"] == .00752


def test_last_trade_date_does_not_claim_a_carried_quote_is_new():
    hist = pd.DataFrame({"Close": .117, "High": .117, "Low": .117, "Volume": [10, 0]}, index=pd.to_datetime(["2024-01-04", "2024-01-10"]))
    row = analytics._row({"id": "z", "ticker": "ZAINBH", "shares": 1, "price_bought": .1}, hist, {}, None, 3, "bh")
    assert row["price_date"] == "2024-01-10" and row["last_trade_date"] == "2024-01-04"


@pytest.mark.parametrize("ticker", ["BMB", "DUTYF", "UGH", "UGIC", "ALBH", "NBB", "BBK", "ZAINBH"])
def test_bhd_listings_are_not_converted_from_company_financial_statement_currency(ticker):
    assert quote_currency("bh", ticker) == "BHD" and quote_to_base("bh", ticker) == 1


@pytest.mark.parametrize("ticker", ["ABC", "ARIG", "GFH", "INOVEST", "ITHMR", "KFH"])
def test_confirmed_usd_listings_use_the_peg(ticker):
    assert quote_currency("bh", ticker + ".BH") == "USD" and quote_to_base("bh", ticker) == .376
