"""Düşüş kontrolü testi: stratejinin kendi durumu kötüleşince yeni pozisyonları küçültmek düşüşleri yumuşatır mı?

python -m scanner.drawdown        (bulutta: .github/workflows/research.yml, modül "drawdown")

Seçenekler ve kabul şartı sonuca bakmadan önce sabitlendi (geçmişe uydurma olmasın):
  - düşüş freni: portföy zirvesinden %15 / %20 / %25 düşünce yeni pozisyonlar yarıya
  - form freni: son 10 / 20 kapanan işlemin ortalama R'si <= 0 ise yeni pozisyonlar yarıya
  - kabul: getiri/düşüş oranı en az %10 iyileşir, yıllık getiriden en fazla 3 puan kaybettirir ve aynı türdeki
    komşu eşik de oranı iyileştirir (tek bir eşikte şans eseri işe yarayan kural seçilmesin).
Test portföyü canlı kurallarla (rejim, liste sınırı, yıl yıl çıkış kuralı, maliyet, likidite) paper.backtest ile aynı.
"""
import json
import time

import pandas as pd

from . import paper
from .config import DATA_DIR

OUT_FILE = DATA_DIR / "model" / "drawdown_test.json"
VARIANTS = {
    "yok": None,
    "dd15": {"kind": "dd", "level": -0.15, "scale": 0.5},
    "dd20": {"kind": "dd", "level": -0.20, "scale": 0.5},
    "dd25": {"kind": "dd", "level": -0.25, "scale": 0.5},
    "form10": {"kind": "form", "n": 10, "scale": 0.5},
    "form20": {"kind": "form", "n": 20, "scale": 0.5},
}
NEIGHBORS = {"dd15": ["dd20"], "dd20": ["dd15", "dd25"], "dd25": ["dd20"], "form10": ["form20"], "form20": ["form10"]}
MIN_RATIO_GAIN, MAX_CAGR_LOSS = 0.10, 3.0


def yearly(res: dict) -> dict[str, float]:
    c = pd.DataFrame(res["curve"], columns=["d", "eq", "ix"])
    c["y"] = c["d"].str[:4]
    e = c.groupby("y")["eq"].last()
    return {y: round(float(v), 1) for y, v in ((e / e.shift().fillna(res["capital"]) - 1) * 100).items()}


def summary(res: dict) -> dict:
    ratio = res["cagr_pct"] / -res["max_dd_pct"] if res["max_dd_pct"] < 0 else None
    return {"cagr": res["cagr_pct"], "max_dd": res["max_dd_pct"], "ratio": round(ratio, 3) if ratio else None,
            "trades": res["trades"], "avg_r": res["avg_r"], "brake_buys": res.get("brake_buys", 0), "years": yearly(res)}


def decide(rows: dict[str, dict]) -> dict:
    base = rows["yok"]
    ok = {}
    for k, r in rows.items():
        if k == "yok" or not r["ratio"] or not base["ratio"]:
            continue
        gain = r["ratio"] / base["ratio"] - 1
        ok[k] = gain >= MIN_RATIO_GAIN and base["cagr"] - r["cagr"] <= MAX_CAGR_LOSS
        r["ratio_gain"] = round(gain, 3)
    passed = [k for k, v in ok.items() if v and any(rows[n].get("ratio_gain", -1) > 0 for n in NEIGHBORS[k])]
    best = max(passed, key=lambda k: rows[k]["ratio"]) if passed else None
    return {"chosen": best, "passed": passed}


def main() -> None:
    t0 = time.time()
    prices, inputs = paper.backtest_signals()
    out = {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "variants": VARIANTS,
           "rule": {"min_ratio_gain": MIN_RATIO_GAIN, "max_cagr_loss": MAX_CAGR_LOSS}, "markets": {}}
    for market, (sig, _, _) in inputs.items():
        rows = {}
        for key, brake in VARIANTS.items():
            res = paper.simulate(sig, prices, market, start=paper.BACKTEST_START, brake=brake)
            rows[key] = summary(res)
            r = rows[key]
            print(f"{market} {key:7} yıllık %{r['cagr']:6.2f}  düşüş %{r['max_dd']:7.2f}  oran {r['ratio']}  "
                  f"işlem {r['trades']}  frenli alım {r['brake_buys']}", flush=True)
        dec = decide(rows)
        out["markets"][market] = {"variants": rows, **dec}
        yrs = pd.DataFrame({k: v["years"] for k, v in rows.items()})
        print(yrs.to_string(), flush=True)
        print(f"{market}: kabul edilen {dec['passed'] or 'yok'} -> seçilen {dec['chosen'] or 'fren yok'}", flush=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
