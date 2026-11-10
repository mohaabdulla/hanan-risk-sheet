"""
API and storage tests. Run with:  .venv/Scripts/python -m pytest -q

They use a throwaway SQLite file and never touch the network or the real database.
"""
import importlib
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for key in ("DATABASE_URL", "POSTGRES_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "VERCEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("RISKSHEET_DB", str(tmp_path / "test.db"))
    from backend import db, main
    importlib.reload(db)
    importlib.reload(main)
    yield TestClient(main.app)
    if db._conn is not None:
        db._conn.close()


def add(client, market="us", ticker="AAPL", shares=10, price=100.0, date="2024-03-15"):
    return client.post("/api/positions", json={"market": market, "ticker": ticker, "shares": shares,
                                                "price_bought": price, "date_bought": date})


def test_health_reports_a_working_database(client):
    body = client.get("/api/health").json()
    assert body["connected"] is True and body["durable"] is True


def test_position_is_saved_and_read_back(client):
    assert add(client, ticker="blk", shares=10, price=1170, date="2026-11-03").status_code == 200
    positions = client.get("/api/portfolio?market=us").json()["positions"]
    assert [(p["ticker"], p["shares"], p["price_bought"], p["date_bought"]) for p in positions] == [("BLK", 10, 1170, "2026-11-03")]


def test_purchase_date_is_required(client):
    missing = client.post("/api/positions", json={"market": "us", "ticker": "KO", "shares": 1, "price_bought": 60})
    empty = add(client, ticker="KO", date="")
    future = add(client, ticker="KO", date="2999-01-01")
    assert missing.status_code == 422 and empty.status_code == 422 and future.status_code == 422
    assert client.get("/api/portfolio?market=us").json()["positions"] == []


def test_bad_input_is_rejected(client):
    assert add(client, ticker="not a ticker!").status_code == 422
    assert add(client, shares=0).status_code == 422
    assert add(client, price=-5).status_code == 422
    assert add(client, market="xx").status_code == 422


def test_markets_are_kept_apart(client):
    add(client, market="us", ticker="AAPL")
    add(client, market="bh", ticker="ALBH", price=1.1)
    client.put("/api/cash", json={"market": "us", "amount": 500})
    client.put("/api/cash", json={"market": "bh", "amount": 75.5})
    client.put("/api/allocations", json={"market": "bh", "sector": "Financials", "allocation": 0.4})
    us = client.get("/api/portfolio?market=us").json()
    bh = client.get("/api/portfolio?market=bh").json()
    assert [p["ticker"] for p in us["positions"]] == ["AAPL"] and us["cash"] == 500 and us["allocations"] == {}
    assert [p["ticker"] for p in bh["positions"]] == ["ALBH"] and bh["cash"] == 75.5 and bh["allocations"] == {"Financials": 0.4}
    assert us["config"]["benchmark"]["symbol"] == "^GSPC"
    assert bh["config"]["benchmark"] == {"symbol": None, "name": "Bahrain market estimate", "source": "estimate"}


def test_bahrain_uses_the_official_index_once_it_is_imported(client):
    points = [{"day": "2024-01-02", "close": 1950.0}, {"day": "2024-01-03", "close": 1955.5}]
    client.post("/api/index-history", json={"market": "bh", "points": points})
    bench = client.get("/api/portfolio?market=bh").json()["config"]["benchmark"]
    assert bench["name"] == "Bahrain All Share Index" and bench["source"] == "import"


def test_bahrain_market_estimate_averages_the_active_stocks():
    import numpy as np
    import pandas as pd
    from backend import analytics
    days = pd.bdate_range("2024-01-01", periods=60)
    rng = np.random.default_rng(1)
    histories = {}
    for i, t in enumerate(analytics.BH_MARKET_BASKET[:8]):
        if i < 6:      # actively traded: up 1% every day
            close = pd.Series(1.0 * 1.01 ** np.arange(60), index=days)
        else:          # never trades: flat, must be left out of the average
            close = pd.Series(1.0, index=days)
        histories[t + ".BH"] = pd.DataFrame({"Close": close})
    level, used = analytics._bh_market_estimate(histories)
    assert used == 6
    assert abs(level.iloc[-1] / level.iloc[0] - 1.01 ** 59) < 1e-6
    # A wild one-day jump is treated as a data error and ignored.
    bad = histories[analytics.BH_MARKET_BASKET[0] + ".BH"].copy()
    bad.iloc[30:, 0] *= 5
    histories[analytics.BH_MARKET_BASKET[0] + ".BH"] = bad
    level2, _ = analytics._bh_market_estimate(histories)
    assert abs(level2.iloc[-1] / level.iloc[-1] - 1) < 0.01


def test_remove_only_hides_and_restore_brings_back(client, tmp_path):
    pid = add(client).json()["id"]
    assert client.delete(f"/api/positions/{pid}").status_code == 200
    assert client.get("/api/portfolio?market=us").json()["positions"] == []
    assert [p["id"] for p in client.get("/api/bin?market=us").json()] == [pid]
    # The row is still physically in the database file.
    raw = sqlite3.connect(tmp_path / "test.db")
    assert raw.execute("SELECT COUNT(*) FROM positions WHERE id = ?", (pid,)).fetchone()[0] == 1
    raw.close()
    assert client.post(f"/api/positions/{pid}/restore").status_code == 200
    assert [p["id"] for p in client.get("/api/portfolio?market=us").json()["positions"]] == [pid]
    assert client.get("/api/bin?market=us").json() == []


def test_edit_keeps_the_same_row(client):
    pid = add(client).json()["id"]
    res = client.put(f"/api/positions/{pid}", json={"ticker": "MSFT", "shares": 5, "price_bought": 400, "date_bought": "2024-06-03"})
    assert res.status_code == 200
    positions = client.get("/api/portfolio?market=us").json()["positions"]
    assert len(positions) == 1 and positions[0]["id"] == pid and positions[0]["ticker"] == "MSFT"
    assert client.put("/api/positions/nope", json={"ticker": "MSFT", "shares": 5, "price_bought": 400, "date_bought": "2024-06-03"}).status_code == 404


def test_same_ticker_can_be_held_twice(client):
    add(client, ticker="AAPL", date="2024-01-10")
    add(client, ticker="AAPL", date="2024-05-10")
    assert len(client.get("/api/portfolio?market=us").json()["positions"]) == 2


def test_every_change_is_logged(client):
    pid = add(client).json()["id"]
    client.put("/api/cash", json={"market": "us", "amount": 10})
    client.delete(f"/api/positions/{pid}")
    client.post(f"/api/positions/{pid}/restore")
    actions = [a["action"] for a in client.get("/api/activity").json()]
    assert sorted(actions) == sorted(["position_added", "cash_changed", "position_removed", "position_restored"])


def test_index_import_adds_and_updates_but_never_removes(client):
    first = [{"day": "2024-01-02", "close": 1950.0}, {"day": "2024-01-03", "close": 1955.5}]
    assert client.post("/api/index-history", json={"market": "bh", "points": first}).json()["saved"] == 2
    second = [{"day": "2024-01-03", "close": 1960.0}, {"day": "2024-01-04", "close": 1962.0}]
    cfg = client.post("/api/index-history", json={"market": "bh", "points": second}).json()["config"]
    assert (cfg["index_points"], cfg["index_from"], cfg["index_to"]) == (3, "2024-01-02", "2024-01-04")
    from backend import db
    assert {p["day"]: p["close"] for p in db.list_index_history("bh")}["2024-01-03"] == 1960.0
    assert client.post("/api/index-history", json={"market": "bh", "points": [{"day": "2024-01-05", "close": -1}]}).status_code == 422
    assert client.post("/api/index-history", json={"market": "us", "points": first}).status_code == 422


def test_data_survives_a_restart(client, tmp_path):
    add(client, ticker="JPM")
    client.put("/api/cash", json={"market": "us", "amount": 321})
    from backend import db, main
    db._conn.close()
    importlib.reload(db)      # a fresh process: new connection, schema setup runs again
    importlib.reload(main)
    again = TestClient(main.app).get("/api/portfolio?market=us").json()
    assert [p["ticker"] for p in again["positions"]] == ["JPM"] and again["cash"] == 321


def test_backup_contains_everything(client):
    pid = add(client).json()["id"]
    add(client, market="bh", ticker="NBB", price=0.6)
    client.delete(f"/api/positions/{pid}")
    body = client.get("/api/backup").json()
    assert [p["ticker"] for p in body["positions"]] == ["NBB"]
    assert [p["ticker"] for p in body["removed_positions"]] == ["AAPL"]
    assert set(body["cash"]) == {"us", "bh"} and len(body["activity"]) == 3


def test_hosted_site_without_a_database_refuses_instead_of_losing_data(tmp_path, monkeypatch):
    for key in ("DATABASE_URL", "POSTGRES_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("RISKSHEET_DB", str(tmp_path / "never.db"))
    from backend import db, main
    importlib.reload(db)
    importlib.reload(main)
    c = TestClient(main.app)
    res = add(c)
    assert res.status_code == 503 and "No database is configured" in res.json()["detail"]
    assert not os.path.exists(tmp_path / "never.db")
    monkeypatch.delenv("VERCEL")
    importlib.reload(db)
    importlib.reload(main)
