"""Uzun fiyat geçmişi (öğrenme için): python -m scanner.history

Günlük tarama 2 yıllık veriyle çalışır (prices_daily.parquet). Öğrenen asistan ise farklı piyasa dönemlerini (2018
satışı, 2020 çöküşü, 2022 ayı piyasası, sonraki boğa) görmek için LONG_PERIOD kadar geçmişle eğitilir. Bu dosya her
hafta baştan indirilir: yfinance geçmişe dönük bölünme/temettü düzeltmelerini değiştirebildiği için artımlı birleştirme
eski ve yeni fiyatları karıştırabilir.

Not: Evren bugün listede olan likit hisselerdir; geçmişte borsadan çıkan hisseler veride yoktur (hayatta kalan
yanlılığı). Bu, geçmiş sonuçları bir miktar iyimser gösterebilir.
"""
import time

import pandas as pd

from .config import DATA_DIR, INDEX_SYMBOLS
from .prices import download_prices, fix_bist_splits
from .scan import scan_universe

LONG_FILE = DATA_DIR / "prices_long.parquet"
LONG_PERIOD = "10y"
MIN_KEEP_RATIO = 0.8   # yeni indirme eski dosyadaki hisselerin %80'inden azını getirirse eski dosya korunur


def update_long() -> pd.DataFrame:
    meta = scan_universe(None)
    symbols = sorted(set(meta.index) | {s for idx in INDEX_SYMBOLS.values() for s in idx})
    t0 = time.time()
    df = download_prices(symbols, LONG_PERIOD)
    got = df["yf_symbol"].nunique() if len(df) else 0
    print(f"{got}/{len(symbols)} sembol, {len(df):,} satır ({time.time() - t0:.0f} sn)")
    if LONG_FILE.exists():
        old_n = pd.read_parquet(LONG_FILE, columns=["yf_symbol"])["yf_symbol"].nunique()
        if got < MIN_KEEP_RATIO * old_n:
            print(f"  ! indirme eksik ({got} < {old_n}); önceki uzun geçmiş korunuyor")
            return pd.read_parquet(LONG_FILE)
    df = fix_bist_splits(df).sort_values(["yf_symbol", "date"]).reset_index(drop=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(LONG_FILE, index=False)
    return df


def load_long() -> pd.DataFrame:
    return pd.read_parquet(LONG_FILE)


if __name__ == "__main__":
    out = update_long()
    print(f"Uzun geçmiş: {out['date'].min().date()} – {out['date'].max().date()}, {out['yf_symbol'].nunique()} sembol")
