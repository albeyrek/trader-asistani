"""Tüm likit hisseleri günlük ve haftalık teknik analizle tarar: python -m scanner.scan [--market US|BIST]"""
import argparse
import json
import time

import pandas as pd

from .config import DATA_DIR
from .prices import load_prices, to_weekly
from .signals import DAILY, WEEKLY, analyze, outlook_label, volatility_label
from .universe import load_universe

RESULTS_FILE = DATA_DIR / "scan_results.parquet"
MAX_STALE_DAYS = 5  # Son verisi bu kadar günden eski olan (işlem görmeyen) hisseler atlanır

# Birleşik skor: orta vade (haftalık) biraz daha ağır
DAILY_WEIGHT, WEEKLY_WEIGHT = 0.4, 0.6


def scan_universe(market: str | None = None) -> pd.DataFrame:
    """Taranacak hisseler: likit, hâlâ işlem gören ve güncel evrende olanlar (yf_symbol indeksli)."""
    liq = pd.read_csv(DATA_DIR / "liquidity.csv", parse_dates=["last_date"], keep_default_na=False)
    liq = liq[liq["liquid"].astype(str) == "True"]
    liq = liq[liq["yf_symbol"].isin(load_universe()["yf_symbol"])]
    if market:
        liq = liq[liq["market"] == market]
    newest = liq["last_date"].max()
    liq = liq[liq["last_date"] >= newest - pd.Timedelta(days=MAX_STALE_DAYS)]
    return liq.set_index("yf_symbol")


def run_scan(market: str | None = None) -> pd.DataFrame:
    meta = scan_universe(market)

    prices = load_prices()
    prices = prices[prices["yf_symbol"].isin(meta.index)]
    weekly = to_weekly(prices)
    weekly_groups = dict(tuple(weekly.groupby("yf_symbol")))

    rows = []
    for sym, daily in prices.groupby("yf_symbol"):
        m = meta.loc[sym]
        d = analyze(daily, DAILY, m["market"])
        w = analyze(weekly_groups[sym], WEEKLY, m["market"]) if sym in weekly_groups else None
        if d is None:
            continue
        w_score = w.score if w else d.score
        combined = DAILY_WEIGHT * d.score + WEEKLY_WEIGHT * w_score
        rows.append({
            "market": m["market"],
            "symbol": m["symbol"],
            "yf_symbol": sym,
            "name": m["name"],
            "sector": m["sector"],
            "date": daily["date"].iloc[-1].date().isoformat(),
            "daily_score": round(d.score, 1),
            "weekly_score": round(w_score, 1) if w else None,
            "combined_score": round(combined, 1),
            "outlook": outlook_label(combined),
            "daily_outlook": outlook_label(d.score),
            "weekly_outlook": outlook_label(w_score) if w else None,
            "volatility": volatility_label(d.metrics["atr_pct"]),
            "avg_turnover": float(m["avg_turnover"]),
            **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.metrics.items()},
            "weekly_support": w.metrics["support"] if w else None,
            "weekly_resistance": w.metrics["resistance"] if w else None,
            "daily_reasons": json.dumps(d.reasons, ensure_ascii=False),
            "weekly_reasons": json.dumps(w.reasons if w else [], ensure_ascii=False),
        })

    df = pd.DataFrame(rows).sort_values("combined_score", ascending=False).reset_index(drop=True)
    if market and RESULTS_FILE.exists():
        # Tek piyasa tarandıysa diğer piyasanın önceki sonuçlarını koru
        old = pd.read_parquet(RESULTS_FILE)
        df = pd.concat([old[old["market"] != market], df], ignore_index=True)
        df = df.sort_values("combined_score", ascending=False).reset_index(drop=True)
    df.to_parquet(RESULTS_FILE, index=False)
    df.to_csv(DATA_DIR / "scan_results.csv", index=False, encoding="utf-8-sig")
    return df


def _print_top(df: pd.DataFrame, n: int = 10) -> None:
    cols = ["symbol", "close", "daily_score", "weekly_score", "combined_score", "volatility", "risk_reward"]
    for mkt, g in df.groupby("market"):
        print(f"\n=== {mkt}: en yüksek yükseliş potansiyeli ===")
        print(g.head(n)[cols].to_string(index=False))
        print(f"\n=== {mkt}: en yüksek düşüş riski ===")
        print(g.tail(n).iloc[::-1][cols].to_string(index=False))
        print(f"\nDağılım: {g['outlook'].value_counts().to_dict()}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--market", choices=["US", "BIST"])
    args = p.parse_args()
    t0 = time.time()
    df = run_scan(args.market)
    print(f"{len(df)} hisse tarandı ({time.time() - t0:.0f} sn)")
    _print_top(df if not args.market else df[df["market"] == args.market])


if __name__ == "__main__":
    main()
