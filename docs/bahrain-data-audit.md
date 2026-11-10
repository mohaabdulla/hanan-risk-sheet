# Bahrain market data check — 10 November 2026

The app's five saved Bahrain holdings were compared with the Bahrain Bourse's
own company trade-history tables. This check reads data only; it does not change
holdings, purchase prices, cash or imported index history.

| Holding | Quote currency | App cached close | Exchange close on 9 Nov 2026 | Result |
| --- | --- | ---: | ---: | --- |
| ALBH | BHD | 0.730 | 0.730 | Matches |
| NBB | BHD | 0.511 | 0.511 | Matches |
| BBK | BHD | 0.540 | 0.540 | Matches |
| GFH | USD | 0.435 | 0.435 | Price matches; old BHD valuation was incorrect |
| ZAINBH | BHD | 0.117 | Last actual trade 3 Nov: 0.117 | Price matches the carried quote; 9 Nov was not its last trade date |

On 10 Nov the official index table returned **1,824.34**, with previous index
**1,821.56**, change **+2.78** (**+0.15%**). This is an index in points, not BHD.
The stock trade-history export uses US date ordering (`11/09/2026` = 9 November).
The latest table also had 10 Nov closes of ALBH 0.730, NBB 0.510, BBK 0.540 and
GFH USD 0.439. Those must not be compared with the app's *9 Nov* closing prices
as if they were observations from the same day.

There are no imported index points in the local database. The app therefore uses
an equal-weight stock-basket estimate. This is **not the Bahrain All Share Index**,
and neither its level nor its returns should be described as the official index.
The UI now makes that distinction explicit. Importing genuine daily index closes
remains necessary for an official historical benchmark; imports themselves are
not independently certified by the application. If the imported series does not
cover the selected performance start date, the app leaves the comparison
unavailable instead of silently choosing a later start.

GFH's USD quote must be converted before combining it with BHD holdings. At the
CBB peg of 0.376 BHD per USD, 5,000 shares at USD 0.435 are **BHD 817.800**, not
BHD 2,175.000. The entered purchase cost of 5,000 × USD 0.250 is **BHD 470.000**.
Prices and ATR levels remain in USD; position values, costs, VaR, sector totals
and whole-account returns use BHD. The same conversion applies to the other
identified USD-quoted Bahrain listings.

The exchange's current quote profiles confirmed USD for ABC, ARIG, GFH,
INOVEST, ITHMR and KFH; BMB, DUTYF, UGH and UGIC quote in BHD. A company's
financial-statement or share-capital currency does not establish its quote
currency. Stored purchase-price numbers are preserved. Review existing entries
for USD-quoted stocks: the previous form labelled all Bahrain prices BHD, so an
entry already converted to BHD must be corrected to its actual USD purchase price.

The old feed requested dividend-adjusted historical OHLC data while comparing
it with the user's actual purchase prices. The app now requests unadjusted
closing prices (Yahoo still adjusts historical prices for stock splits).
Reported performance excludes cash dividends and fees. This avoids claiming a
total return when cash dividend receipts are not recorded.

This is a check of the listed observations and calculation conventions. It does
not certify every historical OHLC bar, every stock on the exchange, or US quotes.
Daily quotes can be delayed or carried forward when a stock does not trade.

Sources:

- [Bahrain All Share Index](https://bahrainbourse.com/en/Quotes%20and%20Market/Indices/bahrain-index?mkey=BHBX)
- [Bahrain Bourse daily trading summary](https://bahrainbourse.com/en/Quotes%20and%20Market/Stocks/Pages/Daily-Trading-Summary.aspx)
- [ALBH company profile and trade history](https://bahrainbourse.com/en/Pages/CompanyProfile.aspx?CompanyNameSymbol=ALBH)
- [NBB company profile and trade history](https://bahrainbourse.com/en/Pages/CompanyProfile.aspx?CompanyNameSymbol=NBB)
- [BBK company profile and trade history](https://bahrainbourse.com/en/Pages/CompanyProfile.aspx?CompanyNameSymbol=BBK)
- [GFH company profile and trade history](https://bahrainbourse.com/en/Pages/CompanyProfile.aspx?CompanyNameSymbol=GFH)
- [ZAINBH company profile and trade history](https://bahrainbourse.com/en/Pages/CompanyProfile.aspx?CompanyNameSymbol=ZAINBH)
- [Central Bank of Bahrain exchange-rate policy](https://www.cbb.gov.bh/monetary-policy/)

The exchange observations above were retrieved from the public JSON requests
used by those exchange pages (`BahrainAllShareIndex` and
`DataExportCompanyProfile`). No website access tokens are stored in this report.
