"""Asistan karnesi: geçmiş günlerin alım adayları plana uyulsaydı ne olurdu?

Her aday için sonraki günlük mumlar gezilir:
  - giriş: ilk ENTRY_DAYS gün içinde fiyat giriş bölgesine girerse (açılış bölge içindeyse açılıştan, değilse bölge
    sınırından) alınmış sayılır; girmezse "girilmedi".
  - çıkış: önce stop gelirse zarar, önce ilk hedef gelirse kâr (aynı gün ikisi de olursa temkinli olarak stop sayılır;
    stopun altında açılırsa açılıştan çıkılır). MAX_HOLD gün içinde ikisi de olmazsa son kapanıştan "süre doldu".
Sonuç "R" ile ölçülür: 1R = giriş ile stop arasındaki mesafe. +2R, riske edilen tutarın iki katı kâr demektir.

Geçmiş data/assistant_history.json'da (GitHub Actions önbelleği) tutulur; önbellek silinirse son yayından yüklenir.
"""
import json

import numpy as np
import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS

HISTORY_FILE = DATA_DIR / "assistant_history.json"
PAGES_HISTORY_URL = "https://albeyrek.github.io/trader-asistani/data/assistant_history.json"
ENTRY_DAYS = 5
MAX_HOLD = 20
MAX_SNAPSHOTS = 400
RECENT_TRADES = 30
PLAN_FIELDS = ("symbol", "setup", "entry_low", "entry_high", "stop", "target1", "close", "rr")


def load_history() -> list[dict]:
    if HISTORY_FILE.exists():
        try:
            return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    try:
        r = requests.get(PAGES_HISTORY_URL, headers=HTTP_HEADERS, timeout=30)
        if r.ok:
            return r.json()
    except (requests.RequestException, ValueError):
        pass
    return []


def save_history(history: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")


def record(history: list[dict], assistant: dict, yf_of: dict[str, str]) -> list[dict]:
    """Bugünün adaylarını ekler; aynı (piyasa, tarih) varsa yeniler. yf_of: "PİYASA:KOD" -> yahoo kodu."""
    for market, v in assistant["markets"].items():
        snap = {"market": market, "date": v["date"], "regime": v["regime"]["label"],
                "candidates": [{**{k: c[k] for k in PLAN_FIELDS}, "yf": yf_of.get(f"{market}:{c['symbol']}")}
                               for c in v["candidates"]]}
        history = [h for h in history if not (h["market"] == market and h["date"] == v["date"])] + [snap]
    history.sort(key=lambda h: (h["date"], h["market"]))
    return history[-MAX_SNAPSHOTS:]


def simulate(c: dict, bars: pd.DataFrame) -> dict:
    """bars: sinyal gününden SONRAKİ günlük mumlar (date, open, high, low, close), eskiden yeniye."""
    lo, hi, stop, t1 = c["entry_low"], c["entry_high"], c["stop"], c["target1"]
    out = {"status": "pending", "days": 0, "r": None, "fill": None, "exit": None, "exit_date": None}
    fill_i = None
    for i, b in enumerate(bars.head(ENTRY_DAYS).itertuples()):
        if b.low <= hi and b.high >= lo:
            fill = min(max(b.open, lo), hi)
            fill_i, out["fill"] = i, round(float(fill), 4)
            break
    if fill_i is None:
        out["status"] = "not_filled" if len(bars) >= ENTRY_DAYS else "pending"
        return out
    risk = out["fill"] - stop
    if risk <= 0:
        out["status"] = "not_filled"
        return out
    held = bars.iloc[fill_i:fill_i + MAX_HOLD]
    for j, b in enumerate(held.itertuples()):
        first = j == 0
        # Giriş günü: açılış bölgenin altındaysa stop kontrolü girişten sonra anlamlı; temkinli olarak yine kontrol et
        if b.low <= stop:
            px = b.open if (not first and b.open < stop) else stop
            return {**out, "status": "stop", "days": j + 1, "r": round((px - out["fill"]) / risk, 2),
                    "exit": round(float(px), 4), "exit_date": pd.Timestamp(b.date).date().isoformat()}
        if b.high >= t1:
            px = b.open if (not first and b.open > t1) else t1
            return {**out, "status": "target", "days": j + 1, "r": round((px - out["fill"]) / risk, 2),
                    "exit": round(float(px), 4), "exit_date": pd.Timestamp(b.date).date().isoformat()}
    last = held.iloc[-1]
    r = round((float(last["close"]) - out["fill"]) / risk, 2)
    status = "timeout" if len(held) >= MAX_HOLD else "open"
    return {**out, "status": status, "days": len(held), "r": r,
            "exit": round(float(last["close"]), 4) if status == "timeout" else None,
            "exit_date": pd.Timestamp(last["date"]).date().isoformat() if status == "timeout" else None,
            "last": round(float(last["close"]), 4)}


def evaluate(history: list[dict], prices: pd.DataFrame) -> dict:
    yfs = {c["yf"] for h in history for c in h["candidates"] if c.get("yf")}
    px = prices[prices["yf_symbol"].isin(yfs)].sort_values("date")
    by = dict(tuple(px.groupby("yf_symbol")))
    out: dict[str, dict] = {}
    for market in sorted({h["market"] for h in history}):
        trades = []
        for h in (x for x in history if x["market"] == market):
            for c in h["candidates"]:
                bars = by.get(c.get("yf"))
                if bars is None:
                    continue
                res = simulate(c, bars[bars["date"] > pd.Timestamp(h["date"])])
                trades.append({"date": h["date"], "symbol": c["symbol"], "setup": c["setup"],
                               "regime": h.get("regime"), "planned_rr": c.get("rr"), **res})
        closed = [t for t in trades if t["status"] in ("stop", "target", "timeout")]
        rs = np.array([t["r"] for t in closed], dtype=float)
        wins = sum(t["r"] > 0 for t in closed)
        out[market] = {
            "snapshots": sum(1 for x in history if x["market"] == market),
            "first_date": next((x["date"] for x in history if x["market"] == market), None),
            "signals": len(trades),
            "filled": sum(t["status"] != "not_filled" and t["fill"] is not None for t in trades),
            "not_filled": sum(t["status"] == "not_filled" for t in trades),
            "open": sum(t["status"] == "open" for t in trades),
            "closed": len(closed),
            "targets": sum(t["status"] == "target" for t in closed),
            "stops": sum(t["status"] == "stop" for t in closed),
            "timeouts": sum(t["status"] == "timeout" for t in closed),
            "win_rate": round(wins / len(closed) * 100, 1) if closed else None,
            "avg_r": round(float(rs.mean()), 2) if len(rs) else None,
            "total_r": round(float(rs.sum()), 2) if len(rs) else None,
            "trades": list(reversed(trades))[:RECENT_TRADES],
        }
    return out
