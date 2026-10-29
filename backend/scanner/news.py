"""Haber ve KAP analizi: python -m scanner.news [--top N] [--days D]

- KAP: tüm BIST hisseleri için son D günün bildirimleri (tek kaynaktan toplu çekilir).
- Google Haberler (BIST) ve Yahoo Finance (ABD): taramada en yüksek ve en düşük skorlu N'er hisse
  ile backend/watchlist.txt içindeki hisseler için (istek limitlerine takılmamak için).
- Sonuç tarama tablosuna eklenir: haber skoru, risk bayrakları, öne çıkan haberler, uyarılar, genel risk.
"""
import argparse
import json
import re
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .config import DATA_DIR, ROOT
from .news_sources import REQUEST_PAUSE_SEC, fetch_google_news_tr, fetch_kap, fetch_yahoo_news
from .scan import RESULTS_FILE
from .sentiment import MARKET, VOLATILITY, classify, tr_lower

ITEMS_FILE = DATA_DIR / "news_items.parquet"
SUMMARY_FILE = DATA_DIR / "news_summary.parquet"
WATCHLIST_FILE = ROOT / "watchlist.txt"

HALF_LIFE_DAYS = 7      # haberin etkisi 7 günde yarıya iner
SHRINK = 2.0            # az haberli hisselerde skoru sıfıra çeker (tek haber ±100 yapmasın)
HIGH_SEVERITY = -0.6    # bu ve altındaki duygu "ciddi" sayılır
CIRCUIT_BREAKER_ALERT = 10  # 30 günde bu kadar ve üzeri devre kesici = aşırı oynaklık (BIST'te medyan ~4)
RECENT_DAYS = 14
UNKNOWN_AGE_DAYS = 15.0  # tarihi olmayan haberler bu kadar eski sayılır
# Fiyat yorumları ve devre kesici kendi başına şirket riski sayılmaz, sadece bilgi
SOFT_CATEGORIES = {MARKET, VOLATILITY}


def _normalize_title(t: str) -> str:
    return re.sub(r"\W+", " ", t.lower()).strip()


def select_candidates(scan: pd.DataFrame, top: int) -> pd.DataFrame:
    picks = []
    for _, g in scan.groupby("market"):
        g = g.sort_values("combined_score", ascending=False)
        picks += [g.head(top), g.tail(top)]
    if WATCHLIST_FILE.exists():
        lines = [ln.split("#")[0] for ln in WATCHLIST_FILE.read_text(encoding="utf-8").splitlines()]
        wl = {s.strip().upper() for ln in lines for s in ln.split() if s.strip()}
        picks.append(scan[scan["symbol"].isin(wl)])
    return pd.concat(picks).drop_duplicates("yf_symbol")


def collect_items(scan: pd.DataFrame, top: int, days: int) -> pd.DataFrame:
    bist_symbols = set(scan.loc[scan["market"] == "BIST", "symbol"])
    print(f"KAP: son {days} günün bildirimleri çekiliyor...")
    items = [x for x in fetch_kap(days) if x["symbol"] in bist_symbols]
    print(f"  {len(items)} bildirim (BIST evrenindeki hisseler)")

    cands = select_candidates(scan, top)
    print(f"Haber başlıkları: {len(cands)} aday hisse...")
    for i, row in enumerate(cands.itertuples(), 1):
        try:
            if row.market == "BIST":
                items += fetch_google_news_tr(row.symbol, days)
            else:
                items += fetch_yahoo_news(row.symbol, row.yf_symbol)
        except Exception as exc:  # Bir hissenin haberleri gelmezse diğerleri devam etsin
            print(f"  ! {row.symbol}: {exc}")
        if i % 25 == 0:
            print(f"  {i}/{len(cands)}")
        time.sleep(REQUEST_PAUSE_SEC)

    df = pd.DataFrame(items)
    df["published"] = pd.to_datetime(df["published"], utc=True)
    cutoff = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=days)
    df = df[df["published"].isna() | (df["published"] >= cutoff)]
    # KAP bildirimleri benzersiz bağlantıyla, haberler başlıkla tekilleştirilir
    # (aynı başlıklı KAP bildirimi farklı günlerde tekrar gelebilir, örn. günlük geri alım bildirimleri)
    df["_key"] = np.where(df["source"] == "KAP", df["url"], df["title"].map(_normalize_title))
    df = df.drop_duplicates(["symbol", "_key"]).drop(columns="_key")
    return classify_items(filter_relevant(df, scan))


