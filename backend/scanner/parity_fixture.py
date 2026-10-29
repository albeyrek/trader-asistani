"""JS sınıflandırıcısının (worker/src/classify.ts) Python'la aynı sonucu verdiğini test etmek için örnek üretir:
python -m scanner.parity_fixture  ->  worker/test/fixture.json

Gerçek haber başlıkları (data/news_items.parquet) + elle yazılmış zor örnekler, Python'un sonuçlarıyla birlikte.
"""
import json

import pandas as pd

from .config import ROOT
from .news import ITEMS_FILE, _name_token
from .sentiment import classify, rules_json

EXTRA = [
    ("Şirketimiz Ana Hissedarları Hakkındaki Tedbir Kararlarının Kaldırılması", "BIST", "Özel Durum Açıklaması (Genel)"),
    ("İhtiyati Tedbir Taleplerinin Reddine İlişkin Yerel Mahkeme Kararı", "BIST", "Ortaklık Aleyhine Dava Açılması veya Davaya İlişkin Gelişmeler"),
    ("4 hissede temerrüt alışı yapılacak", "BIST", ""),
    ("SPK, 5 hisse için tedbir kararı aldı: brüt takas uygulanacak", "BIST", ""),
    ("Borsada eylül depremi! 24 hisse yüzde 70'ten fazla eridi", "BIST", ""),
    ("İSTANBUL'da yangın: fabrikada üretim durduruldu", "BIST", ""),
    ("VERUS'ta Kredili İşlem Yasağı Kalkıyor", "BIST", ""),
    ("Pfizer investigational vaccine shows robust Phase 2 data", "US", ""),
    ("CrowdStrike vs. Docusign: Which Technology Stock Is a Better Buy?", "US", ""),
    ("Viavi software-defined test ranges selected by U.S. Army", "US", ""),
    ("3 Cash-Burning Stocks We Steer Clear Of", "US", ""),
    ("Apple beats estimates, raises guidance on strong iPhone demand", "US", ""),
    ("Lawsuit dismissed against ABC", "US", ""),
]


def main() -> None:
    items = pd.read_parquet(ITEMS_FILE)
    sample = pd.concat([
        items[items["source"] == "KAP"].sample(400, random_state=1),
        items[items["source"].str.startswith("Google")].sample(min(300, (items["source"].str.startswith("Google")).sum()), random_state=1),
        items[items["source"] == "Yahoo Finance"].sample(min(300, (items["source"] == "Yahoo Finance").sum()), random_state=1),
    ])
    rows = [(r.title, r.market, r.kap_subject or "") for r in sample.itertuples()] + EXTRA
    cases = []
    for title, market, subject in rows:
        c = classify(title, "", "tr" if market == "BIST" else "en", subject)
        cases.append({"title": title, "market": market, "kap_subject": subject,
                      "sentiment": round(c.sentiment, 6), "categories": c.categories, "routine": c.routine})
    names = ["Türk Hava Yolları", "Aselsan", "Apple Inc. - Common Stock", "İş Bankası (C)", "Ege Endüstri"]
    out = ROOT.parent / "worker" / "test" / "fixture.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"rules": rules_json(), "cases": cases,
                               "name_tokens": {n: _name_token(n) for n in names}}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(cases)} örnek -> {out}")


if __name__ == "__main__":
    main()
