"""Günlük fiyat verisi: yfinance ile toplu indirme, Parquet dosyasında saklama ve artımlı güncelleme."""
import time

import pandas as pd
import yfinance as yf

from .config import CHUNK_PAUSE_SEC, CHUNK_SIZE, DATA_DIR, HISTORY_PERIOD, UPDATE_PERIOD

PRICE_FILE = DATA_DIR / "prices_daily.parquet"
COLUMNS = ["Open", "High", "Low", "Close", "Volume"]
BIST_SPLIT_GAP = -0.25
BIST_REVERSE_GAP = 0.35
# Yahoo toplu indirmede bazen bazı hisselerin son gününü göndermiyor (ör. 13 Kasım 2026'da ABD hisselerinin ~%37'si).
# Son bir haftada işlem görmüş ama son işlem günü eksik hisseler kısa bir beklemeden sonra yeniden istenir.
RETRY_PERIOD = "5d"
RETRY_PAUSE_SEC = 10
RETRY_RECENT_DAYS = 7
CONSENSUS_SHARE = 0.5  # piyasanın son günü: hisselerin en az yarısının fiyatı olan en yeni gün


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
    """yfinance BIST'teki bedelsiz sermaye artırımlarını ve ters bölünmeleri (pay birleştirme) her zaman düzeltmiyor.
    BIST'te günlük fiyat limiti ±%10 olduğu için açılışta %25'ten büyük bir aşağı boşluk bölünme, %35'ten büyük bir
    yukarı boşluk ters bölünme kabul edilir ve önceki tüm fiyatlar aynı oranda geriye dönük düzeltilir."""
    bist = df["yf_symbol"].str.endswith(".IS")
    g = df[bist].sort_values(["yf_symbol", "date"]).copy()
    prev_close = g.groupby("yf_symbol")["close"].shift()
    gap = g["open"] / prev_close - 1
    ratio = (g["open"] / prev_close).where((gap < BIST_SPLIT_GAP) | (gap > BIST_REVERSE_GAP), 1.0).fillna(1.0)
    # Her satırın faktörü = kendisinden SONRAKİ tüm bölünme oranlarının çarpımı
    rev_cum = ratio.iloc[::-1].groupby(g["yf_symbol"].iloc[::-1]).cumprod().iloc[::-1]
    factor = rev_cum / ratio
    for col in ("open", "high", "low", "close"):
        g[col] = g[col] * factor
    g["volume"] = g["volume"] / factor
    return pd.concat([df[~bist], g], ignore_index=True)


def _market_of(symbol: str) -> str:
    return "BIST" if symbol.endswith(".IS") else "US"


def market_last_day(df: pd.DataFrame, symbols: list[str]) -> dict[str, pd.Timestamp]:
    """Piyasa başına son işlem günü: son RETRY_RECENT_DAYS günde işlem gören hisselerin en az CONSENSUS_SHARE'inin
    fiyatı olan en yeni gün. (En büyük tarih değil: tarama gece yarısı civarında çalışınca Yahoo bazı hisselere yeni
    günün yarım/boş mumunu gönderiyor; birkaç hissenin tarihi bütün piyasanın son günü sayılırsa diğerlerinin hepsi
    "eski" görünür. Kasım 2026'da bu yüzden günlük tarama bir hafta yayınlanamadı.)"""
    stocks = [s for s in symbols if not any(ch in s for ch in "^=")]
    d = df[df["yf_symbol"].isin(stocks)][["yf_symbol", "date"]]
    if d.empty:
        return {}
    out = {}
    for market, g in d.groupby(d["yf_symbol"].map(_market_of)):
        recent = g[g["date"] >= g["date"].max() - pd.Timedelta(days=RETRY_RECENT_DAYS)]
        active = recent["yf_symbol"].nunique()
        counts = recent.groupby("date")["yf_symbol"].nunique().sort_index(ascending=False)
        ok = counts[counts >= CONSENSUS_SHARE * active]
        out[market] = ok.index[0] if len(ok) else g["date"].max()
    return out


def drop_partial_days(df: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    """Piyasanın son işlem gününden (market_last_day) sonraki mumlar atılır (yarım/boş gün; sonraki tarama yeniden
    indirir). Endeksler de kendi piyasasına göre; döviz (=) dokunulmaz."""
    last = market_last_day(df, symbols)
    if not last:
        return df
    fx = df["yf_symbol"].str.contains("=", regex=False)
    limit = df["yf_symbol"].map(lambda s: last.get(_market_of(s)))
    drop = ~fx & limit.notna() & (df["date"] > limit)
    if drop.any():
        days = sorted({d.date().isoformat() for d in df.loc[drop, "date"]})
        print(f"  yarım gün atıldı: {int(drop.sum())} mum ({', '.join(days)}; piyasanın son günü "
              f"{', '.join(f'{m} {d.date()}' for m, d in last.items())})")
    return df[~drop]


def missing_latest(df: pd.DataFrame, symbols: list[str]) -> list[str]:
    """Piyasasının son işlem gününün (market_last_day) fiyatı olmayan ama son RETRY_RECENT_DAYS günde işlem görmüş hisseler.
    Endeks ve döviz kodları (^, =) hariç: döviz hafta sonu da işlem görüp "son günü" kaydırabiliyor."""
    stocks = [s for s in symbols if not any(ch in s for ch in "^=")]
    last = df[df["yf_symbol"].isin(stocks)].groupby("yf_symbol")["date"].max()
    if last.empty:
        return []
    consensus = market_last_day(df, symbols)
    newest = pd.Series([consensus[_market_of(s)] for s in last.index], index=last.index)
    return last[(last < newest) & (last >= newest - pd.Timedelta(days=RETRY_RECENT_DAYS))].index.tolist()


def _retry_missing(df: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    missing = missing_latest(df, symbols)
    if not missing:
        return df
    print(f"  {len(missing)} hissenin son işlem günü eksik; yeniden indiriliyor...")
    time.sleep(RETRY_PAUSE_SEC)
    fresh = download_prices(missing, RETRY_PERIOD)
    if len(fresh):
        df = pd.concat([df, fresh], ignore_index=True).drop_duplicates(["date", "yf_symbol"], keep="last")
    print(f"  yeniden indirme sonrası hâlâ eksik: {len(missing_latest(df, symbols))}")
    return df


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
    df = _retry_missing(df, yf_symbols)
    df = drop_partial_days(df, yf_symbols)
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
