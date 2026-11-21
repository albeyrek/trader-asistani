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
OPTIONAL_FIELDS = ("atr", "exit_rule")  # eski kayıtlarda yok


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
        snap = {"market": market, "date": v["date"], "regime": v["regime"]["label"], "risk_scale": v.get("risk_scale", 1.0),
                "candidates": [{**{k: c[k] for k in PLAN_FIELDS}, **{k: c[k] for k in OPTIONAL_FIELDS if k in c},
                                "yf": yf_of.get(f"{market}:{c['symbol']}")}
                               for c in v["candidates"]]}
        history = [h for h in history if not (h["market"] == market and h["date"] == v["date"])] + [snap]
    history.sort(key=lambda h: (h["date"], h["market"]))
    return history[-MAX_SNAPSHOTS:]


BASE_RULE = {"name": "base", "target": "plan", "hold": MAX_HOLD}


def run_exit(o, h, l, c, fill_i: int, fill: float, stop: float, target: float | None, hold: int, atr: float,
             trail: float | None = None, breakeven: float | None = None, partial: float | None = None):
    """Bir pozisyonun çıkışı: (R, tutulan gün, çıkış fiyatı, nasıl: "stop" | "target" | "end").
    trail: iz süren stop (en yüksek kapanış - trail x ATR); breakeven: bu kadar R kârda stop girişe çekilir;
    partial: pozisyonun yarısı bu kadar R kârda kapatılır. Aynı gün hem stop hem hedef olursa temkinli olarak stop."""
    risk = fill - stop
    end = min(len(c), fill_i + hold)
    cur_stop, peak, r_locked, weight, half_done = stop, fill, 0.0, 1.0, False
    for t in range(fill_i, end):
        first = t == fill_i
        if trail:
            cur_stop = max(cur_stop, peak - trail * atr)
        if l[t] <= cur_stop:
            px = o[t] if (not first and o[t] < cur_stop) else cur_stop
            return r_locked + weight * (px - fill) / risk, t - fill_i + 1, px, "stop"
        if partial and not half_done and h[t] >= fill + partial * risk:
            r_locked, weight, half_done = 0.5 * partial, 0.5, True
        if target is not None and h[t] >= target:
            px = o[t] if (not first and o[t] > target) else target
            return r_locked + weight * (px - fill) / risk, t - fill_i + 1, px, "target"
        if breakeven and h[t] >= fill + breakeven * risk:
            cur_stop = max(cur_stop, fill)
        peak = max(peak, c[t])
    t = end - 1
    return r_locked + weight * (c[t] - fill) / risk, end - fill_i, c[t], "end"


