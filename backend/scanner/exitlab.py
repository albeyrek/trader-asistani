"""Çıkış kuralları 2.0: yeni çıkış kuralları portföy düzeyinde (sermaye, pozisyon sınırı, maliyet) kazancı artırır mı?

python -m scanner.exitlab        (bulutta: .github/workflows/research.yml, modül "exitlab")

Neden portföy testi? Haftalık seçim (exits.py) kuralları işlem başına ortalama R ile seçer; uzun tutan bir kural
işlem başına daha çok R getirip parayı daha uzun bağlayarak toplamda kaybettirebilir. Burada her kural aynı sinyallerle
2018'den beri sanal portföyde (canlı kurallar: rejim, düşüş freni, maliyet, likidite) çalıştırılır ve şimdiki düzenle
(her yıl önceki yıllara göre seçilen kural) karşılaştırılır.
Seçenekler ve kabul şartı sonuca bakmadan önce sabitlendi:
  kabul: (getiri/düşüş oranı en az %10 iyi ve yıllık getiri kaybı <= 2 puan) ya da (yıllık getiri en az 3 puan iyi ve
  oran kötüleşmiyor); ayrıca yılların en az %60'ında şimdikinden iyi ve parametre komşusu da şimdikinden iyi.
"""
import json
import time

import pandas as pd

from . import paper
from .config import DATA_DIR
from .drawdown import summary

OUT_FILE = DATA_DIR / "model" / "exitlab_test.json"
RULES = {
    "trail2": {"target": None, "hold": 60, "trail": 2.0},
    "trail25": {"target": None, "hold": 60, "trail": 2.5},
    "trail3": {"target": None, "hold": 60, "trail": 3.0},
    "trail35": {"target": None, "hold": 60, "trail": 3.5},
    "trail3_40": {"target": None, "hold": 40, "trail": 3.0},
    "trail3_90": {"target": None, "hold": 90, "trail": 3.0},
    "half": {"target": None, "hold": 60, "trail": 3.0, "partial": 1.5},
    "half2": {"target": None, "hold": 60, "trail": 3.0, "partial": 2.0},
    "trail3_be": {"target": None, "hold": 60, "trail": 3.0, "breakeven": 1.0},
}
NEIGHBORS = {"trail2": ["trail25"], "trail25": ["trail2", "trail3"], "trail3": ["trail25", "trail35"],
             "trail35": ["trail3"], "trail3_40": ["trail3"], "trail3_90": ["trail3"], "half": ["half2"],
             "half2": ["half"], "trail3_be": ["trail3"]}
MIN_RATIO_GAIN, MAX_CAGR_LOSS, MIN_CAGR_GAIN, MIN_YEARS = 0.10, 2.0, 3.0, 0.6


def better(r: dict, base: dict) -> bool:
    if not r["ratio"] or not base["ratio"] or base["ratio"] <= 0:
        return False
    gain = r["ratio"] / base["ratio"] - 1
    return (gain >= MIN_RATIO_GAIN and base["cagr"] - r["cagr"] <= MAX_CAGR_LOSS) or \
        (r["cagr"] - base["cagr"] >= MIN_CAGR_GAIN and gain >= 0)


def decide(rows: dict[str, dict]) -> dict:
    base = rows["simdiki"]
    for k, r in rows.items():
        if k == "simdiki":
            continue
        yrs = [y for y in r["years"] if y in base["years"]]
        r["years_better"] = round(sum(r["years"][y] > base["years"][y] for y in yrs) / max(len(yrs), 1), 2)
        r["improves"] = bool(better(r, base))  # numpy bool JSON yazılamaz
    passed = [k for k, r in rows.items() if k != "simdiki" and r["improves"] and r["years_better"] >= MIN_YEARS
              and any(rows[n]["cagr"] >= base["cagr"] or (rows[n]["ratio"] or 0) >= (base["ratio"] or 0)
                      for n in NEIGHBORS[k])]
    return {"chosen": max(passed, key=lambda k: rows[k]["ratio"]) if passed else None, "passed": passed}


def main() -> None:
    t0 = time.time()
    prices, inputs = paper.backtest_signals()
    smap = paper._sector_map()
    out = {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "rules": RULES, "markets": {}}
    for market, (sig, wf, _) in inputs.items():
        rows = {}
        for key in ["simdiki", *RULES]:
            s = sig if key == "simdiki" else sig.assign(exit_rule=[{"name": key, **RULES[key]}] * len(sig))
            res = paper.simulate(s, prices, market, start=paper.BACKTEST_START, **paper._sim_kwargs(market, smap))
            rows[key] = summary(res)
            r = rows[key]
            print(f"{market} {key:10} yıllık %{r['cagr']:6.2f}  düşüş %{r['max_dd']:7.2f}  oran {r['ratio']}  "
                  f"işlem {r['trades']}  ort. {r['avg_r']}R", flush=True)
        dec = decide(rows)
        out["markets"][market] = {"variants": rows, "walk_forward_rules": {str(y): r for y, r in wf.items()}, **dec}
        print(pd.DataFrame({k: v["years"] for k, v in rows.items()}).to_string(), flush=True)
        print(f"{market}: kabul edilen {dec['passed'] or 'yok'} -> seçilen {dec['chosen'] or 'değişiklik yok'}", flush=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
