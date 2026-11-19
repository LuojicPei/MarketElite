"""Standalone connectivity checker for configured MarketElite API keys and public feeds."""

from __future__ import annotations

import asyncio
from datetime import date, timedelta

import httpx

from app.core.config import get_settings

_REQUEST_ERRORS = (httpx.HTTPError, KeyError, IndexError, ValueError, OSError)


async def check_all() -> None:
    settings = get_settings()
    results: list[tuple[str, str, str]] = []

    async with httpx.AsyncClient(timeout=10.0) as client:
        # 1. Alpaca Paper Trading & Data
        if settings.alpaca_api_key and settings.alpaca_secret_key:
            try:
                base = (
                    "https://paper-api.alpaca.markets"
                    if settings.alpaca_paper
                    else "https://api.alpaca.markets"
                )
                r = await client.get(
                    f"{base}/v2/account",
                    headers={
                        "APCA-API-KEY-ID": settings.alpaca_api_key,
                        "APCA-API-SECRET-KEY": settings.alpaca_secret_key,
                    },
                )
                if r.status_code == 200:
                    acct = r.json()
                    results.append(
                        (
                            "Alpaca Account",
                            "OK",
                            f"status={acct.get('status')}, equity={acct.get('equity')}",
                        )
                    )
                else:
                    results.append(("Alpaca Account", "FAIL", f"HTTP {r.status_code}"))
            except _REQUEST_ERRORS as exc:
                results.append(("Alpaca Account", "FAIL", str(exc)[:100]))
        else:
            results.append(("Alpaca Account", "SKIP", "ALPACA_API_KEY / ALPACA_SECRET_KEY not set"))

        # 2. FRED API
        if settings.fred_api_key:
            try:
                r = await client.get(
                    "https://api.stlouisfed.org/fred/series/observations",
                    params={
                        "series_id": "DGS10",
                        "api_key": settings.fred_api_key,
                        "file_type": "json",
                        "sort_order": "desc",
                        "limit": 1,
                    },
                )
                if r.status_code == 200:
                    obs = r.json().get("observations", [{}])[0]
                    results.append(("FRED (DGS10)", "OK", f"latest={obs.get('date')} -> {obs.get('value')}"))
                else:
                    results.append(("FRED (DGS10)", "FAIL", f"HTTP {r.status_code}"))
            except _REQUEST_ERRORS as exc:
                results.append(("FRED (DGS10)", "FAIL", str(exc)[:100]))
        else:
            results.append(("FRED API", "SKIP", "FRED_API_KEY not set"))

        # 3. Finnhub
        if settings.finnhub_api_key:
            try:
                r = await client.get(
                    "https://finnhub.io/api/v1/calendar/earnings",
                    params={
                        "from": date.today().isoformat(),
                        "to": (date.today() + timedelta(days=7)).isoformat(),
                        "token": settings.finnhub_api_key,
                    },
                )
                if r.status_code == 200:
                    cnt = len(r.json().get("earningsCalendar", []))
                    results.append(("Finnhub Earnings", "OK", f"{cnt} upcoming earnings in next 7d"))
                else:
                    results.append(("Finnhub Earnings", "FAIL", f"HTTP {r.status_code}"))
            except _REQUEST_ERRORS as exc:
                results.append(("Finnhub Earnings", "FAIL", str(exc)[:100]))
        else:
            results.append(("Finnhub Earnings", "SKIP", "FINNHUB_API_KEY not set"))

        # 4. FMP Economic Calendar
        if settings.fmp_api_key:
            try:
                r = await client.get(
                    "https://financialmodelingprep.com/stable/economic-calendar",
                    params={
                        "from": date.today().isoformat(),
                        "to": (date.today() + timedelta(days=14)).isoformat(),
                        "apikey": settings.fmp_api_key,
                    },
                )
                if r.status_code == 200 and isinstance(r.json(), list):
                    results.append(("FMP Calendar", "OK", f"{len(r.json())} events in next 14d"))
                else:
                    results.append(("FMP Calendar", "FAIL", f"HTTP {r.status_code}"))
            except _REQUEST_ERRORS as exc:
                results.append(("FMP Calendar", "FAIL", str(exc)[:100]))
        else:
            results.append(("FMP Calendar", "SKIP", "FMP_API_KEY not set"))

        # 5. Binance Vision (Keyless)
        try:
            r = await client.get(
                "https://data-api.binance.vision/api/v3/ticker/price",
                params={"symbol": "BTCUSDT"},
            )
            if r.status_code == 200:
                results.append(("Binance BTCUSDT", "OK", f"price={r.json().get('price')}"))
            else:
                results.append(("Binance BTCUSDT", "FAIL", f"HTTP {r.status_code}"))
        except _REQUEST_ERRORS as exc:
            results.append(("Binance BTCUSDT", "FAIL", str(exc)[:100]))

        # 6. CFTC COT Socrata (Keyless)
        try:
            r = await client.get(
                "https://publicreporting.cftc.gov/api/v3/views/6dca-aqww/query.json",
                params={"$limit": 1},
            )
            if r.status_code == 200:
                results.append(("CFTC Socrata", "OK", "Connected to public COT endpoint"))
            else:
                results.append(("CFTC Socrata", "FAIL", f"HTTP {r.status_code}"))
        except _REQUEST_ERRORS as exc:
            results.append(("CFTC Socrata", "FAIL", str(exc)[:100]))

        # 7. SEC EDGAR (Keyless with User-Agent)
        try:
            r = await client.get(
                "https://www.sec.gov/files/company_tickers.json",
                headers={"User-Agent": settings.sec_edgar_user_agent},
            )
            if r.status_code == 200:
                results.append(("SEC EDGAR", "OK", f"{len(r.json())} company CIK mappings"))
            else:
                results.append(("SEC EDGAR", "FAIL", f"HTTP {r.status_code}"))
        except _REQUEST_ERRORS as exc:
            results.append(("SEC EDGAR", "FAIL", str(exc)[:100]))

        # 8. LLM Fast Tier Smoke Check
        if settings.llm_fast_api_key:
            try:
                base = settings.llm_fast_base_url.rstrip("/")
                r = await client.post(
                    f"{base}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.llm_fast_api_key}"},
                    json={
                        "model": settings.llm_fast_model,
                        "messages": [{"role": "user", "content": "Reply with OK only."}],
                        "max_tokens": 8,
                    },
                )
                if r.status_code == 200:
                    content = r.json()["choices"][0]["message"]["content"].strip()
                    results.append((f"LLM ({settings.llm_fast_model})", "OK", f"reply={content!r}"))
                else:
                    results.append((f"LLM ({settings.llm_fast_model})", "FAIL", f"HTTP {r.status_code}"))
            except _REQUEST_ERRORS as exc:
                results.append((f"LLM ({settings.llm_fast_model})", "FAIL", str(exc)[:100]))
        else:
            results.append(("LLM Fast Tier", "SKIP", "LLM_FAST_API_KEY not set"))

    print("\n=== MarketElite API Connectivity Report ===")
    for name, status, detail in results:
        print(f"[{status:^4}] {name:<24} | {detail}")


if __name__ == "__main__":
    asyncio.run(check_all())
