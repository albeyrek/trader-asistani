"""Sinyal karnesi (ileriye dönük test).

Her günlük çalıştırmada "Güçlü Yükseliş" listesinin en yüksek skorlu N hissesi ve "Güçlü Düşüş" listesinin en düşük
skorlu N hissesi kaydedilir. 5, 10 ve 20 işlem günü sonra bu hisselerin, aynı piyasadaki medyan hisseye göre getirisi
ölçülür. Backtest geçmişe bakar; bu karne modelin canlı (gerçek zamanlı) başarısını gösterir.

Geçmiş data/signals_history.json'da tutulur (GitHub Actions önbelleği). Önbellek silinirse bir önceki yayından
(GitHub Pages) geri yüklenir.
"""
import json

import numpy as np
import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS

HISTORY_FILE = DATA_DIR / "signals_history.json"
PAGES_HISTORY_URL = "https://albeyrek.github.io/trader-asistani/data/signals_history.json"
TOP_N = 20
HORIZONS = (5, 10, 20)
RECENT = 5
MAX_SNAPSHOTS = 400  # ≈ piyasa başına 200 gün


def load_history() -> list[dict]:
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    try:  # önbellek boşsa son yayından devam et
        r = requests.get(PAGES_HISTORY_URL, headers=HTTP_HEADERS, timeout=30)
        if r.ok:
            return r.json()
    except (requests.RequestException, ValueError):
        pass
    return []


def record(history: list[dict], scan: pd.DataFrame) -> list[dict]:
    """Bugünün listelerini ekler; aynı (piyasa, tarih) varsa yeniler."""
    for market, g in scan.groupby("market"):
        date = str(g["date"].max())
        g = g[g["date"] == date]
        up = g[g["outlook"] == "Güçlü Yükseliş"].nlargest(TOP_N, "combined_score")
        down = g[g["outlook"] == "Güçlü Düşüş"].nsmallest(TOP_N, "combined_score")
        snap = {
            "market": market, "date": date,
            "up": [{"symbol": r.symbol, "yf": r.yf_symbol, "close": float(r.close), "score": float(r.combined_score)}
                   for r in up.itertuples()],
            "down": [{"symbol": r.symbol, "yf": r.yf_symbol, "close": float(r.close), "score": float(r.combined_score)}
                     for r in down.itertuples()],
        }
        history = [h for h in history if not (h["market"] == market and h["date"] == date)] + [snap]
    history.sort(key=lambda h: (h["date"], h["market"]))
    return history[-MAX_SNAPSHOTS:]


def save_history(history: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")


def evaluate(history: list[dict], prices: pd.DataFrame, scan: pd.DataFrame) -> dict:
    out: dict[str, dict] = {}
    for market, g in scan.groupby("market"):
        snaps = [h for h in history if h["market"] == market]
        px = (prices[prices["yf_symbol"].isin(g["yf_symbol"])]
              .pivot(index="date", columns="yf_symbol", values="close").sort_index().ffill(limit=3))
        dates = px.index
        stats = {side: {f"h{h}": [] for h in HORIZONS} for side in ("up", "down")}
        recent = []
        for snap in snaps:
            pos = dates.searchsorted(pd.Timestamp(snap["date"]), side="right") - 1
            if pos < 0:
                continue
            for h in HORIZONS:
                if pos + h >= len(dates):
                    continue
                base = px.iloc[pos + h] / px.iloc[pos] - 1
                median = float(base.median())
                for side in ("up", "down"):
                    for p in snap[side]:
                        r = base.get(p["yf"])
                        if r is not None and np.isfinite(r):
                            stats[side][f"h{h}"].append(float(r) - median)
        for snap in snaps[-RECENT:]:
            pos = dates.searchsorted(pd.Timestamp(snap["date"]), side="right") - 1
            if pos < 0:
                continue
            now = px.iloc[-1] / px.iloc[pos] - 1
            median = float(now.median())
            days = len(dates) - 1 - pos

            def picks(side: str) -> list[dict]:
                rows = []
                for p in snap[side][:10]:
                    r = now.get(p["yf"])
                    if r is not None and np.isfinite(r):
                        rows.append({"symbol": p["symbol"], "ret": round(float(r) * 100, 2),
                                     "excess": round((float(r) - median) * 100, 2)})
                return rows
            recent.append({"date": snap["date"], "days": int(days), "up": picks("up"), "down": picks("down")})

        def summarize(xs: list[float], side: str) -> dict:
            if not xs:
                return {"n": 0, "avg_excess": None, "hit": None}
            a = np.array(xs)
            hit = (a > 0).mean() if side == "up" else (a < 0).mean()
            return {"n": int(len(a)), "avg_excess": round(float(a.mean()) * 100, 2), "hit": round(float(hit) * 100, 1)}

        out[market] = {
            "snapshots": len(snaps),
            "first_date": snaps[0]["date"] if snaps else None,
            "last_date": snaps[-1]["date"] if snaps else None,
            "up": {k: summarize(v, "up") for k, v in stats["up"].items()},
            "down": {k: summarize(v, "down") for k, v in stats["down"].items()},
            "recent": list(reversed(recent)),
        }
    return out
