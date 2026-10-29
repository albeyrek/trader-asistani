"""Grafik asistanı: çoklu destek/direnç seviyeleri, trend çizgileri, dönem getirileri ve Türkçe yorumlar.

Sadece gösterim içindir; teknik skoru (signals.py) etkilemez ve backtest'e girmez.
"""
import numpy as np
import pandas as pd

from .indicators import atr as atr_series
from .patterns import Pivots, find_pivots

N_LEVELS = 3               # fiyatın altında ve üstünde gösterilecek seviye sayısı
CLUSTER_ATR = 0.6          # bu kadar ATR içindeki tepe/dipler aynı seviye sayılır
CLUSTER_MIN_PCT = 0.015    # ... ya da fiyatın %1,5'i (düşük oynaklıkta seviyeler birleşsin)
TREND_MIN_GAP = 10         # trend çizgisinin iki noktası arasında en az bu kadar mum
TREND_TOL_ATR = 0.3        # aradaki mumlar çizgiyi bu kadar delebilir
PERIODS = {"1H": 5, "1A": 21, "3A": 63, "6A": 126, "1Y": 252}


def _date(df: pd.DataFrame, i: int) -> str:
    return pd.Timestamp(df["date"].iloc[i]).date().isoformat()


def price_levels(df: pd.DataFrame, piv: Pivots, atr: float, lookback: int) -> dict:
    """Tepe ve dipleri kümeleyip fiyatın altındaki (destek) ve üstündeki (direnç) en yakın seviyeleri verir.
    Eski bir direnç kırıldıysa destek olarak da görünebilir (ve tersi)."""
    n = len(df)
    close = float(df["close"].iloc[-1])
    start = max(0, n - lookback)
    pts = [(float(df["low"].iloc[i]), i) for i in piv.lows if i >= start]
    pts += [(float(df["high"].iloc[i]), i) for i in piv.highs if i >= start]
    if not pts:
        return {"supports": [], "resistances": []}
    pts.sort()
    width = max(CLUSTER_ATR * atr, CLUSTER_MIN_PCT * close)
    clusters: list[list[tuple[float, int]]] = [[pts[0]]]
    for p in pts[1:]:
        if p[0] - clusters[-1][-1][0] <= width:
            clusters[-1].append(p)
        else:
            clusters.append([p])

    levels = []
    for c in clusters:
        price = float(np.mean([p for p, _ in c]))
        last = max(i for _, i in c)
        levels.append({
            "price": round(price, 4),
            "touches": len(c),
            "dist_pct": round((price / close - 1) * 100, 2),
            "last_date": _date(df, last),
        })
    supports = sorted([lv for lv in levels if lv["price"] < close * 0.995], key=lambda lv: -lv["price"])[:N_LEVELS]
    resistances = sorted([lv for lv in levels if lv["price"] > close * 1.005], key=lambda lv: lv["price"])[:N_LEVELS]
    return {"supports": supports, "resistances": resistances}


TREND_PIVOTS = 12          # denenecek son tepe/dip sayısı
TREND_BREAK_BARS = 5       # çizgi ancak son bu kadar mumda delinmişse "yeni kırılım" sayılır
TREND_MAX_DIST_ATR = 4     # bugünkü çizgi değeri fiyattan bu kadar ATR'den uzaksa gösterilmez
TREND_MAX_SLOPE_PCT = 25   # 21 mumda %25'ten dik çizgiler anlamsız sayılır


def trendline(df: pd.DataFrame, piv: Pivots, atr: float, kind: str, lookback: int) -> dict | None:
    """Destek (diplerden) ya da direnç (tepelerden) trend çizgisi.

    Son tepe/dip çiftlerinin hepsi denenir. Geçerli çizgi: başlangıcından bugüne kadar fiyat çizgiyi ciddi
    delmemiş (son birkaç mum hariç: o zaman "kırıldı" sayılır) ve bugünkü değeri fiyata makul uzaklıkta.
    Geçerliler arasından en çok temas eden ve en uzun süre geçerli kalan çizgi seçilir."""
    n = len(df)
    start = max(0, n - lookback)
    if kind == "support":
        idx, values = piv.lows[piv.lows >= start], df["low"].to_numpy()
    else:
        idx, values = piv.highs[piv.highs >= start], df["high"].to_numpy()
    idx = idx[-TREND_PIVOTS:]
    if idx.size < 2:
        return None
    tol = TREND_TOL_ATR * atr
    close = float(df["close"].iloc[-1])
    hold_end = n - TREND_BREAK_BARS  # bu indekse kadar çizgi korunmuş olmalı
    best, best_score = None, -1.0
    for i, a in enumerate(idx[:-1]):
        for b in idx[i + 1:]:
            a, b = int(a), int(b)
            if b - a < TREND_MIN_GAP:
                continue
            slope = (values[b] - values[a]) / (b - a)
            end_value = values[a] + slope * (n - 1 - a)
            if end_value <= 0 or abs(end_value - close) > TREND_MAX_DIST_ATR * atr:
                continue
            if abs(slope * 21 / end_value * 100) > TREND_MAX_SLOPE_PCT:
                continue
            x = np.arange(a, hold_end)
            if x.size:
                line = values[a] + slope * (x - a)
                seg = values[a:hold_end]
                if ((seg < line - tol) if kind == "support" else (seg > line + tol)).any():
                    continue
            touches = int(sum(abs(values[j] - (values[a] + slope * (j - a))) <= tol for j in idx if j >= a))
            score = touches + (n - a) / lookback  # temas sayısı öncelikli, eşitlikte daha uzun çizgi
            if score > best_score:
                best_score = score
                best = (a, slope, float(end_value), touches)
    if best is None:
        return None
    a, slope, end_value, touches = best
    return {
        "kind": kind,
        "start": {"d": _date(df, a), "price": round(float(values[a]), 4)},
        "end": {"d": _date(df, n - 1), "price": round(end_value, 4)},
        # eğim: 21 mumdaki değişimin bugünkü çizgi değerine oranı (%); günlükte ≈ aylık
        "slope_pct": round(slope * 21 / end_value * 100, 2),
        "touches": touches,
        "broken": bool(close < end_value) if kind == "support" else bool(close > end_value),
        "dist_pct": round((end_value / close - 1) * 100, 2),
    }


