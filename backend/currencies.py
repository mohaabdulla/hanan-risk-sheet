"""Quote currencies differ from the portfolio's reporting currency on BHB.

Symbols/currencies: Bahrain Bourse daily trading summaries and company quotes.
USD conversion uses the CBB peg (1 USD = 0.376 BHD); broker fees are excluded.
"""
USD_BHD = 0.376
BH_USD_SYMBOLS = {"ABC", "ARIG", "GFH", "INOVEST", "ITHMR", "KFH"}


def quote_currency(market: str, ticker: str) -> str:
    return "USD" if market == "us" or ticker.upper().removesuffix(".BH") in BH_USD_SYMBOLS else "BHD"


def quote_to_base(market: str, ticker: str) -> float:
    return USD_BHD if market == "bh" and quote_currency(market, ticker) == "USD" else 1.0
