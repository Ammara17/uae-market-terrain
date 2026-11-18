#!/usr/bin/env python3
"""Build data/stocks.json for the UAE Market Terrain dashboard.

Live mode (default) downloads one year of daily closes and volumes for every
stock in data/universe.json from Yahoo Finance's public chart endpoint. It uses
only the Python standard library, so it runs anywhere Python 3.9+ is installed.

    python scripts/fetch_data.py            # live prices from Yahoo Finance
    python scripts/fetch_data.py --range 2y # longer history
    python scripts/fetch_data.py --demo     # offline, simulated prices

Demo mode writes a deterministic random walk with the same schema. The
dashboard shows a "Demo data" banner whenever the file came from --demo, so
simulated prices are never mistaken for real ones.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE_PATH = ROOT / "data" / "universe.json"
OUTPUT_PATH = ROOT / "data" / "stocks.json"

YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?{query}"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
UAE_OFFSET_SECONDS = 4 * 3600  # Gulf Standard Time, UTC+4, no DST


def load_universe() -> list[dict]:
    with UNIVERSE_PATH.open(encoding="utf-8") as fh:
        stocks = json.load(fh)["stocks"]
    seen = set()
    for stock in stocks:
        for key in ("symbol", "yahoo", "name", "exchange", "sector"):
            if not stock.get(key):
                raise SystemExit(f"universe.json: entry {stock!r} is missing '{key}'")
        if stock["symbol"] in seen:
            raise SystemExit(f"universe.json: duplicate symbol {stock['symbol']}")
        seen.add(stock["symbol"])
    return stocks


# --------------------------------------------------------------------------
# Live data
# --------------------------------------------------------------------------

try:  # yfinance mimics a real browser session, which Yahoo blocks far less often
    import yfinance as yf  # type: ignore[import-not-found]
except ImportError:  # the plain standard-library path below still works locally
    yf = None


def fetch_yahoo(yahoo_symbol: str, history: str) -> dict[str, tuple[float, int]]:
    """Return {YYYY-MM-DD: (close, volume)} for one symbol, keyed by UAE trading day."""
    if yf is not None:
        return fetch_yahoo_yf(yahoo_symbol, history)
    return fetch_yahoo_http(yahoo_symbol, history)


def yf_options(history: str) -> dict:
    """History options, asking yfinance to raise errors instead of printing them."""
    options = {"period": history, "interval": "1d", "auto_adjust": False, "actions": False}
    debug = getattr(getattr(yf, "config", None), "debug", None)
    if debug is not None and hasattr(debug, "hide_exceptions"):
        debug.hide_exceptions = False  # yfinance 1.x
    else:
        options["raise_errors"] = True  # older yfinance
    return options


def fetch_yahoo_yf(yahoo_symbol: str, history: str, retries: int = 3) -> dict[str, tuple[float, int]]:
    frame = None
    for attempt in range(retries):
        try:
            frame = yf.Ticker(yahoo_symbol).history(**yf_options(history))
            break
        except Exception:  # noqa: BLE001 - rate limits and timeouts are worth a retry
            if attempt == retries - 1:
                raise
            time.sleep(3 * (attempt + 1))

    rows: dict[str, tuple[float, int]] = {}
    if frame is not None and not frame.empty:
        index = frame.index
        if getattr(index, "tz", None) is not None:
            index = index.tz_convert("Asia/Dubai")
        for stamp, close, volume in zip(index, frame["Close"], frame["Volume"]):
            if close is None or not math.isfinite(float(close)) or close <= 0:
                continue
            vol = 0 if volume is None or not math.isfinite(float(volume)) else int(volume)
            rows[stamp.date().isoformat()] = (round(float(close), 4), vol)
    if len(rows) < 5:
        raise ValueError(f"only {len(rows)} usable rows")
    return rows


def fetch_yahoo_http(yahoo_symbol: str, history: str, retries: int = 3) -> dict[str, tuple[float, int]]:
    query =urllib.parse.urlencode({"range": history, "interval": "1d", "includePrePost": "false"})
    url = YAHOO_URL.format(symbol=urllib.parse.quote(yahoo_symbol), query=query)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    payload = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                payload = json.load(response)
            break
        except urllib.error.HTTPError as err:
            # 404 means the symbol does not exist; retrying will not help.
            if err.code == 404 or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(2 * (attempt + 1))

    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        raise ValueError(chart["error"].get("description") or "Yahoo returned an error")
    results = chart.get("result") or []
    if not results or not results[0].get("timestamp"):
        raise ValueError("no price history returned")

    result = results[0]
    offset = result.get("meta", {}).get("gmtoffset", UAE_OFFSET_SECONDS)
    quote = result["indicators"]["quote"][0]
    rows: dict[str, tuple[float, int]] = {}
    for stamp, close, volume in zip(result["timestamp"], quote.get("close", []), quote.get("volume", [])):
        if close is None or not math.isfinite(close) or close <= 0:
            continue
        day = dt.datetime.fromtimestamp(stamp + offset, dt.timezone.utc).date().isoformat()
        rows[day] = (round(float(close), 4), int(volume or 0))
    if len(rows) < 5:
        raise ValueError(f"only {len(rows)} usable rows")
    return rows


def build_live(universe: list[dict], history: str) -> dict:
    fetched: list[tuple[dict, dict[str, tuple[float, int]]]] = []
    skipped: list[dict] = []
    for stock in universe:
        try:
            rows = fetch_yahoo(stock["yahoo"], history)
            fetched.append((stock, rows))
            print(f"  ok    {stock['yahoo']:<16} {len(rows):>4} days", file=sys.stderr)
        except Exception as err:  # noqa: BLE001 - one bad symbol must not stop the run
            skipped.append({"symbol": stock["symbol"], "yahoo": stock["yahoo"], "reason": str(err)})
            print(f"  skip  {stock['yahoo']:<16} {err}", file=sys.stderr)
            if not fetched and len(skipped) >= 5:
                raise SystemExit(
                    "The first five symbols all failed, so Yahoo Finance looks unreachable "
                    f"(last error: {err}). Leaving the existing data file untouched."
                )
        time.sleep(0.35)  # be polite to the endpoint

    if not fetched:
        raise SystemExit("No symbols could be downloaded; leaving the existing data file untouched.")

    dates = sorted({day for _, rows in fetched for day in rows})
    stocks = []
    for stock, rows in fetched:
        closes, volumes, last = [], [], None
        for day in dates:
            if day in rows:
                last = rows[day][0]
                closes.append(last)
                volumes.append(rows[day][1])
            else:
                # Before listing: null. After listing: carry the last close forward
                # (exchange holiday or a day with no trades).
                closes.append(last)
                volumes.append(0 if last is not None else None)
        stocks.append({**public_fields(stock), "close": closes, "volume": volumes})

    return envelope("live", "Yahoo Finance (daily close, AED)", dates, stocks, skipped)


# --------------------------------------------------------------------------
# Demo data
# --------------------------------------------------------------------------

def trading_days(end: dt.date, count: int) -> list[str]:
    """UAE markets trade Monday to Friday (since January 2022)."""
    days, cursor = [], end
    while len(days) < count:
        if cursor.weekday() < 5:
            days.append(cursor.isoformat())
        cursor -= dt.timedelta(days=1)
    return list(reversed(days))


def build_demo(universe: list[dict], seed: int, end: dt.date, count: int) -> dict:
    rng = random.Random(seed)
    dates = trading_days(end, count)
    sectors = sorted({s["sector"] for s in universe})

    market = [rng.gauss(0.0003, 0.0062) for _ in dates]
    sector_moves = {name: [rng.gauss(0.0, 0.004) for _ in dates] for name in sectors}
    sector_drift = {name: rng.gauss(0.0, 0.0004) for name in sectors}

    stocks = []
    for stock in universe:
        beta = rng.uniform(0.6, 1.35)
        idio = rng.uniform(0.005, 0.013)
        drift = sector_drift[stock["sector"]] + rng.gauss(0.0, 0.0003)
        price = math.exp(rng.uniform(math.log(0.6), math.log(24.0)))
        base_volume = math.exp(rng.uniform(math.log(4e5), math.log(2.5e7)))
        closes, volumes = [], []
        for i in range(len(dates)):
            move = drift + beta * market[i] + sector_moves[stock["sector"]][i] + rng.gauss(0.0, idio)
            if rng.random() < 0.008:  # occasional earnings-style jump
                move += rng.choice((-1, 1)) * rng.uniform(0.025, 0.06)
            price *= math.exp(move)
            tick = 0.001 if price < 1 else 0.01  # coarse UAE-style tick sizes
            closes.append(round(max(tick, round(price / tick) * tick), 3))
            volumes.append(int(base_volume * math.exp(rng.gauss(0, 0.45)) * (1 + 25 * abs(move))))
        stocks.append({**public_fields(stock), "close": closes, "volume": volumes})

    return envelope("demo", "Simulated random walk (not real prices)", dates, stocks, [])


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

def public_fields(stock: dict) -> dict:
    return {key: stock[key] for key in ("symbol", "yahoo", "name", "exchange", "sector")}


def envelope(source: str, source_name: str, dates: list[str], stocks: list[dict], skipped: list[dict]) -> dict:
    return {
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": source,
        "sourceName": source_name,
        "currency": "AED",
        "timezone": "Asia/Dubai",
        "asOf": dates[-1],
        "dates": dates,
        "stocks": stocks,
        "skipped": skipped,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", action="store_true", help="write simulated prices instead of downloading")
    parser.add_argument("--range", default="1y", help="Yahoo history range for live mode (default: 1y)")
    parser.add_argument("--seed", type=int, default=7, help="random seed for --demo (default: 7)")
    parser.add_argument("--days", type=int, default=260, help="trading days for --demo (default: 260)")
    parser.add_argument("--end", help="last trading day for --demo, YYYY-MM-DD (default: last weekday)")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="where to write the JSON")
    args = parser.parse_args()

    universe = load_universe()
    if args.demo:
        end = dt.date.fromisoformat(args.end) if args.end else dt.date.today() - dt.timedelta(days=1)
        data = build_demo(universe, args.seed, end, args.days)
    else:
        print(f"Downloading {len(universe)} symbols from Yahoo Finance…", file=sys.stderr)
        data = build_live(universe, args.range)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
        fh.write("\n")
    print(
        f"Wrote {args.output.relative_to(ROOT) if args.output.is_relative_to(ROOT) else args.output}: "
        f"{len(data['stocks'])} stocks × {len(data['dates'])} days ({data['source']}), "
        f"{len(data['skipped'])} skipped",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