def analyze_levels(df: pd.DataFrame, lookback: int) -> dict:
    df = df.sort_values("date").reset_index(drop=True)
    if len(df) < 30:
        return {"supports": [], "resistances": [], "trendlines": []}
    a = float(atr_series(df).iloc[-1])
    piv = find_pivots(df)
    out = price_levels(df, piv, a, lookback)
    out["trendlines"] = [t for t in (trendline(df, piv, a, k, lookback) for k in ("support", "resistance")) if t]
    return out


def performance(daily: pd.DataFrame) -> dict:
    c = daily.sort_values("date")["close"].to_numpy()
    return {k: round(float(c[-1] / c[-1 - n] - 1) * 100, 2) if len(c) > n else None for k, n in PERIODS.items()}


def _fmt(v: float) -> str:
    digits = 0 if abs(v) >= 1000 else 2 if abs(v) >= 10 else 3
    return f"{v:,.{digits}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _pct(v: float) -> str:
    """Türkçe yüzde: %11,0"""
    return f"%{abs(v):.1f}".replace(".", ",")


def insights(daily_levels: dict, weekly_levels: dict, perf: dict, close: float, high52: float, low52: float) -> list[str]:
    """Grafiği okuyan bir asistan gibi kısa Türkçe notlar."""
    notes: list[str] = []
    for t in daily_levels.get("trendlines", []):
        direction = "yükselen" if t["slope_pct"] > 0.5 else "düşen" if t["slope_pct"] < -0.5 else "yatay"
        if t["kind"] == "support":
            if t["broken"]:
                notes.append(f"{direction.capitalize()} destek trend çizgisi aşağı kırıldı ({_fmt(t['end']['price'])}); "
                             "çizginin altında kalınırsa zayıflık sürebilir.")
            else:
                notes.append(f"Fiyat {direction} destek trend çizgisinin {_pct(t['dist_pct'])} üzerinde "
                             f"({_fmt(t['end']['price'])}, {t['touches']} temas).")
        else:
            if t["broken"]:
                notes.append(f"{direction.capitalize()} direnç trend çizgisi yukarı kırıldı ({_fmt(t['end']['price'])}); "
                             "kırılımın kalıcılığı takip edilmeli.")
            else:
                notes.append(f"Fiyatın {_pct(t['dist_pct'])} yukarısında {direction} direnç trend çizgisi var "
                             f"({_fmt(t['end']['price'])}, {t['touches']} temas); üzerinde kapanış olumlu sinyal olur.")
    sup, res = daily_levels.get("supports", []), daily_levels.get("resistances", [])
    if sup:
        s = sup[0]
        notes.append(f"En yakın destek {_fmt(s['price'])} ({_pct(s['dist_pct'])} aşağıda, {s['touches']} kez test edildi).")
    else:
        notes.append("Fiyatın altında yatay bir destek seviyesi yok (1 yıllık dip bölgesi).")
    if res:
        r = res[0]
        notes.append(f"En yakın direnç {_fmt(r['price'])} ({_pct(r['dist_pct'])} yukarıda, {r['touches']} kez test edildi).")
    else:
        notes.append("Fiyatın üstünde yatay bir direnç seviyesi yok (yeni zirve bölgesi).")
    wsup = weekly_levels.get("supports", [])
    if wsup and (not sup or abs(wsup[0]["price"] - sup[0]["price"]) / close > 0.02):
        notes.append(f"Haftalık grafikte ana destek {_fmt(wsup[0]['price'])} ({_pct(wsup[0]['dist_pct'])} aşağıda).")
    if high52 > low52:
        pos = (close - low52) / (high52 - low52) * 100
        zone = "üst" if pos >= 80 else "alt" if pos <= 20 else "orta"
        notes.append(f"Fiyat 1 yıllık aralığın {zone} bölümünde (%{pos:.0f}; dip {_fmt(low52)}, zirve {_fmt(high52)}).")
    trend = [(k, v) for k, v in perf.items() if v is not None and k in ("1A", "3A", "6A", "1Y")]
    if len(trend) >= 3:
        ups = sum(v > 0 for _, v in trend)
        if ups == len(trend):
            notes.append("1 aydan 1 yıla tüm dönemlerde getiri pozitif: istikrarlı yükseliş eğilimi.")
        elif ups == 0:
            notes.append("1 aydan 1 yıla tüm dönemlerde getiri negatif: istikrarlı düşüş eğilimi.")
    return notes
