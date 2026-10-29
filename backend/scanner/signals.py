"""Kural tabanlı teknik skor: -100 (güçlü düşüş) ile +100 (güçlü yükseliş) arası, gerekçeleriyle birlikte."""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .indicators import add_indicators
from .patterns import PIVOT_K, Pivots, double_bottom, double_top, find_pivots, rsi_divergence, support_resistance


@dataclass(frozen=True)
class Timeframe:
    name: str
    fast: int
    mid: int
    slow: int
    breakout: int      # kırılım için bakılan mum sayısı
    sr_lookback: int   # destek/direnç için bakılan mum sayısı
    year_bars: int     # 1 yıldaki mum sayısı
    min_bars: int
    unit: str          # gerekçe metinlerinde kullanılır


DAILY = Timeframe("daily", 20, 50, 200, breakout=20, sr_lookback=250, year_bars=252, min_bars=60, unit="günlük")
WEEKLY = Timeframe("weekly", 10, 30, 50, breakout=13, sr_lookback=104, year_bars=52, min_bars=30, unit="haftalık")

# Her kuralın puanı. Pozitif kurallar yükseliş, negatif tetiklenmeleri düşüş yönünde aynı büyüklükte puan verir.
# Puanı 0 olan kurallar skora katılmaz, sadece bilgi notu olarak gerekçelerde görünür.
# Backtest (2025-08 / 2026-10, piyasa medyanına göre 20 günlük fazla getiri) sonuçlarına göre ayarlandı:
# - RSI > 70 iki piyasada da sonraki getiriyle pozitif ilişkili (momentum) -> tam puan
# - İkili tepe, RSI uyumsuzluğu ve "aşırı uzama -> tepki" iki piyasada da ters/etkisiz -> 0
WEIGHTS = {
    "trend_slow": 10,      # fiyat uzun ortalamanın üstünde/altında
    "trend_align": 10,     # kısa > orta > uzun sıralaması
    "trend_mid": 5,        # fiyat orta ortalamanın üstünde/altında
    "trend_slope": 5,      # orta ortalamanın eğimi
    "rsi": 8,              # RSI 50-70 (+) / 30-50 (-)
    "rsi_overbought": 8,   # RSI > 70
    "rsi_oversold": 8,     # RSI < 30 (negatif puan)
    "macd_hist": 6,
    "macd_cross": 6,
    "vol_spike": 8,        # hacimli yükseliş/düşüş
    "obv": 4,
    "breakout": 12,        # N mumluk direnç kırılımı / destek kırılımı
    "near_52w": 6,         # 1 yıllık zirve/dibe yakınlık
    "ma_cross": 10,        # golden/death cross
    "double_bottom": 10,
    "double_top": 0,
    "rsi_div": 0,
    "stretch": 0,          # ortalamadan aşırı uzaklaşma
}
# Piyasaya özel farklar. ABD'de kısa vadeli sinyallerin (kırılım, kesişimler) etkisi sıfıra yakın,
# aşırı satımdaki hisseler ise ortalamada tepki vermiş (kısmen listeden çıkan hisselerin veride
# olmamasından kaynaklanabilir, bu yüzden ters puan yerine 0 verildi).
MARKET_WEIGHTS = {
    "BIST": {"near_52w": 10},
    "US": {"breakout": 6, "macd_cross": 3, "ma_cross": 5, "rsi_oversold": 0},
}


def weights_for(market: str | None) -> dict:
    return {**WEIGHTS, **MARKET_WEIGHTS.get(market or "", {})}
FORMING_FACTOR = 0.4       # oluşmakta olan formasyon, onaylanmışın bu oranı kadar puan alır
ADX_TREND_BOOST = 1.3
TREND_KEYS = ("trend_slow", "trend_align", "trend_mid", "trend_slope")


@dataclass
class Analysis:
    score: float
    reasons: list[str] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    components: dict = field(default_factory=dict)  # kural anahtarı -> yön (+1/-1, oluşan formasyonda kesirli)


def _crossed(a: pd.Series, b: pd.Series, within: int) -> int:
    """Son `within` mumda a, b'yi yukarı kestiyse +1, aşağı kestiyse -1, yoksa 0."""
    diff = np.sign(a.iloc[-(within + 1):] - b.iloc[-(within + 1):]).dropna().to_numpy()
    if len(diff) < within + 1 or not (np.diff(diff) != 0).any():
        return 0
    return int(diff[-1])


def prepare(df: pd.DataFrame, tf: Timeframe) -> tuple[pd.DataFrame, Pivots]:
    """İndikatörleri ve pivotları tüm geçmiş için bir kez hesaplar (backtest'te tekrar kullanılır)."""
    d = add_indicators(df.reset_index(drop=True), tf.fast, tf.mid, tf.slow)
    return d, find_pivots(d)