def simulate(c: dict, bars: pd.DataFrame) -> dict:
    """bars: sinyal gününden SONRAKİ günlük mumlar (date, open, high, low, close), eskiden yeniye.
    c["exit_rule"] yoksa temel plan (ilk hedef, MAX_HOLD gün) uygulanır."""
    rule = c.get("exit_rule") or BASE_RULE
    lo, hi, stop = c["entry_low"], c["entry_high"], c["stop"]
    out = {"status": "pending", "days": 0, "r": None, "fill": None, "exit": None, "exit_date": None}
    o, h, l, cl = (bars[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    dates = bars["date"].to_numpy()
    fill_i = None
    for i in range(min(ENTRY_DAYS, len(cl))):
        if l[i] <= hi and h[i] >= lo:
            fill_i, out["fill"] = i, round(float(min(max(o[i], lo), hi)), 4)
            break
    if fill_i is None:
        out["status"] = "not_filled" if len(bars) >= ENTRY_DAYS else "pending"
        return out
    fill = out["fill"]
    risk = fill - stop
    if risk <= 0:
        out["status"] = "not_filled"
        return out
    target = c["target1"] if rule["target"] == "plan" else (fill + rule["target"] * risk if rule["target"] else None)
    atr = float(c.get("atr") or 0) or risk / 1.5
    r, days, px, how = run_exit(o, h, l, cl, fill_i, fill, stop, target, rule["hold"], atr,
                                rule.get("trail"), rule.get("breakeven"), rule.get("partial"))
    exit_date = pd.Timestamp(dates[fill_i + days - 1]).date().isoformat()
    if how == "end":
        status = "timeout" if days >= rule["hold"] else "open"
    elif how == "target":
        status = "target"
    else:  # iz süren stop kârda tetiklenebilir
        status = "trail" if r > 0 else "stop"
    res = {**out, "status": status, "days": int(days), "r": round(float(r), 2),
           "exit": round(float(px), 4) if status != "open" else None, "exit_date": exit_date if status != "open" else None}
    if status == "open":
        res["last"] = round(float(px), 4)
    return res


def _busy_until(h_date: str, res: dict) -> str:
    """Bu öneri hangi güne kadar "aynı hissede süren plan" sayılır: açık ya da giriş bekliyorsa süresiz, kapandıysa
    çıkış günü, girilmediyse giriş penceresinin sonu."""
    if res["status"] in ("open", "pending"):
        return "9999-12-31"
    if res["status"] == "not_filled":
        return (pd.Timestamp(h_date) + pd.offsets.BDay(ENTRY_DAYS)).date().isoformat()
    return res["exit_date"] or h_date


def trades_of(history: list[dict], prices: pd.DataFrame, market: str) -> list[dict]:
    """Bir piyasanın öneri geçmişinden işlemler. Önceki planı hâlâ sürerken (açık ya da giriş bekliyor) aynı hisse
    yeniden listelendiyse yeni işlem sayılmaz ("repeat"): aynı pozisyon birden çok kez sayılıp karne şişmesin (Kasım
    2026'da PACS üç gün üst üste listelendi ve karnede üç ayrı stop göründü)."""
    yfs = {c["yf"] for h in history for c in h["candidates"] if c.get("yf")}
    px = prices[prices["yf_symbol"].isin(yfs)].sort_values("date")
    by = dict(tuple(px.groupby("yf_symbol")))
    trades, busy = [], {}
    for h in sorted((x for x in history if x["market"] == market), key=lambda x: x["date"]):
        for c in h["candidates"]:
            bars = by.get(c.get("yf"))
            if bars is None:
                continue
            base = {"date": h["date"], "symbol": c["symbol"], "setup": c["setup"], "regime": h.get("regime"),
                    "planned_rr": c.get("rr")}
            prev = busy.get(c["symbol"])
            if prev and h["date"] <= prev[0]:
                trades.append({**base, "status": "repeat", "repeat_of": prev[1], "days": 0, "r": None, "fill": None,
                               "exit": None, "exit_date": None})
                continue
            res = simulate(c, bars[bars["date"] > pd.Timestamp(h["date"])])
            busy[c["symbol"]] = (_busy_until(h["date"], res), h["date"])
            trades.append({**base, **res})
    return trades


def active_plans(history: list[dict], prices: pd.DataFrame, market: str, today: str) -> dict[str, dict]:
    """Bugün hâlâ süren planlar: hisse -> {"since": ilk listelendiği gün, "status": "open" | "pending"} (bugünkü listede
    aynı hisse "devam eden plan, yeniden alma" diye işaretlenir)."""
    out = {}
    for t in trades_of(history, prices[prices["date"] <= pd.Timestamp(today)], market):  # yalnızca bugüne kadar
        if t["status"] in ("open", "pending") and t["date"] < today:
            out[t["symbol"]] = {"since": t["date"], "status": t["status"], "fill": t.get("fill")}
        elif t["status"] == "not_filled" and _busy_until(t["date"], t) >= today and t["date"] < today:
            out[t["symbol"]] = {"since": t["date"], "status": "pending", "fill": None}
    return out


def evaluate(history: list[dict], prices: pd.DataFrame) -> dict:
    out: dict[str, dict] = {}
    for market in sorted({h["market"] for h in history}):
        all_trades = trades_of(history, prices, market)
        repeats = sum(t["status"] == "repeat" for t in all_trades)
        trades = [t for t in all_trades if t["status"] != "repeat"]
        closed = [t for t in trades if t["status"] in ("stop", "target", "timeout", "trail")]
        rs = np.array([t["r"] for t in closed], dtype=float)
        wins = sum(t["r"] > 0 for t in closed)
        out[market] = {
            "snapshots": sum(1 for x in history if x["market"] == market),
            "first_date": next((x["date"] for x in history if x["market"] == market), None),
            "signals": len(trades),
            "repeats": repeats,  # süren plan varken yeniden listelenip ayrı sayılmayan öneriler
            "filled": sum(t["status"] != "not_filled" and t["fill"] is not None for t in trades),
            "not_filled": sum(t["status"] == "not_filled" for t in trades),
            "open": sum(t["status"] == "open" for t in trades),
            "closed": len(closed),
            "targets": sum(t["status"] == "target" for t in closed),
            "stops": sum(t["status"] == "stop" for t in closed),
            "trails": sum(t["status"] == "trail" for t in closed),  # iz süren stopla kârla çıkış
            "timeouts": sum(t["status"] == "timeout" for t in closed),
            "win_rate": round(wins / len(closed) * 100, 1) if closed else None,
            "avg_r": round(float(rs.mean()), 2) if len(rs) else None,
            "total_r": round(float(rs.sum()), 2) if len(rs) else None,
            "closed_rs": [round(float(x), 3) for x in rs],  # sapma alarmı için (health.drift)
            "trades": list(reversed(all_trades))[:RECENT_TRADES],
        }
    return out
