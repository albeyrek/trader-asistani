"""Çıkış kuralları karşılaştırması (araştırma): python -m scanner.exits

Asistanın 10 yıllık yeniden oynatmasındaki girişler (learn.py örnekleri) sabit tutulur; sadece pozisyondan çıkış kuralı
değiştirilir. Her kural için işlem başına ortalama R, isabet, ortalama tutma süresi ve "her hafta ilk 5" sonucu ölçülür.
Aşırı uyumu önlemek için kayan seçim yapılır: her yıl, o yıldan ÖNCEKİ yıllarda en iyi olan kural seçilip o yılda
test edilir (geleceği görmeden). Sonuç data/exits_report.json / .txt.

R: girişten stopa kadar olan mesafe (1R kayıp = stop). Kısmi kâr alan kurallarda R parçaların ağırlıklı toplamıdır.
"""
import json
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from . import assistant_track, history, learn
from .config import DATA_DIR

REPORT_JSON = DATA_DIR / "exits_report.json"
REPORT_TXT = DATA_DIR / "exits_report.txt"
MIN_GAIN_R = 0.05  # yeni kural ancak hem tüm geçmişte hem yıl yıl testte temel plandan en az bu kadar iyiyse seçilir
ENTRY_DAYS = assistant_track.ENTRY_DAYS
MAX_BARS = 60

# Kural adı -> (açıklama, parametreler)
POLICIES = {
    "base": ("Şu anki plan: ilk direnç hedefi, 20 gün", {"target": "plan", "hold": 20}),
    "t15": ("Hedef 1,5R, 20 gün", {"target": 1.5, "hold": 20}),
    "t2": ("Hedef 2R, 20 gün", {"target": 2.0, "hold": 20}),
    "t3": ("Hedef 3R, 30 gün", {"target": 3.0, "hold": 30}),
    "plan40": ("Plan hedefi, 40 gün", {"target": "plan", "hold": 40}),
    "plan10": ("Plan hedefi, 10 gün", {"target": "plan", "hold": 10}),
    "be": ("Plan hedefi + 1R kârda stop başa-başa", {"target": "plan", "hold": 20, "breakeven": 1.0}),
    "trail3": ("Hedef yok, iz süren stop (3 ATR), en çok 60 gün", {"target": None, "hold": 60, "trail": 3.0}),
    "trail2": ("Hedef yok, iz süren stop (2 ATR), en çok 60 gün", {"target": None, "hold": 60, "trail": 2.0}),
    "half": ("Yarısı 1,5R'de, kalanı iz süren stop (3 ATR)", {"target": None, "hold": 60, "trail": 3.0, "partial": 1.5}),
}


def _symbol(args) -> list[dict]:
    bars, samples = args
    dates = bars["date"].to_numpy()
    o, h, l, c = (bars[k].to_numpy() for k in ("open", "high", "low", "close"))
    out = []
    for s in samples.itertuples():
        i = int(np.searchsorted(dates, np.datetime64(s.date), side="right"))  # sinyal gününden sonraki ilk mum
        if i + ENTRY_DAYS >= len(c):
            continue
        fill_i = None
        for k in range(i, i + ENTRY_DAYS):
            if l[k] <= s.entry_high and h[k] >= s.entry_low:
                fill_i, fill = k, min(max(o[k], s.entry_low), s.entry_high)
                break
        if fill_i is None or fill <= s.stop or fill_i + MAX_BARS >= len(c):
            continue  # girilmedi ya da sonuç henüz belli değil
        risk = fill - s.stop
        atr = s.atr_pct / 100 * s.close
        row = {"yf_symbol": s.yf_symbol, "market": s.market, "date": s.date, "live": s.live, "quality": s.quality}
        for name, (_, p) in POLICIES.items():
            target = s.target1 if p["target"] == "plan" else (fill + p["target"] * risk if p["target"] else None)
            r, days, _, _ = assistant_track.run_exit(o, h, l, c, fill_i, fill, s.stop, target, p["hold"], atr,
                                                     p.get("trail"), p.get("breakeven"), p.get("partial"))
            row[f"r_{name}"] = float(np.clip(r, -3, 10))
            row[f"d_{name}"] = days
        out.append(row)
    return out


def collect(workers: int | None = None) -> pd.DataFrame:
    s = pd.read_parquet(learn.SAMPLES_FILE)
    s = s[s["status"] != "not_filled"].copy()
    s["live"] = learn.live_like(s)
    s["quality"] = [learn.rule_quality(f) for f in s[["combined_score", "rs_rating", "rr", "ext_atr"]].to_dict("records")]
    prices = history.load_long()
    prices = prices[prices["yf_symbol"].isin(s["yf_symbol"].unique())].sort_values(["yf_symbol", "date"])
    by = dict(tuple(prices.groupby("yf_symbol")))
    tasks = [(by[sym].reset_index(drop=True), g) for sym, g in s.groupby("yf_symbol") if sym in by]
    rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(_symbol, tasks, chunksize=20):
            rows.extend(res)
    return pd.DataFrame(rows)


def _stats(df: pd.DataFrame, name: str) -> dict:
    r, d = df[f"r_{name}"], df[f"d_{name}"]
    weekly = df.sort_values("quality", ascending=False).groupby(["market", "date"]).head(learn.TOP_K)
    return {"n": int(len(r)), "avg_r": round(float(r.mean()), 3), "std_r": round(float(r.std()), 3),
            "median_r": round(float(r.median()), 3),
            "win": round(float((r > 0).mean()) * 100, 1), "avg_days": round(float(d.mean()), 1),
            "r_per_20d": round(float(r.sum() / d.sum() * 20), 3),
            "top5_r": round(float(weekly[f"r_{name}"].mean()), 3)}