# Tek başına şirketi ayırt etmeyen ilk kelimeler: bunlarda ilk iki kelime aranır ("türk hava")
GENERIC_FIRST_WORDS = {"türk", "türkiye", "anadolu", "ege", "akdeniz", "marmara", "doğu", "batı", "global",
                       "united", "american", "first", "general", "national", "new", "the"}


def _name_token(name: str) -> str:
    """Şirket adının ayırt edici başı: 'Apple Inc. - Common Stock' -> 'apple', 'Türk Hava Yolları' -> 'türk hava'."""
    words = re.findall(r"[^\W\d_][\w&'-]+", tr_lower(name or ""))
    if not words:
        return ""
    if words[0] in GENERIC_FIRST_WORDS and len(words) > 1:
        return f"{words[0]} {words[1]}"
    return words[0] if len(words[0]) >= 3 else ""


def filter_relevant(df: pd.DataFrame, scan: pd.DataFrame) -> pd.DataFrame:
    """Haber beslemeleri ilgili/benzer şirketlerin ya da gövdesinde hisse geçen genel haberleri de veriyor.
    Başlıkta hisse kodu ya da şirket adı geçmesi şartı aranır. KAP bildirimleri zaten şirkete özgüdür."""
    names = {(r.market, r.symbol): _name_token(r.name) for r in scan.itertuples()}

    def relevant(r) -> bool:
        if r.source == "KAP":
            return True
        title = r.title or ""
        token = names.get((r.market, r.symbol), "")
        return bool(re.search(rf"\b{re.escape(r.symbol)}\b", title, re.IGNORECASE)) or bool(
            token and token in tr_lower(title))
    return df[np.array([relevant(r) for r in df.itertuples()], dtype=bool)]


def classify_items(df: pd.DataFrame) -> pd.DataFrame:
    # Sadece başlık sınıflandırılır: KAP'ta özet alanı şirket adıdır, Yahoo özetleri ise
    # çoğu zaman başka şirketlerden ve genel ifadelerden bahsedip yanlış eşleşme üretiyor
    cls = [classify(r.title, "", "tr" if r.market == "BIST" else "en", r.kap_subject)
           for r in df.itertuples()]
    df["sentiment"] = [c.sentiment for c in cls]
    df["categories"] = [json.dumps(c.categories, ensure_ascii=False) for c in cls]
    df["matches"] = [json.dumps(c.matches, ensure_ascii=False) for c in cls]
    df["routine"] = [c.routine for c in cls]
    return df.sort_values("published", ascending=False).reset_index(drop=True)


def summarize(items: pd.DataFrame) -> pd.DataFrame:
    now = pd.Timestamp.now(tz="UTC")
    rows = []
    for (market, sym), g in items[~items["routine"]].groupby(["market", "symbol"]):
        age = ((now - g["published"]).dt.total_seconds() / 86400).fillna(UNKNOWN_AGE_DAYS)
        w = 0.5 ** (age / HALF_LIFE_DAYS)
        # Aynı konulu tekrarlayan KAP bildirimleri (günlük geri alım, devre kesici) toplamda tek haber ağırlığında
        subj = g["kap_subject"].fillna("")
        repeats = subj.map(subj[subj != ""].value_counts()).fillna(1)
        w = w / repeats
        score = 100 * float((w * g["sentiment"]).sum() / (w.sum() + SHRINK))

        flags = {}
        for r, a in zip(g.itertuples(), age):
            if r.sentiment >= 0:
                continue
            for cat in json.loads(r.categories):
                f = flags.setdefault(cat, {"category": cat, "count": 0, "severe": False, "latest": None})
                f["count"] += 1
                f["severe"] |= r.sentiment <= HIGH_SEVERITY and a <= RECENT_DAYS
                if f["latest"] is None:  # items yeniden eskiye sıralı
                    f["latest"] = {"title": r.title, "url": r.url, "date": r.published.date().isoformat()
                                   if pd.notna(r.published) else None, "source": r.source}
        hard = [f for f in flags.values() if f["category"] not in SOFT_CATEGORIES]
        if any(f["severe"] for f in hard):
            news_risk = "Yüksek"
        elif hard or score < -20:
            news_risk = "Orta"
        else:
            news_risk = "Düşük"

        signal = g[g["sentiment"] != 0]
        top = signal.reindex(signal["sentiment"].abs().sort_values(ascending=False).index).head(5)
        rows.append({
            "market": market,
            "symbol": sym,
            "news_score": round(score, 1),
            "news_count": len(g),
            "news_positive": int((g["sentiment"] > 0).sum()),
            "news_negative": int((g["sentiment"] < 0).sum()),
            "circuit_breakers": int(g["kap_subject"].str.contains("Devre Kesici", na=False).sum()),
            "news_risk": news_risk,
            "risk_flags": json.dumps(sorted(flags.values(), key=lambda f: (-f["severe"], -f["count"])),
                                     ensure_ascii=False),
            "top_news": json.dumps([{
                "title": r.title, "url": r.url, "source": r.source, "sentiment": round(r.sentiment, 2),
                "date": r.published.date().isoformat() if pd.notna(r.published) else None,
            } for r in top.itertuples()], ensure_ascii=False),
        })
    return pd.DataFrame(rows)


