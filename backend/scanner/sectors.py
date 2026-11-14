"""BIST sektör adları -> gündem sektörleri (worker/src/agenda.ts SECTORS) ve sektör rotasyonu.

Yahoo'da BIST sektör endekslerinin çoğunun geçmişi olmadığı için sektör performansı, o sektördeki hisselerin
fiyatlarından hesaplanır (medyan getiri; BIST 100'e göre fark; 50 günlük ortalamanın üstündeki hisse oranı).
"""
import re

import pandas as pd

SECTOR_NAMES = {
    "banka": "Bankacılık", "gyo": "Gayrimenkul (GYO)", "holding": "Holdingler", "sanayi": "Sanayi",
    "havacilik": "Havacılık ve ulaştırma", "turizm": "Turizm", "enerji": "Elektrik ve enerji",
    "petrol": "Petrol ve kimya", "metal": "Metal ve demir-çelik", "gida": "Gıda ve içecek", "perakende": "Perakende",
    "iletisim": "İletişim ve medya", "savunma": "Savunma", "insaat": "İnşaat ve çimento", "sigorta": "Sigorta",
    "otomotiv": "Otomotiv", "altin": "Madencilik",
}
SECTOR_MAP = [
    (r"bankac", "banka"), (r"gyo|gayrimenkul", "gyo"), (r"holding", "holding"), (r"elektrik", "enerji"),
    (r"demir|çelik|metal", "metal"), (r"çimento|inşaat|seramik|\bcam\b", "insaat"), (r"petrol|kimya", "petrol"),
    (r"gıda|içecek|meşrubat", "gida"), (r"perakande|perakende|ticaret|pazarlama", "perakende"),
    (r"havayol|ulaştırma|lojistik", "havacilik"), (r"turizm", "turizm"), (r"^iletişim$|medya", "iletisim"),
    (r"savunma", "savunma"), (r"sigorta", "sigorta"), (r"otomotiv", "otomotiv"), (r"madencilik", "altin"),
    (r"tekstil|makine|kağıt|kablo|boya|mobilya|dayanıklı", "sanayi"),
]
MIN_STOCKS = 3


def agenda_sector(sector: str | None) -> str | None:
    s = (sector or "").replace("İ", "i").replace("I", "ı").lower()  # Türkçe küçük harf
    return next((sid for pat, sid in SECTOR_MAP if re.search(pat, s)), None)


def rotation(prices: pd.DataFrame, scan: pd.DataFrame, main: str) -> list[dict]:
    """Gündem sektörleri için 1 hafta / 1 ay / 3 ay medyan getiri, BIST 100'e göre fark ve trend genişliği."""
    g = scan[scan["market"] == "BIST"].assign(sid=lambda x: x["sector"].map(agenda_sector)).dropna(subset=["sid"])
    syms = g["yf_symbol"].tolist() + [main]
    px = (prices[prices["yf_symbol"].isin(syms)].pivot(index="date", columns="yf_symbol", values="close")
          .sort_index().ffill(limit=3))
    if main not in px or len(px) < 64:
        return []

    def ret(n: int) -> pd.Series:
        return (px.iloc[-1] / px.iloc[-1 - n] - 1) * 100

    r = {n: ret(n) for n in (5, 21, 63)}
    above = px.iloc[-1] > px.ewm(span=50, adjust=False).mean().iloc[-1]
    rows = []
    for sid, members in g.groupby("sid"):
        cols = [s for s in members["yf_symbol"] if s in px]
        if len(cols) < MIN_STOCKS:
            continue
        med = {n: float(r[n][cols].median()) for n in r}
        leaders = r[21][cols].sort_values(ascending=False).head(3)
        sym_of = dict(zip(members["yf_symbol"], members["symbol"]))
        rows.append({
            "sector": sid, "name": SECTOR_NAMES[sid], "count": len(cols),
            "chg_1w": round(med[5], 2), "chg_1m": round(med[21], 2), "chg_3m": round(med[63], 2),
            "rel_1w": round(med[5] - float(r[5][main]), 2), "rel_1m": round(med[21] - float(r[21][main]), 2),
            "rel_3m": round(med[63] - float(r[63][main]), 2),
            "above_ema50": round(float(above[cols].mean()) * 100, 1),
            "leaders": [sym_of[s] for s in leaders.index],
        })
    return sorted(rows, key=lambda x: -x["rel_1m"])