def score_at(d_full: pd.DataFrame, piv_full: Pivots, t: int, tf: Timeframe,
             market: str | None = None) -> Analysis | None:
    """t. mumun kapanışındaki analiz. Sadece t ve öncesindeki veriyi kullanır (geleceğe bakmaz):
    pivot onayı için sağında PIVOT_K mum gerektiğinden t - PIVOT_K sonrası pivotlar atılır."""
    if t + 1 < tf.min_bars:
        return None
    d = d_full.iloc[:t + 1]
    cutoff = t - PIVOT_K
    piv = Pivots(piv_full.highs[piv_full.highs <= cutoff], piv_full.lows[piv_full.lows <= cutoff])
    last = d.iloc[-1]
    close, a = last["close"], last["atr"]
    if not np.isfinite(a) or a <= 0:
        return None

    weights = weights_for(market)
    pts: list[tuple[float, str, str]] = []
    components: dict[str, float] = {}

    def add(key: str, sign: float, why: str, factor: float = 1.0):
        pts.append((sign * weights[key] * factor, why, key))
        components[key] = sign * factor

    # --- Trend ---
    has_slow = np.isfinite(last["ema_slow"])
    if has_slow:
        if close > last["ema_slow"]:
            add("trend_slow", 1, f"Fiyat uzun vadeli ortalamanın (EMA{tf.slow}) üstünde")
        else:
            add("trend_slow", -1, f"Fiyat uzun vadeli ortalamanın (EMA{tf.slow}) altında")
        if last["ema_fast"] > last["ema_mid"] > last["ema_slow"]:
            add("trend_align", 1, "Ortalamalar yükseliş sıralamasında (kısa > orta > uzun)")
        elif last["ema_fast"] < last["ema_mid"] < last["ema_slow"]:
            add("trend_align", -1, "Ortalamalar düşüş sıralamasında (kısa < orta < uzun)")
    if close > last["ema_mid"]:
        add("trend_mid", 1, f"Fiyat EMA{tf.mid} üstünde")
    else:
        add("trend_mid", -1, f"Fiyat EMA{tf.mid} altında")
    slope = d["ema_mid"].iloc[-1] - d["ema_mid"].iloc[-11]
    if np.isfinite(slope):
        add("trend_slope", 1 if slope > 0 else -1, f"EMA{tf.mid} {'yukarı' if slope > 0 else 'aşağı'} eğimli")
    if np.isfinite(last["adx"]) and last["adx"] > 25:
        pts = [(p * ADX_TREND_BOOST if k in TREND_KEYS else p, why, k) for p, why, k in pts]
        pts.append((0, f"Trend güçlü (ADX {last['adx']:.0f})", "adx"))

    # --- Momentum ---
    r = last["rsi"]
    if r > 70:
        add("rsi_overbought", 1, f"RSI {r:.0f}: güçlü momentum (aşırı alım bölgesi, kısa vadeli dalgalanma olabilir)")
    elif r >= 50:
        add("rsi", 1, f"RSI {r:.0f}: pozitif momentum")
    elif r >= 30:
        add("rsi", -1, f"RSI {r:.0f}: negatif momentum")
    else:
        add("rsi_oversold", -1, f"RSI {r:.0f}: aşırı satım bölgesi, satış baskısı güçlü")
    if last["macd_hist"] > 0:
        add("macd_hist", 1, "MACD pozitif bölgede")
    else:
        add("macd_hist", -1, "MACD negatif bölgede")
    mc = _crossed(d["macd"], d["macd_signal"], 3)
    if mc > 0:
        add("macd_cross", 1, "MACD yukarı kesişim (yeni)")
    elif mc < 0:
        add("macd_cross", -1, "MACD aşağı kesişim (yeni)")

    # --- Hacim ---
    up_bar = close > d["close"].iloc[-2]
    if np.isfinite(last["vol_ratio"]) and last["vol_ratio"] > 1.8:
        if up_bar:
            add("vol_spike", 1, f"Hacimli yükseliş (ortalamanın {last['vol_ratio']:.1f} katı)")
        else:
            add("vol_spike", -1, f"Hacimli düşüş (ortalamanın {last['vol_ratio']:.1f} katı)")
    if d["obv"].iloc[-1] - d["obv"].iloc[-21] > 0:
        add("obv", 1, "Para girişi (OBV yükseliyor)")
    else:
        add("obv", -1, "Para çıkışı (OBV düşüyor)")

    # --- Yapı / formasyonlar ---
    prev_high = d["high"].iloc[-(tf.breakout + 1):-1].max()
    prev_low = d["low"].iloc[-(tf.breakout + 1):-1].min()
    if close > prev_high:
        add("breakout", 1, f"{tf.breakout} {tf.unit} direnç kırıldı")
    elif close < prev_low:
        add("breakout", -1, f"{tf.breakout} {tf.unit} destek kırıldı")

    year = d.iloc[-tf.year_bars:]
    hi52, lo52 = year["high"].max(), year["low"].min()
    if close >= hi52 * 0.97:
        add("near_52w", 1, "1 yıllık zirveye yakın")
    elif close <= lo52 * 1.03:
        add("near_52w", -1, "1 yıllık dibe yakın")

    if has_slow:
        gc = _crossed(d["ema_mid"], d["ema_slow"], 10)
        if gc > 0:
            add("ma_cross", 1, f"Golden cross (EMA{tf.mid} EMA{tf.slow}'ü yukarı kesti)")
        elif gc < 0:
            add("ma_cross", -1, f"Death cross (EMA{tf.mid} EMA{tf.slow}'ü aşağı kesti)")

    db = double_bottom(d, piv, a)
    if db == "confirmed":
        add("double_bottom", 1, "İkili dip formasyonu onaylandı")
    elif db == "forming":
        add("double_bottom", 1, "İkili dip formasyonu oluşuyor", FORMING_FACTOR)
    dt = double_top(d, piv, a)
    if dt == "confirmed":
        add("double_top", -1, "İkili tepe formasyonu onaylandı")
    elif dt == "forming":
        add("double_top", -1, "İkili tepe formasyonu oluşuyor", FORMING_FACTOR)
    div = rsi_divergence(d, piv)
    if div == "bullish":
        add("rsi_div", 1, "Pozitif RSI uyumsuzluğu (düşüş zayıflıyor)")
    elif div == "bearish":
        add("rsi_div", -1, "Negatif RSI uyumsuzluğu (yükseliş zayıflıyor)")

    # --- Aşırı uzama ---
    stretch = (close - last["ema_fast"]) / a
    if stretch > 3:
        add("stretch", -1, f"Fiyat ortalamadan çok uzaklaştı ({stretch:.1f} ATR), sert dalgalanma riski")
    elif stretch < -3:
        add("stretch", 1, f"Fiyat ortalamanın çok altında ({stretch:.1f} ATR), sert satış baskısı")

    score = float(np.clip(sum(p for p, _, _ in pts), -100, 100))
    # Gerekçeleri etkisine göre sırala (en güçlü önce)
    reasons = [why for p, why, _ in sorted(pts, key=lambda x: -abs(x[0]))]

    # --- Risk ve seviyeler ---
    support, resistance = support_resistance(d, piv, tf.sr_lookback)
    stop = max(support - 0.5 * a, close - 3 * a) if support else close - 2 * a
    # Üstte direnç yoksa (yeni zirve bölgesi) hedef ve risk/getiri hesaplanmaz
    target = resistance
    rr = (target - close) / (close - stop) if target and close > stop else None
    peak = year["close"].cummax()
    max_dd = float(((year["close"] / peak) - 1).min())

    metrics = {
        "close": float(close),
        "change_pct": float(close / d["close"].iloc[-2] - 1) * 100,
        "rsi": float(r),
        "adx": float(last["adx"]) if np.isfinite(last["adx"]) else None,
        "atr_pct": float(a / close * 100),
        "support": support,
        "resistance": resistance,
        "stop": float(stop),
        "target": float(target) if target else None,
        "at_new_high": resistance is None,
        "at_new_low": support is None,
        "risk_reward": float(rr) if rr is not None else None,
        "max_drawdown_1y_pct": max_dd * 100,
        "high_52w": float(hi52),
        "low_52w": float(lo52),
    }
    return Analysis(score=score, reasons=reasons, metrics=metrics, components=components)


def analyze(df: pd.DataFrame, tf: Timeframe, market: str | None = None) -> Analysis | None:
    """En son mumdaki analiz (günlük tarama için)."""
    if len(df) < tf.min_bars:
        return None
    d, piv = prepare(df, tf)
    return score_at(d, piv, len(d) - 1, tf, market)


def outlook_label(score: float) -> str:
    if score >= 40:
        return "Güçlü Yükseliş"
    if score >= 15:
        return "Yükseliş"
    if score > -15:
        return "Nötr"
    if score > -40:
        return "Düşüş"
    return "Güçlü Düşüş"


def volatility_label(atr_pct_daily: float) -> str:
    if atr_pct_daily < 2:
        return "Düşük"
    if atr_pct_daily < 4:
        return "Orta"
    return "Yüksek"
