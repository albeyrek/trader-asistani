"""Tarama sonuçlarını uygulamanın beklediği JSON biçimine çevirir.
Hem yerel API (api/main.py) hem de GitHub Pages dışa aktarımı (scanner/export.py) bunu kullanır."""
import json
import math
import re

import pandas as pd

from . import events, fundamentals, levels, strength
from .indicators import ema

JSON_COLUMNS = ("daily_reasons", "weekly_reasons", "risk_flags", "top_news", "alerts")
LIST_FIELDS = [
    "symbol", "market", "name", "sector", "close", "change_pct", "combined_score", "daily_score",
    "weekly_score", "outlook", "overall_risk", "volatility", "news_score", "news_risk", "at_new_high",
    "at_new_low", "alerts", "earnings_date", "earnings_status",
    "rs_rating", "rs_3m", "pe", "pb", "market_cap", "free_float", "rsi", "atr_pct",
]
# Nasdaq sektör adları -> Türkçe
US_SECTORS_TR = {
    "Technology": "Teknoloji", "Finance": "Finans", "Health Care": "Sağlık", "Energy": "Enerji",
    "Utilities": "Kamu hizmetleri", "Industrials": "Sanayi", "Consumer Discretionary": "Tüketici (dayanıklı/isteğe bağlı)",
    "Consumer Staples": "Temel tüketim", "Real Estate": "Gayrimenkul", "Basic Materials": "Temel malzemeler",
    "Telecommunications": "Telekomünikasyon", "Miscellaneous": "Diğer",
}
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


class SideData:
    """Tarama dışı veriler: bilanço takvimi, temel veriler, göreli güç ve sektörler.
    Hem bulut dışa aktarımı hem yerel API aynı hesabı kullanır."""

    def __init__(self, prices: pd.DataFrame, scan: pd.DataFrame):
        self.events = events.load()
        self.fund = fundamentals.load()
        self.sector_of: dict[str, str | None] = {}
        for r in scan.itertuples():
            key = f"{r.market}:{r.symbol}"
            if r.market == "BIST":
                self.sector_of[key] = r.sector or None
            else:
                sec = (self.fund.get(key) or {}).get("sector")
                self.sector_of[key] = US_SECTORS_TR.get(sec, sec) if sec else None
        self.rs, self.sectors = strength.compute(prices, scan, self.sector_of)

    def enrich(self, scan: pd.DataFrame) -> pd.DataFrame:
        out = scan.copy()
        keys = (out["market"] + ":" + out["symbol"]).tolist()
        out["sector"] = [self.sector_of.get(k) or "" for k in keys]
        out["earnings_date"] = [self.events.get(k, {}).get("date") for k in keys]
        out["earnings_status"] = [self.events.get(k, {}).get("status") for k in keys]
        for col in ("rs_rating", "rs_1m", "rs_3m"):
            out[col] = [self.rs.get(k, {}).get(col) for k in keys]
        for col in ("pe", "pb", "market_cap", "free_float"):
            out[col] = [(self.fund.get(k) or {}).get(col) for k in keys]
        return out

    def sector_info(self, market: str, sector: str | None) -> dict | None:
        rows = self.sectors.get(market, [])
        for r in rows:
            if r["sector"] == sector:
                return {**r, "of": len(rows)}
        return None


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


def _rs_note(r: pd.Series, sector: dict | None) -> str | None:
    rs = r.get("rs_rating")
    if rs is None or pd.isna(rs):
        return None
    rs = int(rs)
    level = "çok güçlü" if rs >= 85 else "güçlü" if rs >= 70 else "zayıf" if rs <= 30 else "ortalama"
    text = f"Göreli güç {rs}/99 ({level}): son aylardaki performansı piyasadaki hisselerin yaklaşık %{rs} kadarından iyi."
    rs3 = r.get("rs_3m")
    if rs3 is not None and pd.notna(rs3):
        diff = f"%{abs(rs3):.1f}".replace(".", ",")
        text += f" Son 3 ayda endeksten {diff} {'daha iyi' if rs3 > 0 else 'daha kötü'} getiri."
    if sector:
        text += f" Sektörü ({sector['sector']}) {sector['of']} sektör içinde {sector['rank']}. sırada."
    return text


def stock_detail(r: pd.Series, daily: pd.DataFrame, weekly: pd.DataFrame, news: pd.DataFrame | None,
                 side: SideData | None = None) -> dict:
    detail = row(r)
    key = f"{r['market']}:{r['symbol']}"
    event = side.events.get(key) if side else None
    fund = (side.fund.get(key) if side else None) or None
    detail["event"] = event
    detail["fundamentals"] = fund
    detail["fundamental_flags"] = fundamentals.flags(fund, r["market"])
    detail["sector_info"] = side.sector_info(r["market"], r.get("sector") or None) if side else None
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
    note = events.event_note(event)
    if note:
        detail["insights"].insert(0, note)
    rs_note = _rs_note(r, detail["sector_info"])
    if rs_note:
        detail["insights"].append(rs_note)
    detail["insights"] += detail["fundamental_flags"]
    detail["news"] = news_list(news) if news is not None and len(news) else []
    detail["reliability"] = MODEL_RELIABILITY.get(r["market"])
    return detail
