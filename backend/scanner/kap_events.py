"""KAP olay çalışması: python -m scanner.kap_events

Soru: bir KAP bildirimi (bedelsiz kararı, pay geri alım programı, temettü, yeni iş/ihale, SPK tedbiri, bilanço...)
yayınlandıktan sonra hisse, BIST 100'e göre ne yaptı? Gerçekçi olmak için giriş, bildirimden SONRAKİ ilk işlem gününün
açılışıdır (seans içinde ya da sonrasında yayınlanan haberi o gün yakalamak garanti değil). Aynı hissede aynı türden
olaylar 10 işlem günü içinde tekrar ederse (ör. günlük geri alım bildirimleri) ilki sayılır.

Bir olay türü "kanıtlandı" sayılması için: yeterli örnek (MIN_EVENTS), anlamlı ortalama (|t| >= MIN_T) ve yıllar
boyunca tutarlılık (yılların en az MIN_YEAR_SHARE'inde aynı yön). Çıktı data/kap_events.json / .txt.
"""
import json
import re

import numpy as np
import pandas as pd

from . import history, kap_history
from .config import DATA_DIR
from .prices import load_prices
from .scan import scan_universe

REPORT_JSON = DATA_DIR / "kap_events.json"
REPORT_TXT = DATA_DIR / "kap_events.txt"
HORIZONS = {"1g": 1, "5g": 5, "20g": 20}
DEDUP_DAYS = 10
CLOSE_HOUR = 18  # BIST kapanışı (İstanbul saati)
MIN_EVENTS = 80
MIN_T = 2.5
MIN_YEAR_SHARE = 0.6

# Olay türü -> (açıklama, kural: başlık+özet küçük harfte bu ifadeye uymalı)
EVENTS = {
    "bedelsiz_karar": ("Bedelsiz sermaye artırımı kararı", r"bedelsiz.*(karar|yönetim kurulu|başvur)|(karar|yönetim kurulu).*bedelsiz"),
    "bedelsiz_onay": ("Bedelsiz için SPK onayı", r"bedelsiz.*(onay|onaylan)|(onay|onaylan).*bedelsiz"),
    "bedelli": ("Bedelli sermaye artırımı", r"bedelli"),
    "geri_alim_program": ("Pay geri alım programı başlangıcı", r"geri alım.*(program|başlat|karar)|(program|karar).*geri alım"),
    "geri_alim_islem": ("Pay geri alım işlemi", r"geri alım"),
    "temettu": ("Kâr payı (temettü) dağıtımı kararı", r"kar payı|kâr payı|temettü"),
    "yeni_is": ("Yeni iş ilişkisi / sözleşme / ihale", r"yeni iş ilişkisi|sözleşme imza|ihale.*(kazan|sonuç|uhde)|sipariş"),
    "spk_tedbir": ("SPK tedbir kararı", r"tedbir"),
    "pay_satis": ("Ortak/yönetici pay alım-satım bildirimi", r"pay alım satım bildirimi"),
    "kredi_notu": ("Kredi derecelendirmesi", r"derecelendirme|kredi not"),
    "devre_kesici": ("Pay bazında devre kesici", r"devre kesici"),
    "finansal_rapor": ("Finansal rapor (bilanço) açıklaması", r"^finansal rapor"),
}
# Sıra önceliktir (bir bildirim tek türe girer): önce özel türler
ORDER = ["spk_tedbir", "bedelsiz_onay", "bedelsiz_karar", "bedelli", "geri_alim_program", "geri_alim_islem", "temettu",
         "yeni_is", "kredi_notu", "devre_kesici", "finansal_rapor", "pay_satis"]


def tr_lower(s: str) -> str:
    return (s or "").replace("İ", "i").replace("I", "ı").lower()


def classify(subject: str, summary: str) -> str | None:
    text = f"{tr_lower(subject)} | {tr_lower(summary)}"
    for key in ORDER:
        if re.search(EVENTS[key][1], text):
            return key
    return None


def events_table(kap: pd.DataFrame, symbols: set[str]) -> pd.DataFrame:
    df = kap[kap["symbol"].isin(symbols)].copy()
    df["event"] = [classify(a, b) for a, b in zip(df["subject"], df["summary"])]
    df = df.dropna(subset=["event"])
    df["published"] = pd.to_datetime(df["published"])
    # Etkin gün: bildirimin ertesi işlem günü (giriş o günün açılışı); kapanış sonrası ya da hafta sonu da ertesi gün
    df["pub_day"] = df["published"].dt.normalize()
    df["after_close"] = df["published"].dt.hour >= CLOSE_HOUR
    return df.sort_values("published")


