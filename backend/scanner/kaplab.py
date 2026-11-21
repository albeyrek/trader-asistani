"""KAP olayları portföy testi: kanıtlanan KAP olaylarına göre aday elemek / öne almak asistanın kazancını artırır mı?

python -m scanner.kaplab        (bulutta: .github/workflows/research.yml, modül "kaplab"; 10 yıllık fiyat gerekir)

Bir olayın fiyatı etkilemesi (kap_events.py) tek başına yetmez; asistanın portföyünü iyileştirmesi gerekir. Geleceği
görmemek için "kanıtlanan olaylar" her yıl yalnızca o yıldan önceki olaylarla belirlenir (kayan seçim): Y yılında
kullanılan liste, Y'den en az 30 gün önce sonuçlanmış olaylardan, kap_events'in kendi şartıyla (en az 80 olay,
|t| >= 2,5, yılların en az %60'ında aynı yön) ve en az 2 yıllık veriyle çıkar.
Seçenekler ve kabul şartı sonuca bakmadan önce sabitlendi (yalnızca BIST; canlı kurallar ve portföy düzeni aynen):
  kap_ele  : kanıtlanmış OLUMSUZ bir olay son 5 iş gününde yayınlandıysa aday elenir
  kap_one  : kanıtlanmış OLUMLU bir olay son 20 iş gününde yayınlandıysa aday o gün sıralamada öne alınır
  kap_ikisi: ikisi birden
  kabul: exitlab.better (getiri/düşüş oranı en az %10 iyi ve yıllık getiri kaybı <= 2 puan, ya da yıllık getiri en
  az 3 puan iyi ve oran kötüleşmiyor), yılların en az %60'ında şimdikinden iyi ve komşu seçenek de iyi
  (kap_ele <-> kap_ikisi, kap_one <-> kap_ikisi).
"""
import json
import time

import numpy as np
import pandas as pd

from . import history, kap_events, kap_history, paper
from .config import DATA_DIR
from .drawdown import summary
from .exitlab import better

OUT_FILE = DATA_DIR / "model" / "kaplab_test.json"
NEG_DAYS, POS_DAYS = 5, 20          # olumsuz olay için son 5, olumlu olay için son 20 iş günü
BOOST = 1000.0                       # öne alma: o günün sıralamasında olumlu olaylı adaylar önce
KNOWN_HOUR = 18                      # sinyal günü 18:00'e kadar yayınlanan bildirim (tarama BIST kapanışından sonra)
MIN_YEARS = 2                        # kayan seçimde kanıt için en az bu kadar yıllık geçmiş
VARIANTS = ["kap_ele", "kap_one", "kap_ikisi"]
NEIGHBORS = {"kap_ele": ["kap_ikisi"], "kap_one": ["kap_ikisi"], "kap_ikisi": ["kap_ele", "kap_one"]}
MIN_YEARS_BETTER = 0.6


def proven_by_year(m: pd.DataFrame, years) -> dict[int, dict[str, int]]:
    """Her yıl için o yıldan önce kanıtlanan olaylar: {yıl: {olay: yön (+1/-1)}}."""
    out = {}
    for y in years:
        past = m[m["date"] < pd.Timestamp(f"{y}-01-01") - pd.Timedelta(days=30)]
        out[y] = {}
        if past.empty:
            continue
        for r in kap_events.summarize(past):
            h = r.get("20g") or r.get("5g")
            if r["proven"] and h and h.get("years", 0) >= MIN_YEARS:
                out[y][r["event"]] = r["direction"]
    return out


