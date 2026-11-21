"""Giriş kuralları testi: stop sonrası bekleme, haftalık giriş sınırı ve ABD'de ayı piyasa molası kazancı artırır mı?

python -m scanner.entrylab        (bulutta: .github/workflows/research.yml, modül "entrylab")

Neden? Kasım 2026'nın ilk üç haftasında (iki piyasa da düşüşe geçerken):
  - stop olan hisseler hemen yeniden listelendi (PCILT, USHOL, XGN, PACS) ve yine stop oldu,
  - aynı hafta açılan çok sayıda pozisyon birlikte stop oldu,
  - ABD'de 10 kapanan işlemin 9'u stop oldu; 10 yıllık testte de ABD'de zayıf piyasadaki kurulumlar zarar ettiriyordu.
Seçenekler ve kabul şartı sonuca bakmadan önce sabitlendi (canlı kurallar ve portföy düzeni aynen):
  bekleme10 / bekleme20: stop olan hisseye 10 / 20 iş günü yeniden girilmez
  hafta4 / hafta6: haftada en çok 4 / 6 yeni pozisyon
  abd_ayi_mola: yalnızca ABD'de, rejim Zayıf ya da Ayı iken yeni alım yok
  kabul: (getiri/düşüş oranı en az %10 iyi ve yıllık getiri kaybı <= 2 puan) ya da (yıllık getiri en az 3 puan iyi ve
  oran kötüleşmiyor); yılların en az %60'ında şimdikinden iyi; parametre komşusu da şimdikinden iyi (mola için yok).
"""
import json
import time

import pandas as pd

from . import paper
from .config import DATA_DIR
from .drawdown import summary
from .exitlab import better

OUT_FILE = DATA_DIR / "model" / "entrylab_test.json"
VARIANTS = {
    "bekleme10": {"cooldown_days": 10},
    "bekleme20": {"cooldown_days": 20},
    "hafta4": {"week_cap": 4},
    "hafta6": {"week_cap": 6},
    "abd_ayi_mola": {"pause_weak": True},
}
NEIGHBORS = {"bekleme10": ["bekleme20"], "bekleme20": ["bekleme10"], "hafta4": ["hafta6"], "hafta6": ["hafta4"],
             "abd_ayi_mola": []}
MIN_YEARS = 0.6


def decide(rows: dict[str, dict]) -> dict:
    base = rows["simdiki"]
    for k, r in rows.items():
        if k == "simdiki":
            continue
        yrs = [y for y in r["years"] if y in base["years"]]
        r["years_better"] = round(sum(r["years"][y] > base["years"][y] for y in yrs) / max(len(yrs), 1), 2)
        r["improves"] = bool(better(r, base))
    passed = [k for k, r in rows.items() if k != "simdiki" and r["improves"] and r["years_better"] >= MIN_YEARS
              and (not NEIGHBORS[k] or any(n in rows and (rows[n]["cagr"] >= base["cagr"]
                                                           or (rows[n]["ratio"] or 0) >= (base["ratio"] or 0))
                                           for n in NEIGHBORS[k]))]
    return {"chosen": max(passed, key=lambda k: rows[k]["ratio"] or -9) if passed else None, "passed": passed}


def main() -> None:
    t0 = time.time()
    prices, inputs = paper.backtest_signals()
    smap = paper._sector_map()
    out = {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "variants": VARIANTS, "markets": {}}
    for market, (sig, _, _) in inputs.items():
        kw = paper._sim_kwargs(market, smap)
        rows = {}
        for key, v in {"simdiki": {}, **VARIANTS}.items():
            if v.get("pause_weak") and market != "US":
                continue
            s = sig[~sig["regime"].isin(["Zayıf", "Ayı"])] if v.get("pause_weak") else sig
            extra = {k: val for k, val in v.items() if k != "pause_weak"}
            res = paper.simulate(s, prices, market, start=paper.BACKTEST_START, **kw, **extra)
            rows[key] = summary(res)
            r = rows[key]
            print(f"{market} {key:13} yıllık %{r['cagr']:6.2f}  düşüş %{r['max_dd']:7.2f}  oran {r['ratio']}  "
                  f"işlem {r['trades']}  ort. {r['avg_r']}R", flush=True)
        dec = decide(rows)
        out["markets"][market] = {"variants": rows, **dec}
        print(pd.DataFrame({k: v["years"] for k, v in rows.items()}).to_string(), flush=True)
        print(f"{market}: kabul edilen {dec['passed'] or 'yok'} -> seçilen {dec['chosen'] or 'değişiklik yok'}", flush=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
