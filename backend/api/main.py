"""Mobil uygulamanın kullandığı API (yerel çalıştırma; bulutta aynı veri GitHub Pages'ten statik dosya olarak sunulur).

Çalıştırma (backend klasöründe):
    .venv\\Scripts\\python.exe -m uvicorn api.main:app --host 0.0.0.0 --port 8000
Telefon, bilgisayarla aynı Wi-Fi ağındaysa http://<bilgisayarın IP adresi>:8000 adresinden bağlanır.
"""
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from scanner import views
from scanner.config import DATA_DIR
from scanner.devices import upsert_device
from scanner.prices import PRICE_FILE, to_weekly

app = FastAPI(title="Trader Asistanı API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

SCAN_FILE = DATA_DIR / "scan_results.parquet"
NEWS_FILE = DATA_DIR / "news_items.parquet"

_cache: dict[str, tuple[float, pd.DataFrame]] = {}


def _load(path: Path) -> pd.DataFrame:
    """Parquet dosyasını bellekte tutar; dosya değişince (günlük çalıştırma sonrası) yeniden okur."""
    if not path.exists():
        raise HTTPException(503, f"{path.name} bulunamadı. Önce 'python -m scanner.daily' çalıştırın.")
    mtime = path.stat().st_mtime
    hit = _cache.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    df = pd.read_parquet(path)
    _cache[str(path)] = (mtime, df)
    return df


@app.get("/api/meta")
def meta():
    return views.meta(_load(SCAN_FILE), pd.Timestamp(SCAN_FILE.stat().st_mtime, unit="s", tz="UTC"))


@app.get("/api/scan")
def scan_list(
    market: str = Query("BIST", pattern="^(BIST|US)$"),
    view: str = Query("up", alias="list", pattern="^(up|down|alerts|all)$"),
    q: str = "",
    limit: int = Query(50, ge=1, le=500),
):
    df = _load(SCAN_FILE)
    df = df[df["market"] == market]
    if q:
        ql = q.strip().upper()
        df = df[df["symbol"].str.upper().str.contains(ql, regex=False)
                | df["name"].str.upper().str.contains(ql, regex=False)]
    if view == "up":
        df = df.sort_values("combined_score", ascending=False)
    elif view == "down":
        df = df.sort_values("combined_score", ascending=True)
    elif view == "alerts":
        df = df[df["alerts"].fillna("[]") != "[]"].sort_values("combined_score")
    else:
        df = df.sort_values("symbol")
    return {"total": len(df), "items": [views.row(r, views.LIST_FIELDS) for _, r in df.head(limit).iterrows()]}


@app.get("/api/stocks")
def stocks(symbols: str):
    """İzleme listesi için: virgülle ayrılmış kodlar (örn. THYAO,AAPL)."""
    wanted = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    df = _load(SCAN_FILE)
    df = df[df["symbol"].str.upper().isin(wanted)]
    order = {s: i for i, s in enumerate(wanted)}
    df = df.assign(_o=df["symbol"].str.upper().map(order)).sort_values("_o")
    return {"items": [views.row(r, views.LIST_FIELDS) for _, r in df.iterrows()]}


class WatchItem(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    market: str = Field(pattern="^(BIST|US)$")


class DeviceIn(BaseModel):
    token: str = Field(pattern=r"^Expo(nent)?PushToken\[.+\]$", max_length=200)
    watchlist: list[WatchItem] = Field(default_factory=list, max_length=200)
    notify_all_severe: bool = True
    platform: str = "android"


@app.post("/api/devices")
def register_device(d: DeviceIn):
    """Uygulama, bildirim adresini ve izleme listesini buraya kaydeder; haber bekçisi bunları kullanır."""
    upsert_device(d.token, [w.model_dump() for w in d.watchlist], d.notify_all_severe, d.platform)
    return {"ok": True, "watching": len(d.watchlist)}


@app.get("/api/stock/{symbol}")
def stock(symbol: str, market: str | None = None):
    df = _load(SCAN_FILE)
    m = df[df["symbol"].str.upper() == symbol.upper()]
    if market:
        m = m[m["market"] == market]
    if m.empty:
        raise HTTPException(404, f"{symbol} bulunamadı")
    r = m.iloc[0]
    prices = _load(PRICE_FILE)
    sp = prices[prices["yf_symbol"] == r["yf_symbol"]]
    news = None
    if NEWS_FILE.exists():
        n = _load(NEWS_FILE)
        news = n[(n["symbol"] == r["symbol"]) & (n["market"] == r["market"])]
    return views.stock_detail(r, sp, to_weekly(sp), news)