def walk_forward(df: pd.DataFrame) -> dict:
    """Her yıl için: önceki yıllarda (en az 2 yıl) en iyi ortalama R'li kural seçilir, o yılda uygulanır."""
    years = sorted(df["date"].dt.year.unique())
    rows = []
    for y in years:
        past, now = df[df["date"].dt.year < y], df[df["date"].dt.year == y]
        if past["date"].dt.year.nunique() < 2 or len(now) < 50:
            continue
        best = max(POLICIES, key=lambda p: past[f"r_{p}"].mean())
        rows.append({"year": int(y), "chosen": best, "chosen_r": round(float(now[f"r_{best}"].mean()), 3),
                     "base_r": round(float(now["r_base"].mean()), 3), "n": int(len(now)),
                     "best_in_hindsight": max(POLICIES, key=lambda p: now[f"r_{p}"].mean())})
    total = sum(r["n"] for r in rows)
    return {
        "years": rows,
        "oos_chosen_r": round(sum(r["chosen_r"] * r["n"] for r in rows) / total, 3) if total else None,
        "oos_base_r": round(sum(r["base_r"] * r["n"] for r in rows) / total, 3) if total else None,
    }


def select(pol: dict, wf: dict) -> dict:
    """Piyasa için kullanılacak çıkış kuralı: canlı süzgeçten geçen girişlerde en yüksek ortalama R'li kural; ancak
    hem tüm geçmişte hem yıl yıl (geleceği görmeden) testte temel plandan en az MIN_GAIN_R iyiyse. Değilse temel plan."""
    base = pol["base"]
    best = max(pol, key=lambda k: pol[k]["avg_r"])
    ok = (best != "base" and pol[best]["avg_r"] - base["avg_r"] >= MIN_GAIN_R
          and wf["oos_chosen_r"] is not None and wf["oos_chosen_r"] - wf["oos_base_r"] >= MIN_GAIN_R)
    name = best if ok else "base"
    return {"name": name, "desc": POLICIES[name][0], **POLICIES[name][1], "avg_r": pol[name]["avg_r"],
            "base_avg_r": base["avg_r"], "oos_r": wf["oos_chosen_r"], "oos_base_r": wf["oos_base_r"],
            "win": pol[name]["win"], "avg_days": pol[name]["avg_days"], "n": pol[name]["n"],
            "std_r": pol[name].get("std_r")}


def report(df: pd.DataFrame) -> dict:
    out = {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "policies": {}, "walk_forward": {}, "selected": {}}
    for scope, g in (("live", df[df["live"]]), ("all", df)):
        for market, gm in [("ALL", g), *g.groupby("market")]:
            out["policies"].setdefault(scope, {})[market] = {name: {"desc": POLICIES[name][0], **_stats(gm, name)}
                                                             for name in POLICIES}
            out["walk_forward"].setdefault(scope, {})[market] = walk_forward(gm)
    for market in ("BIST", "US"):
        if market in out["policies"]["live"]:
            out["selected"][market] = select(out["policies"]["live"][market], out["walk_forward"]["live"][market])
    return out


def selected_rule(market: str) -> dict | None:
    """Asistanın bu piyasada kullanacağı çıkış kuralı (rapor yoksa None: temel plan)."""
    if not REPORT_JSON.exists():
        return None
    sel = json.loads(REPORT_JSON.read_text(encoding="utf-8")).get("selected", {}).get(market)
    return sel if sel and sel["name"] != "base" else None


def _txt(rep: dict) -> str:
    lines = [f"ÇIKIŞ KURALLARI KARŞILAŞTIRMASI  ({rep['generated_at'][:10]})", ""]
    for market, sel in rep.get("selected", {}).items():
        lines.append(f"Seçilen ({market}): {sel['name']} — {sel['desc']}: {sel['avg_r']:+.3f}R (plan {sel['base_avg_r']:+.3f}R), "
                     f"yıl yıl {sel['oos_r']:+.3f}R (plan {sel['oos_base_r']:+.3f}R)")
    lines.append("")
    for scope, title in (("live", "Canlı süzgeçten geçen girişler"), ("all", "Tüm girişler (eğitim alanı)")):
        for market, pol in rep["policies"][scope].items():
            lines.append(f"== {title} · {market}")
            lines.append(f"{'kural':8} {'açıklama':48} {'n':>7} {'ort.R':>7} {'medyan':>7} {'isabet':>7} {'gün':>5} {'R/20g':>7} {'ilk5 R':>7}")
            for name, s in pol.items():
                lines.append(f"{name:8} {s['desc'][:48]:48} {s['n']:>7} {s['avg_r']:>+7.3f} {s['median_r']:>+7.3f} "
                             f"{s['win']:>6.1f}% {s['avg_days']:>5.1f} {s['r_per_20d']:>+7.3f} {s['top5_r']:>+7.3f}")
            wf = rep["walk_forward"][scope][market]
            lines.append(f"   kayan seçim (geleceği görmeden): seçilen kurallar {wf['oos_chosen_r']:+.3f}R, "
                         f"şu anki plan {wf['oos_base_r']:+.3f}R")
            for y in wf["years"]:
                lines.append(f"     {y['year']}: seçilen {y['chosen']:7} {y['chosen_r']:+.3f}R | plan {y['base_r']:+.3f}R "
                             f"| sonradan bakınca en iyisi {y['best_in_hindsight']} (n={y['n']})")
            lines.append("")
    return "\n".join(lines)


def main() -> None:
    t0 = time.time()
    df = collect()
    print(f"{len(df):,} işlem simüle edildi ({time.time() - t0:.0f} sn)")
    rep = report(df)
    REPORT_JSON.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    txt = _txt(rep)
    REPORT_TXT.write_text(txt, encoding="utf-8")
    print(txt)


if __name__ == "__main__":
    main()