def _overall_risk(r) -> str:
    """Teknik volatilite + haber riski + dip bölgesi + derin düşüş -> genel risk seviyesi."""
    pts = {"Düşük": 0, "Orta": 1, "Yüksek": 2}[r["volatility"]]
    pts += {"Düşük": 0, "Orta": 1, "Yüksek": 3}.get(r.get("news_risk") or "Düşük", 0)
    pts += 1 if r.get("at_new_low") else 0
    pts += 1 if (r.get("max_drawdown_1y_pct") or 0) < -50 else 0
    pts += 1 if (r.get("circuit_breakers") or 0) >= CIRCUIT_BREAKER_ALERT else 0
    return "Yüksek" if pts >= 4 else "Orta" if pts >= 2 else "Düşük"


def _alerts(r) -> list[str]:
    out = []
    ns, ts = r.get("news_score"), r["combined_score"]
    if pd.notna(ns):
        if ts >= 15 and ns <= -20:
            out.append("Teknik görünüm olumlu ama haber akışı olumsuz: dikkat")
        if ts <= -15 and ns >= 20:
            out.append("Teknik görünüm olumsuz ama haber akışı olumlu: dönüş sinyali olabilir, teyit bekleyin")
    if r.get("news_risk") == "Yüksek":
        flags = [f["category"] for f in json.loads(r["risk_flags"])
                 if f["severe"] and f["category"] not in SOFT_CATEGORIES]
        out.append("Ciddi risk haberi: " + ", ".join(flags))
    if (r.get("circuit_breakers") or 0) >= CIRCUIT_BREAKER_ALERT:
        out.append(f"Son dönemde {int(r['circuit_breakers'])} kez devre kesici: aşırı oynaklık")
    return out


def merge_into_scan(summary: pd.DataFrame) -> pd.DataFrame:
    scan = pd.read_parquet(RESULTS_FILE)
    scan = scan.drop(columns=[c for c in summary.columns if c not in ("market", "symbol") and c in scan.columns]
                     + [c for c in ("overall_risk", "alerts") if c in scan.columns])
    scan = scan.merge(summary, on=["market", "symbol"], how="left")
    scan["news_risk"] = scan["news_risk"].fillna("Düşük")
    scan["overall_risk"] = scan.apply(_overall_risk, axis=1)
    scan["alerts"] = [json.dumps(_alerts(r), ensure_ascii=False) for _, r in scan.iterrows()]
    scan.to_parquet(RESULTS_FILE, index=False)
    scan.to_csv(DATA_DIR / "scan_results.csv", index=False, encoding="utf-8-sig")
    return scan


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--top", type=int, default=30, help="Her piyasada en yüksek/en düşük N hisse için haber çek")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--reclassify", action="store_true", help="Haberleri yeniden indirmeden, kayıtlıları yeniden sınıflandır")
    args = p.parse_args()
    t0 = time.time()

    if args.reclassify:
        items = classify_items(filter_relevant(pd.read_parquet(ITEMS_FILE), pd.read_parquet(RESULTS_FILE)))
    else:
        items = collect_items(pd.read_parquet(RESULTS_FILE), args.top, args.days)
    items.to_parquet(ITEMS_FILE, index=False)
    summary = summarize(items)
    summary.to_parquet(SUMMARY_FILE, index=False)
    merged = merge_into_scan(summary)

    print(f"\n{len(items)} haber/bildirim, {len(summary)} hisse için özet ({time.time() - t0:.0f} sn)")
    print("Kaynaklara göre:", items["source"].str.replace(r" \(.*\)", "", regex=True).value_counts().to_dict())
    print("Haber riski:", merged.groupby("market")["news_risk"].value_counts().unstack().to_dict("index"))
    print("Genel risk:", merged.groupby("market")["overall_risk"].value_counts().unstack().to_dict("index"))
    n_alert = (merged["alerts"] != "[]").sum()
    print(f"Uyarısı olan hisse: {n_alert}")


if __name__ == "__main__":
    main()
