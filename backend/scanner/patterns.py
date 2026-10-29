"""Pivot noktaları, destek/direnç seviyeleri ve formasyon tespiti (ikili tepe/dip, RSI uyumsuzluğu)."""
from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class Pivots:
    highs: np.ndarray  # pivot tepe indeksleri (pozisyonel)
    lows: np.ndarray   # pivot dip indeksleri


PIVOT_K = 5


def find_pivots(df: pd.DataFrame, k: int = PIVOT_K) -> Pivots:
    """Sağında ve solunda k mum boyunca en yüksek/en düşük olan mumlar pivottur."""
    w = 2 * k + 1
    h, l = df["high"], df["low"]
    is_high = h == h.rolling(w, center=True).max()
    is_low = l == l.rolling(w, center=True).min()
    return Pivots(np.flatnonzero(is_high.to_numpy()), np.flatnonzero(is_low.to_numpy()))


def support_resistance(df: pd.DataFrame, piv: Pivots, lookback: int) -> tuple[float | None, float | None]:
    """Fiyatın altındaki en yakın pivot dip = destek, üstündeki en yakın pivot tepe = direnç."""
    n = len(df)
    close = df["close"].iloc[-1]
    start = n - lookback
    lows = df["low"].to_numpy()[piv.lows[piv.lows >= start]]
    highs = df["high"].to_numpy()[piv.highs[piv.highs >= start]]
    below = lows[lows < close * 0.995]
    above = highs[highs > close * 1.005]
    support = float(below.max()) if below.size else None
    resistance = float(above.min()) if above.size else None
    return support, resistance


def double_bottom(df: pd.DataFrame, piv: Pivots, atr: float, max_age: int = 60) -> str | None:
    """Son iki dip birbirine yakınsa ve aralarında belirgin bir tepe varsa ikili dip.
    Fiyat boyun çizgisinin (aradaki tepe) üstündeyse 'confirmed', değilse 'forming'."""
    n = len(df)
    lows = piv.lows[piv.lows >= n - max_age]
    if lows.size < 2:
        return None
    a, b = lows[-2], lows[-1]
    la, lb = df["low"].iloc[a], df["low"].iloc[b]
    if b - a < 8 or abs(la - lb) > atr:
        return None
    neck = df["high"].iloc[a:b + 1].max()
    if neck - max(la, lb) < 2 * atr:
        return None
    return "confirmed" if df["close"].iloc[-1] > neck else "forming"


def double_top(df: pd.DataFrame, piv: Pivots, atr: float, max_age: int = 60) -> str | None:
    n = len(df)
    highs = piv.highs[piv.highs >= n - max_age]
    if highs.size < 2:
        return None
    a, b = highs[-2], highs[-1]
    ha, hb = df["high"].iloc[a], df["high"].iloc[b]
    if b - a < 8 or abs(ha - hb) > atr:
        return None
    neck = df["low"].iloc[a:b + 1].min()
    if min(ha, hb) - neck < 2 * atr:
        return None
    return "confirmed" if df["close"].iloc[-1] < neck else "forming"


def rsi_divergence(df: pd.DataFrame, piv: Pivots, max_age: int = 15) -> str | None:
    """Pozitif uyumsuzluk: fiyat daha düşük dip yaparken RSI daha yüksek dip yapar (tersi negatif)."""
    n = len(df)
    rsi = df["rsi"]
    lows = piv.lows
    if lows.size >= 2 and lows[-1] >= n - max_age:
        a, b = lows[-2], lows[-1]
        if df["low"].iloc[b] < df["low"].iloc[a] and rsi.iloc[b] > rsi.iloc[a] + 2 and rsi.iloc[a] < 40:
            return "bullish"
    highs = piv.highs
    if highs.size >= 2 and highs[-1] >= n - max_age:
        a, b = highs[-2], highs[-1]
        if df["high"].iloc[b] > df["high"].iloc[a] and rsi.iloc[b] < rsi.iloc[a] - 2 and rsi.iloc[a] > 60:
            return "bearish"
    return None