def measure(ev: pd.DataFrame, prices: pd.DataFrame, index_sym: str = "XU100.IS") -> pd.DataFrame:
    """Her olay için giriş (ertesi işlem günü açılışı) sonrası getiriler ve BIST 100'e göre fark (%)."""
    idx = prices[prices["yf_symbol"] == index_sym].set_index("date").sort_index()
    out = []
    for sym, g in ev.groupby("symbol"):
        px = prices[prices["yf_symbol"] == f"{sym}.IS"].set_index("date").sort_index()
        if len(px) < 30:
            continue
        dates = px.index.to_numpy()
        o, c = px["open"].to_numpy(), px["close"].to_numpy()
        last_i = -999
        last_ev: dict[str, int] = {}
        for r in g.itertuples():
            i = int(np.searchsorted(dates, np.datetime64(r.pub_day), side="right"))  # bildirim gününden sonraki ilk gün
            if i >= len(dates) or i < 1:
                continue
            if i - last_ev.get(r.event, -999) < DEDUP_DAYS:
                continue
            last_ev[r.event] = i
            row = {"symbol": sym, "event": r.event, "date": pd.Timestamp(dates[i]), "after_close": r.after_close,
                   "gap": (o[i] / c[i - 1] - 1) * 100}
            for name, h in HORIZONS.items():
                j = i + h - 1
                if j >= len(dates):
                    row[f"ret_{name}"] = row[f"ex_{name}"] = np.nan
                    continue
                ret = (c[j] / o[i] - 1) * 100
                d0, d1 = dates[i], dates[j]
                try:
                    iret = (idx.loc[d1, "close"] / idx.loc[d0, "open"] - 1) * 100
                except KeyError:
                    iret = np.nan
                row[f"ret_{name}"], row[f"ex_{name}"] = ret, ret - iret
            out.append(row)
            last_i = i
    del last_i
    return pd.DataFrame(out)


def summarize(m: pd.DataFrame) -> list[dict]:
    rows = []
    for key, g in m.groupby("event"):
        item = {"event": key, "desc": EVENTS[key][0], "n": int(len(g)),
                "gap": round(float(g["gap"].median()), 2)}
        for name in HORIZONS:
            x = g[f"ex_{name}"].dropna()
            if len(x) < 10:
                continue
            t = float(x.mean() / x.std() * np.sqrt(len(x))) if x.std() > 0 else 0.0
            by_year = x.groupby(g.loc[x.index, "date"].dt.year).mean()
            sign = np.sign(x.mean())
            item[name] = {"mean": round(float(x.mean()), 2), "median": round(float(x.median()), 2),
                          "hit": round(float((x > 0).mean()) * 100, 1), "t": round(t, 2), "n": int(len(x)),
                          "year_share": round(float((np.sign(by_year) == sign).mean()), 2), "years": int(len(by_year))}
        h = item.get("20g") or item.get("5g")
        item["proven"] = bool(h and h["n"] >= MIN_EVENTS and abs(h["t"]) >= MIN_T and h["year_share"] >= MIN_YEAR_SHARE)
        item["direction"] = (1 if h and h["mean"] > 0 else -1) if h else 0
        rows.append(item)
    return sorted(rows, key=lambda r: -abs((r.get("20g") or {}).get("t", 0)))


def report_txt(rows: list[dict], span: str) -> str:
    lines = [f"KAP OLAY ÇALIŞMASI ({span}) — giriş: bildirimden sonraki ilk işlem günü açılışı; BIST 100'e göre fark (%)", ""]
    lines.append(f"{'olay':40} {'n':>6} {'boşluk':>7} | {'1g':>14} | {'5g':>14} | {'20g':>22} | kanıt")
    for r in rows:
        cells = []
        for name in HORIZONS:
            h = r.get(name)
            cells.append(f"{h['mean']:+6.2f} t{h['t']:+5.1f}" + (f" y%{h['year_share'] * 100:3.0f}" if name == "20g" else "")
                         if h else " " * 14)
        lines.append(f"{r['desc'][:40]:40} {r['n']:>6} {r['gap']:>+7.2f} | " + " | ".join(cells)
                     + f" | {'EVET' if r['proven'] else '-'}")
    return "\n".join(lines)


def main() -> None:
    kap = kap_history.load()
    symbols = set(scan_universe("BIST")["symbol"])
    prices = history.load_long() if history.LONG_FILE.exists() else load_prices()
    ev = events_table(kap, symbols)
    if ev.empty or ev["published"].dt.year.nunique() < 2:
        raise SystemExit("Olay çalışması için yeterli KAP arşivi yok")
    m = measure(ev, prices)
    rows = summarize(m)
    span = f"{m['date'].min().date()} – {m['date'].max().date()}, {len(m):,} olay"
    REPORT_JSON.write_text(json.dumps({"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "span": span,
                                       "events": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    txt = report_txt(rows, span)
    REPORT_TXT.write_text(txt, encoding="utf-8")
    print(txt)


if __name__ == "__main__":
    main()
