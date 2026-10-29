"""Piyasa rejimi: endeks trendi + piyasa genişliği -> Boğa / Nötr / Ayı.

Trend takip eden sinyaller (bu uygulamanın teknik skoru dahil) boğa piyasasında daha iyi çalışır; geniş bir düşüşte
en güçlü görünen hisse bile zorlanır. Bu modül "şu an piyasa ortamı nasıl?" sorusunu cevaplar.
"""
import numpy as np
import pandas as pd

from . import views
from .config import INDEX_SYMBOLS, MAIN_INDEX

HISTORY_DAYS = 126  # genişlik geçmişi (≈6 ay)
REGIMES = [  # (en düşük puan, etiket, açıklama)
    (3, "Boğa", "Endeks yükseliş trendinde ve hisselerin çoğu yükseliyor. Trend takip eden sinyaller bu ortamda tarihsel olarak daha iyi çalışır."),
    (1, "Temkinli boğa", "Genel eğilim olumlu ama katılım zayıf ya da trend yavaşlıyor. Seçici olmak gerekir."),
    (-1, "Nötr", "Belirgin bir yön yok. Yükseliş sinyalleri sık sık başarısız olabilir; stoplar önem kazanır."),
    (-3, "Zayıf", "Hisselerin çoğu düşüşte. Yeni alımlarda pozisyonu küçük tutmak ve stopları sıkı izlemek daha güvenli olur."),
    (-99, "Ayı", "Endeks düşüş trendinde ve satış geniş tabanlı. Yükseliş sinyallerinin başarısız olma ihtimali yüksek; nakit/temkin ön planda."),
]


def _pct(a: float, b: float) -> float | None:
    return round(float(a / b - 1) * 100, 2) if b else None


def _index_snapshot(px: pd.DataFrame) -> dict:
    c = px.sort_values("date")["close"].reset_index(drop=True)
    ema50, ema200 = c.ewm(span=50, adjust=False).mean(), c.ewm(span=200, adjust=False).mean()
    last = float(c.iloc[-1])
    return {
        "close": last,
        "date": pd.Timestamp(px["date"].max()).date().isoformat(),
        "chg_1d": _pct(last, c.iloc[-2]) if len(c) > 1 else None,
        "chg_1m": _pct(last, c.iloc[-22]) if len(c) > 22 else None,
        "chg_3m": _pct(last, c.iloc[-64]) if len(c) > 64 else None,
        "chg_1y": _pct(last, c.iloc[-253]) if len(c) > 253 else None,
        "above_ema200": bool(last > ema200.iloc[-1]),
        "ema50_rising": bool(ema50.iloc[-1] > ema50.iloc[-11]),
    }


def breadth(prices: pd.DataFrame, symbols: list[str]) -> tuple[dict, list[dict]]:
    """Genişlik: 50/200 günlük ortalamanın üstündeki hisse oranı, yükselen/düşen, yeni zirve/dip; ve geçmişi."""
    px = prices[prices["yf_symbol"].isin(symbols)].pivot(index="date", columns="yf_symbol", values="close").sort_index()
    px = px.ffill(limit=3)
    sma50 = px.rolling(50, min_periods=50).mean()
    sma200 = px.rolling(200, min_periods=200).mean()
    hi252 = px.rolling(252, min_periods=120).max()
    lo252 = px.rolling(252, min_periods=120).min()
    valid50, valid200 = sma50.notna(), sma200.notna()
    above50 = ((px > sma50) & valid50).sum(axis=1) / valid50.sum(axis=1).replace(0, np.nan) * 100
    above200 = ((px > sma200) & valid200).sum(axis=1) / valid200.sum(axis=1).replace(0, np.nan) * 100
    chg = px.pct_change(fill_method=None)
    adv, dec = (chg > 0).sum(axis=1), (chg < 0).sum(axis=1)
    new_hi = (px >= hi252).sum(axis=1)
    new_lo = (px <= lo252).sum(axis=1)

    last = px.index[-1]
    now = {
        "pct_above_50": round(float(above50.loc[last]), 1),
        "pct_above_200": round(float(above200.loc[last]), 1),
        "advancers": int(adv.loc[last]),
        "decliners": int(dec.loc[last]),
        "new_highs": int(new_hi.loc[last]),
        "new_lows": int(new_lo.loc[last]),
        "median_1m": round(float((px.iloc[-1] / px.iloc[-22] - 1).median() * 100), 2) if len(px) > 22 else None,
        "stocks": int(px.iloc[-1].notna().sum()),
    }
    hist = pd.DataFrame({"a50": above50, "a200": above200}).dropna().tail(HISTORY_DAYS)
    history = [{"d": d.date().isoformat(), "a50": round(float(r.a50), 1), "a200": round(float(r.a200), 1)}
               for d, r in hist.iterrows()]
    return now, history


def regime(index: dict, br: dict) -> dict:
    """Beş bileşenin her biri +1 / 0 / -1; toplam -5..+5 -> etiket."""
    parts = [
        ("Endeks 200 günlük ortalamanın " + ("üstünde" if index["above_ema200"] else "altında"),
         1 if index["above_ema200"] else -1),
        ("Endeksin 50 günlük ortalaması " + ("yükseliyor" if index["ema50_rising"] else "düşüyor"),
         1 if index["ema50_rising"] else -1),
    ]
    a200, a50 = br["pct_above_200"], br["pct_above_50"]
    parts.append((f"200 günlük ortalamanın üstündeki hisse oranı %{a200:.0f}",
                  1 if a200 >= 60 else -1 if a200 <= 40 else 0))
    parts.append((f"50 günlük ortalamanın üstündeki hisse oranı %{a50:.0f}",
                  1 if a50 >= 60 else -1 if a50 <= 40 else 0))
    hi, lo = br["new_highs"], br["new_lows"]
    parts.append((f"Yeni 1 yıllık zirve {hi}, yeni dip {lo}",
                  1 if hi > 2 * lo and hi >= 5 else -1 if lo > 2 * hi and lo >= 5 else 0))
    score = sum(p for _, p in parts)
    label, text = next((lab, txt) for th, lab, txt in REGIMES if score >= th)
    return {
        "score": score,
        "label": label,
        "summary": text,
        "factors": [{"text": t, "signal": p} for t, p in parts],
    }


def overview(prices: pd.DataFrame, scan: pd.DataFrame, sectors: dict[str, list[dict]] | None = None) -> dict:
    out = {}
    for market, idx in INDEX_SYMBOLS.items():
        symbols = scan.loc[scan["market"] == market, "yf_symbol"].tolist()
        main = MAIN_INDEX[market]
        main_px = prices[prices["yf_symbol"] == main]
        if main_px.empty or not symbols:
            continue
        br_now, br_hist = breadth(prices, symbols)
        main_snap = _index_snapshot(main_px)
        indices = []
        for sym, name in idx.items():
            p = prices[prices["yf_symbol"] == sym]
            if len(p) > 1:
                indices.append({"symbol": sym, "name": name, **_index_snapshot(p)})
        g = scan[scan["market"] == market]
        out[market] = {
            "index_name": idx[main],
            "regime": regime(main_snap, br_now),
            "indices": indices,
            "breadth": br_now,
            "breadth_history": br_hist,
            "outlook": g["outlook"].value_counts().to_dict(),
            "sectors": (sectors or {}).get(market, []),
            "chart": views.chart(main_px, (20, 50, 200), views.DAILY_BARS),
        }
    return out
