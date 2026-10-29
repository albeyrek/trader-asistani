"""Tarama sonuçlarını uygulamanın beklediği JSON biçimine çevirir.
Hem yerel API (api/main.py) hem de GitHub Pages dışa aktarımı (scanner/export.py) bunu kullanır."""
import json
import math
import re

import pandas as pd

from . import levels
from .indicators import ema

JSON_COLUMNS = ("daily_reasons", "weekly_reasons", "risk_flags", "top_news", "alerts")
LIST_FIELDS = [
    "symbol", "market", "name", "sector", "close", "change_pct", "combined_score", "daily_score",
    "weekly_score", "outlook", "overall_risk", "volatility", "news_score", "news_risk", "at_new_high",
    "at_new_low", "alerts",
]
# Backtest sonuçlarına göre teknik skorun güvenilirliği (bkz. data/backtest_report.txt)
MODEL_RELIABILITY = {
    "BIST": {"level": "Orta", "note": "Geçmiş testte skorlar sonraki 20 günün getirisiyle tutarlı ve anlamlı ilişki gösterdi."},
    "US": {"level": "Düşük", "note": "Geçmiş testte ilişki zayıf ve dönemden döneme değişken. Teknik skoru tek başına kullanmayın."},
}
DISCLAIMER = ("Bu uygulama yatırım tavsiyesi vermez. Skorlar geçmiş fiyat hareketleri ve haber başlıklarından "
              "otomatik üretilir; gelecekteki fiyatları garanti etmez.")
DAILY_BARS, WEEKLY_BARS = 520, 104  # ≈2 yıl günlük (grafikte yakınlaştırma/uzaklaştırma için), 2 yıl haftalık
LEVELS_DAILY_LOOKBACK = 260          # destek/direnç ve trend çizgileri son 1 yıldan
NEWS_PER_STOCK = 40


def clean(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if hasattr(v, "item"):  # numpy skalerleri
        return clean(v.item())
    return v


def display_name(name: str) -> str:
    name = re.sub(r"\s+-\s+.*$", "", name)  # "Apple Inc. - Common Stock" -> "Apple Inc."
    return re.sub(r"\s+(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|Common Shares)\b.*$", "", name)


def row(r: pd.Series, fields: list[str] | None = None) -> dict:
    out = {}
    for k in fields or r.index:
        v = r.get(k)
        if k in JSON_COLUMNS:
            v = json.loads(v) if isinstance(v, str) else []
        elif k == "name" and isinstance(v, str):
            v = display_name(v)
        out[k] = clean(v)
    return out


def meta(scan: pd.DataFrame, updated_at: pd.Timestamp) -> dict:
    return {
        "last_date": scan["date"].max(),
        "updated_at": updated_at.isoformat(),
        "counts": scan["market"].value_counts().to_dict(),
        "reliability": MODEL_RELIABILITY,
        "disclaimer": DISCLAIMER,
    }


def levels_map(scan: pd.DataFrame) -> dict:
    """Gün içi alarmlar ve portföy için: "PİYASA:KOD" -> [yahoo kodu, son kapanış, destek, direnç, stop]."""
    return {f"{r.market}:{r.symbol}": [r.yf_symbol, *(clean(v) for v in (r.close, r.support, r.resistance, r.stop))]
            for r in scan.itertuples()}


def chart(prices: pd.DataFrame, spans: tuple[int, int, int], bars: int) -> list[dict]:
    p = prices.sort_values("date").reset_index(drop=True)
    c = p["close"]
    p["ema_fast"], p["ema_mid"], p["ema_slow"] = ema(c, spans[0]), ema(c, spans[1]), ema(c, spans[2])
    p = p.tail(bars)
    cols = ["open", "high", "low", "close", "volume", "ema_fast", "ema_mid", "ema_slow"]
    return [{"d": d.date().isoformat(), **{k: clean(round(float(r[k]), 4)) for k in cols}}
            for d, (_, r) in zip(p["date"], p.iterrows())]


def news_list(news: pd.DataFrame) -> list[dict]:
    """Tek bir hissenin rutin olmayan haberleri, yeniden eskiye."""
    n = news[~news["routine"]].sort_values("published", ascending=False).head(NEWS_PER_STOCK)
    return [{
        "title": x.title, "url": x.url, "source": x.source, "sentiment": round(float(x.sentiment), 2),
        "date": x.published.isoformat() if pd.notna(x.published) else None,
        "categories": json.loads(x.categories), "kap_subject": x.kap_subject or None,
    } for x in n.itertuples()]


def stock_detail(r: pd.Series, daily: pd.DataFrame, weekly: pd.DataFrame, news: pd.DataFrame | None) -> dict:
    detail = row(r)
    detail["chart_daily"] = chart(daily, (20, 50, 200), DAILY_BARS)
    detail["chart_weekly"] = chart(weekly, (10, 30, 50), WEEKLY_BARS)
    # Grafik asistanı: çoklu destek/direnç, trend çizgileri, dönem getirileri, yorumlar
    lv_daily = levels.analyze_levels(daily, LEVELS_DAILY_LOOKBACK)
    lv_weekly = levels.analyze_levels(weekly, WEEKLY_BARS)
    perf = levels.performance(daily)
    detail["levels_daily"] = lv_daily
    detail["levels_weekly"] = lv_weekly
    detail["performance"] = perf
    detail["insights"] = levels.insights(lv_daily, lv_weekly, perf, float(r["close"]),
                                         float(r["high_52w"]), float(r["low_52w"]))
    detail["news"] = news_list(news) if news is not None and len(news) else []
    detail["reliability"] = MODEL_RELIABILITY.get(r["market"])
    return detail
