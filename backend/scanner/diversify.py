"""Çeşitlendirme testi: daha çok aday ve pozisyon (işlem başına daha az riskle) ve sektör sınırı kazancı artırır mı?

python -m scanner.diversify        (bulutta: .github/workflows/research.yml, modül "diversify")

Gerekçe: testlerde kuralların seçtiği ilk 5 aday ile süzgeçten geçen bütün adayların ortalaması neredeyse aynı;
sıralama değer katmıyorsa haftada yalnızca 5 aday almak gereksiz bir kısıt olabilir. Aynı sektörde yoğunlaşma da
toplu düşüşlerin (2021) kaynağı olabilir.
Seçenekler ve kabul şartı sonuca bakmadan önce sabitlendi (canlı kurallar: rejim, düşüş freni, maliyet, likidite):
  şimdiki: haftada 5 aday, en çok 10 pozisyon, işlem başına %1 risk
  geniş8 : 8 aday, 15 pozisyon, %0,75     geniş10: 10 aday, 20 pozisyon, %0,6
  +sektör3: aynı sektörde en çok 3 açık pozisyon
  kabul: getiri/düşüş oranı en az %10 iyi, yıllık getiriden en fazla 2 puan kayıp, komşu seçenek de oranı iyileştirir.
"""
import json
import time

import pandas as pd

from . import paper, research
from .config import DATA_DIR
from .drawdown import summary

OUT_FILE = DATA_DIR / "model" / "diversify_test.json"
VARIANTS = {
    "simdiki": {"top_k": 5, "max_positions": 10, "risk_pct": 0.01, "sector_cap": None},
    "genis8": {"top_k": 8, "max_positions": 15, "risk_pct": 0.0075, "sector_cap": None},
    "genis10": {"top_k": 10, "max_positions": 20, "risk_pct": 0.006, "sector_cap": None},
    "sektor3": {"top_k": 5, "max_positions": 10, "risk_pct": 0.01, "sector_cap": 3},
    "genis8_sektor3": {"top_k": 8, "max_positions": 15, "risk_pct": 0.0075, "sector_cap": 3},
    "genis10_sektor3": {"top_k": 10, "max_positions": 20, "risk_pct": 0.006, "sector_cap": 3},
}
NEIGHBORS = {"genis8": ["genis10"], "genis10": ["genis8"], "sektor3": ["genis8_sektor3"],
             "genis8_sektor3": ["sektor3", "genis10_sektor3", "genis8"], "genis10_sektor3": ["genis8_sektor3", "genis10"]}
MIN_RATIO_GAIN, MAX_CAGR_LOSS = 0.10, 2.0


def decide(rows: dict[str, dict]) -> dict:
    base = rows["simdiki"]
    ok = {}
    for k, r in rows.items():
        if k == "simdiki" or not r["ratio"] or not base["ratio"] or base["ratio"] <= 0:
            continue
        r["ratio_gain"] = round(r["ratio"] / base["ratio"] - 1, 3)
        ok[k] = r["ratio_gain"] >= MIN_RATIO_GAIN and base["cagr"] - r["cagr"] <= MAX_CAGR_LOSS
    passed = [k for k, v in ok.items() if v and any(rows[n].get("ratio_gain", -1) > 0 for n in NEIGHBORS[k])]
    return {"chosen": max(passed, key=lambda k: rows[k]["ratio"]) if passed else None, "passed": passed}


def main() -> None:
    t0 = time.time()
    smap = research.sector_map()
    inputs_by_k = {}
    out = {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "variants": VARIANTS,
           "rule": {"min_ratio_gain": MIN_RATIO_GAIN, "max_cagr_loss": MAX_CAGR_LOSS}, "markets": {}}
    prices = None
    for k in sorted({v["top_k"] for v in VARIANTS.values()}):
        prices, inputs_by_k[k] = paper.backtest_signals(top_k=k)
    rows_by_market: dict[str, dict] = {}
    for key, v in VARIANTS.items():
        for market, (sig, _, _) in inputs_by_k[v["top_k"]].items():
            res = paper.simulate(sig, prices, market, start=paper.BACKTEST_START, brake=paper.BRAKE.get(market),
                                 risk_pct=v["risk_pct"], max_positions=v["max_positions"],
                                 sector_cap=v["sector_cap"], sector_of=smap)
            r = summary(res)
            r["exposure"] = res["exposure_pct"]
            rows_by_market.setdefault(market, {})[key] = r
            print(f"{market} {key:16} yıllık %{r['cagr']:6.2f}  düşüş %{r['max_dd']:7.2f}  oran {r['ratio']}  "
                  f"işlem {r['trades']}  ort. {r['avg_r']}R  yatırımda %{r['exposure']}", flush=True)
    for market, rows in rows_by_market.items():
        dec = decide(rows)
        out["markets"][market] = {"variants": rows, **dec}
        print(pd.DataFrame({k: v["years"] for k, v in rows.items()}).to_string(), flush=True)
        print(f"{market}: kabul edilen {dec['passed'] or 'yok'} -> seçilen {dec['chosen'] or 'değişiklik yok'}", flush=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