def event_flags(g: pd.DataFrame, ev: pd.DataFrame, proven: dict[int, dict[str, int]]) -> tuple[np.ndarray, np.ndarray]:
    """Her aday (symbol, date) için: son NEG_DAYS iş gününde kanıtlanmış olumsuz, son POS_DAYS iş gününde kanıtlanmış
    olumlu olay var mı? Yalnızca sinyal günü KNOWN_HOUR'a kadar yayınlanmış bildirimler (o gün bilinenler)."""
    times = {k: np.sort(grp["published"].to_numpy(dtype="datetime64[ns]")) for k, grp in ev.groupby(["symbol", "event"])}
    neg, pos = np.zeros(len(g), dtype=bool), np.zeros(len(g), dtype=bool)
    syms = g["symbol"].fillna(g["yf_symbol"].str.removesuffix(".IS")).to_numpy()
    dates = pd.to_datetime(g["date"]).to_numpy()
    for i, (sym, d) in enumerate(zip(syms, dates)):
        d = pd.Timestamp(d)
        until = np.datetime64(d + pd.Timedelta(hours=KNOWN_HOUR))
        for event, direction in proven.get(d.year, {}).items():
            arr = times.get((sym, event))
            if arr is None:
                continue
            lo = np.datetime64(d - pd.offsets.BDay(NEG_DAYS if direction < 0 else POS_DAYS))
            if np.searchsorted(arr, until, side="right") > np.searchsorted(arr, lo, side="left"):
                if direction < 0:
                    neg[i] = True
                else:
                    pos[i] = True
    return neg, pos


def make_adjust(kind: str, ev: pd.DataFrame, proven: dict[int, dict[str, int]], counts: dict):
    def adjust(g: pd.DataFrame, market: str) -> pd.DataFrame:
        if market != "BIST":
            return g
        neg, pos = event_flags(g, ev, proven)
        counts[kind] = {"candidates": int(len(g)), "negative": int(neg.sum()), "positive": int(pos.sum())}
        if kind in ("kap_one", "kap_ikisi"):
            g = g.assign(quality=g["quality"] + np.where(pos, BOOST, 0.0))
        if kind in ("kap_ele", "kap_ikisi"):
            g = g[~neg]
        return g
    return adjust


def decide(rows: dict[str, dict]) -> dict:
    base = rows["simdiki"]
    for k, r in rows.items():
        if k == "simdiki":
            continue
        yrs = [y for y in r["years"] if y in base["years"]]
        r["years_better"] = round(sum(r["years"][y] > base["years"][y] for y in yrs) / max(len(yrs), 1), 2)
        r["improves"] = bool(better(r, base))
    passed = [k for k, r in rows.items() if k != "simdiki" and r["improves"] and r["years_better"] >= MIN_YEARS_BETTER
              and any(rows[n]["cagr"] >= base["cagr"] or (rows[n]["ratio"] or 0) >= (base["ratio"] or 0)
                      for n in NEIGHBORS[k])]
    return {"chosen": max(passed, key=lambda k: rows[k]["ratio"] or -9) if passed else None, "passed": passed}


def main() -> None:
    from .scan import scan_universe
    t0 = time.time()
    kap = kap_history.load()
    symbols = set(scan_universe("BIST")["symbol"])
    ev = kap_events.events_table(kap, symbols)
    m = kap_events.measure(ev, history.load_long())
    years = range(int(paper.BACKTEST_START[:4]), pd.Timestamp.now().year + 1)
    proven = proven_by_year(m, years)
    for y, p in proven.items():
        print(f"{y} için kanıtlanan (önceki yıllardan): {p or 'yok'}", flush=True)
    smap = paper._sector_map()
    counts: dict = {}
    rows = {}
    for key in ["simdiki", *VARIANTS]:
        adjust = None if key == "simdiki" else make_adjust(key, ev, proven, counts)
        prices, inputs = paper.backtest_signals(adjust=adjust)
        sig = inputs["BIST"][0]
        res = paper.simulate(sig, prices, "BIST", start=paper.BACKTEST_START, **paper._sim_kwargs("BIST", smap))
        rows[key] = summary(res)
        r = rows[key]
        print(f"BIST {key:10} yıllık %{r['cagr']:6.2f}  düşüş %{r['max_dd']:7.2f}  oran {r['ratio']}  işlem {r['trades']}  "
              f"ort. {r['avg_r']}R  {counts.get(key, '')}", flush=True)
    dec = decide(rows)
    print(pd.DataFrame({k: v["years"] for k, v in rows.items()}).to_string(), flush=True)
    print(f"BIST: kabul edilen {dec['passed'] or 'yok'} -> seçilen {dec['chosen'] or 'değişiklik yok'}", flush=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps({
        "generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "proven_by_year": {str(k): v for k, v in proven.items()},
        "counts": counts, "variants": rows, **dec,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
