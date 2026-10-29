"""Günlük fiyat verisi: yfinance ile toplu indirme, Parquet dosyasında saklama ve artımlı güncelleme."""
import time

import pandas as pd
import yfinance as yf

from .config import CHUNK_PAUSE_SEC, CHUNK_SIZE, DATA_DIR, HISTORY_PERIOD, UPDATE_PERIOD

PRICE_FILE = DATA_DIR / "prices_daily.parquet"
COLUMNS = ["Open", "High", "Low", "Close", "Volume"]
BIST_SPLIT_GAP = -0.25


def _download_chunk(symbols: list[str], period: str) -> pd.DataFrame:
    raw = yf.download(
        symbols, period=period, interval="1d", group_by="ticker",
        auto_adjust=True, threads=True, progress=False,
    )
    if raw.empty:
        return pd.DataFrame()
    # Uzun (long) format: date, yf_symbol, open, high, low, close, volume
    if isinstance(raw.columns, pd.MultiIndex):
        long = raw.stack(level=0, future_stack=True)
        long.index.names = ["date", "yf_symbol"]
        long = long.reset_index()
    else:
        long = raw.reset_index().rename(columns={"Date": "date"})
        long["yf_symbol"] = symbols[0]
    long = long.dropna(subset=["Close"])
    long = long[["date", "yf_symbol", *COLUMNS]]
    long.columns = ["date", "yf_symbol", "open", "high", "low", "close", "volume"]
    long["date"] = pd.to_datetime(long["date"]).dt.tz_localize(None).dt.normalize()
    return long


def download_prices(yf_symbols: list[str], period: str) -> pd.DataFrame:
    frames = []
    total = len(yf_symbols)
    for i in range(0, total, CHUNK_SIZE):
        chunk = yf_symbols[i:i + CHUNK_SIZE]
        try:
            frames.append(_download_chunk(chunk, period))
        except Exception as exc:  # Bir grup hata verirse taramanın tamamı durmasın
            print(f"  ! grup {i}-{i + len(chunk)} başarısız: {exc}")
        print(f"  {min(i + CHUNK_SIZE, total)}/{total} sembol işlendi")
        time.sleep(CHUNK_PAUSE_SEC)
    frames = [f for f in frames if not f.empty]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def fix_bist_splits(df: pd.DataFrame) -> pd.DataFrame:
    """yfinance BIST'teki bedelsiz sermaye artırımlarını her zaman düzeltmiyor.
    BIST'te günlük fiyat limiti ±%10 olduğu için açılışta %25'ten büyük bir aşağı boşluk
    bölünme kabul edilir ve önceki tüm fiyatlar aynı oranda geriye dönük düzeltilir."""
    bist = df["yf_symbol"].str.endswith(".IS")
    g = df[bist].sort_values(["yf_symbol", "date"]).copy()
    prev_close = g.groupby("yf_symbol")["close"].shift()
    ratio = (g["open"] / prev_close).where(g["open"] / prev_close - 1 < BIST_SPLIT_GAP, 1.0).fillna(1.0)
    # Her satırın faktörü = kendisinden SONRAKİ tüm bölünme oranlarının çarpımı
    rev_cum = ratio.iloc[::-1].groupby(g["yf_symbol"].iloc[::-1]).cumprod().iloc[::-1]
    factor = rev_cum / ratio
    for col in ("open", "high", "low", "close"):
        g[col] = g[col] * factor
    g["volume"] = g["volume"] / factor
    return pd.concat([df[~bist], g], ignore_index=True)


def update_prices(yf_symbols: list[str]) -> pd.DataFrame:
    """Dosya yoksa tüm geçmişi indirir; varsa sadece son dönemi çekip birleştirir."""
    if PRICE_FILE.exists():
        old = pd.read_parquet(PRICE_FILE)
        known = set(old["yf_symbol"].unique())
        new_syms = [s for s in yf_symbols if s not in known]
        fresh = download_prices([s for s in yf_symbols if s in known], UPDATE_PERIOD)
        if new_syms:
            fresh = pd.concat([fresh, download_prices(new_syms, HISTORY_PERIOD)], ignore_index=True)
        df = pd.concat([old, fresh], ignore_index=True)
        df = df.drop_duplicates(["date", "yf_symbol"], keep="last")
    else:
        df = download_prices(yf_symbols, HISTORY_PERIOD)
    df = fix_bist_splits(df)
    df = df.sort_values(["yf_symbol", "date"]).reset_index(drop=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(PRICE_FILE, index=False)
    return df


def load_prices() -> pd.DataFrame:
    return pd.read_parquet(PRICE_FILE)


def to_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Günlük mumları haftalık mumlara çevirir (orta vade analizi için)."""
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    return (
        daily.set_index("date")
        .groupby("yf_symbol")
        .resample("W-FRI")
        .agg(agg)
        .dropna(subset=["close"])
        .reset_index()
    )
