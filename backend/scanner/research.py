"""Model yarışı: asistanın sıralamasını kurallardan daha isabetli yapabilecek modeller her hafta yarışır.

python -m scanner.research        (haftalık öğrenmede, çıkış kuralı testinden sonra çalışır)

Neden ayrı bir yarış? Öğrenen modelin (learn.py) üç yapısal eksiği vardı:
  - hedef, asistanın gerçekte kullandığı çıkış kuralı değil sabit hedefli planın R'siydi (BIST iz süren stop kullanıyor),
  - BIST ve ABD tek modelde öğreniliyordu (verinin %92'si ABD; BIST'in kendine özgü davranışı kayboluyordu),
  - sektör bilgisi yoktu.
Burada her piyasa için ayrı adaylar, o piyasanın seçilen çıkış kuralının R'siyle, geleceği görmeden test edilir:
  - eğitim: o tarihten EMBARGO günü önce biten tüm örnekler (süzgeç alanı), 26 haftalık kayan dilimler,
  - seçim: canlı süzgeçten geçen günün adayları içinde ilk TOP_K (asistanın gerçekte yaptığı gibi),
  - karşılaştırma: aynı günlerde kuralların ilk TOP_K'sı ve bütün adayların ortalaması.
Şampiyon olma şartı (gürültüyü "zekâ" sanmamak için sıkı; aynı anda birden çok aday denendiği için t eşiği yüksek):
  haftalık fark t >= GATE_T, fark >= GATE_EDGE R, yılların en az GATE_YEARS'ında pozitif ve en iyi yıl çıkarılınca da
  pozitif. Geçen yoksa sıralamayı kurallar yapar. Şampiyon tüm veriyle yeniden eğitilip kaydedilir (learn.Scorer kullanır).
"""
import json
import pickle

import numpy as np
import pandas as pd

from . import assistant_track, exits, learn

RESEARCH_FILE = learn.MODEL_DIR / "research.json"
CHAMPION_FILE = learn.MODEL_DIR / "champion_{market}.pkl"
GATE_T, GATE_EDGE, GATE_YEARS = 2.5, 0.05, 0.6
MIN_TEST_WEEKS = 52
KEEP_HISTORY = 52
BASE_FEATURES = [f for f in learn.FEATURES if f != "mkt_us"]
SECTOR_FEATURES = ["sec_ret_1m", "sec_ret_3m", "sec_rel_1m", "sec_rank_1m", "sec_breadth50"]


# ------------------------------------------------------------------ sektör özellikleri

def sector_frame(prices: pd.DataFrame, sector_of: dict[str, str]) -> pd.DataFrame:
    """Her gün, her hisse için sektörünün durumu: sektör üyelerinin medyan 1 ve 3 aylık getirisi, hissenin sektörüne göre
    1 aylık farkı, sektörün o gün sektörler arasındaki sırası (0-1) ve 50 günlük ortalamasının üstündeki üye oranı.
    sector_of: yahoo kodu -> sektör adı (bugünkü tarama; geçmişte sektör değişimi yok sayılır)."""
    have = set(prices["yf_symbol"].unique())
    syms = [s for s in sector_of if s in have]
    px = prices[prices["yf_symbol"].isin(syms)].pivot(index="date", columns="yf_symbol", values="close").sort_index()
    px = px.ffill(limit=3)
    r1, r3 = px / px.shift(21) - 1, px / px.shift(63) - 1
    above = (px > px.rolling(50, min_periods=50).mean()).where(px.rolling(50, min_periods=50).mean().notna())
    sec = pd.Series({s: sector_of[s] for s in px.columns})
    groups = {name: list(g.index) for name, g in sec.groupby(sec) if len(g) >= 3}  # en az 3 üyeli sektörler
    m1 = pd.DataFrame({k: r1[v].median(axis=1) for k, v in groups.items()})
    m3 = pd.DataFrame({k: r3[v].median(axis=1) for k, v in groups.items()})
    br = pd.DataFrame({k: above[v].mean(axis=1) for k, v in groups.items()})
    rank1 = m1.rank(axis=1, pct=True)
    # Sektör sütunlarını hisse sütunlarına yay (her hisse kendi sektörünün değerini alır), sonra uzun biçime çevir
    cols = [s for s in px.columns if sec[s] in groups]
    of = [sec[s] for s in cols]
    spread = lambda f: f[of].set_axis(cols, axis=1)  # noqa: E731
    m1s = spread(m1)
    wide = {"sec_ret_1m": m1s * 100, "sec_ret_3m": spread(m3) * 100, "sec_rel_1m": (r1[cols] - m1s) * 100,
            "sec_rank_1m": spread(rank1), "sec_breadth50": spread(br) * 100}
    out = pd.DataFrame({k: v.stack(future_stack=True) for k, v in wide.items()})
    out.index.names = ["date", "yf_symbol"]
    return out[SECTOR_FEATURES]


def sector_map(scan: pd.DataFrame | None = None) -> dict[str, str]:
    """Yahoo kodu -> sektör. BIST: taramadaki sektör (KAP/BIST sınıflaması); ABD: Nasdaq sektörü (temel veriler)."""
    from . import fundamentals
    from .scan import RESULTS_FILE
    if scan is None:
        scan = pd.read_parquet(RESULTS_FILE, columns=["market", "symbol", "yf_symbol", "sector"])
    fund = fundamentals.load()
    out = {}
    for r in scan.itertuples():
        sec = r.sector if isinstance(r.sector, str) and r.sector else (fund.get(f"{r.market}:{r.symbol}") or {}).get("sector")
        if sec:
            out[r.yf_symbol] = sec
    return out


# ------------------------------------------------------------------ veri

def selected_rule(market: str, rep: dict | None) -> str:
    sel = ((rep or {}).get("selected") or {}).get(market)
    return sel["name"] if sel else "base"


def dataset(market: str, samples: pd.DataFrame, trades: pd.DataFrame, sectors: pd.DataFrame | None,
            rule: str) -> tuple[pd.DataFrame, int]:
    """Sonucu belli örnekler + seçilen çıkış kuralının R'si (hedef). Dönüş: (veri, embargo günü)."""
    hold = exits.POLICIES[rule][1]["hold"]
    embargo = int((hold + assistant_track.ENTRY_DAYS) * 7 / 5) + 7  # en uzun işlem (takvim günü) + bir hafta
    rcol = f"r_{rule}"
    s = samples[(samples["market"] == market) & (samples["status"] != "not_filled")]
    cols = list(dict.fromkeys(["yf_symbol", "date", "live", rcol, "r_base"]))  # kural "base" ise aynı sütun bir kez
    d = s.merge(trades[cols], on=["yf_symbol", "date"], how="inner")
    d = d[d["date"] <= d["date"].max() - pd.Timedelta(days=embargo)].copy()
    d[learn.FEATURES] = d[learn.FEATURES].replace([np.inf, -np.inf], np.nan)
    if sectors is not None:
        d = d.join(sectors, on=["date", "yf_symbol"])
    d["quality"] = [learn.rule_quality(f) for f in d[["combined_score", "rs_rating", "rr", "ext_atr"]].to_dict("records")]
    d["r_rule"] = d[rcol]
    d["y_rule"] = d[rcol].clip(-1.5, 6.0)
    d["y_base"] = d["r_base"].clip(*learn.R_CLIP)
    d["y_dm"] = d["y_rule"] - d.groupby("date")["y_rule"].transform("mean")  # günün ortalamasından fark: seçim becerisi
    d["y_win"] = (d[rcol] > 0).astype(int)
    return d.sort_values("date").reset_index(drop=True), embargo


def folds(d: pd.DataFrame, embargo: int):
    """learn._folds ile aynı düzen, piyasanın çıkış kuralına göre embargo ile."""
    first, end = d["date"].min(), d["date"].max()
    while True:
        start = end - pd.Timedelta(weeks=learn.FOLD_WEEKS)
        if start < first + pd.Timedelta(weeks=learn.MIN_TRAIN_WEEKS):
            break
        train = d[d["date"] <= start - pd.Timedelta(days=embargo)]
        test = d[(d["date"] > start) & (d["date"] <= end)]
        if len(train) >= 1500 and test["live"].sum() >= 50:
            yield train, test
        end = start


# ------------------------------------------------------------------ adaylar

def _gbr():
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.03, max_iter=250, min_samples_leaf=200,
                                         l2_regularization=2.0, early_stopping=False, random_state=0)


def _ridge():
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=50))


def _gbc():
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_depth=3, learning_rate=0.03, max_iter=250, min_samples_leaf=200,
                                          l2_regularization=1.0, early_stopping=False, random_state=0)


CANDIDATES = {
    "ortak_hedef": ("Şimdiki yaklaşım (sabit hedefli planın R'si)", _gbr, "base", "y_base"),
    "dogru_hedef": ("Doğru hedef: piyasanın çıkış kuralının R'si", _gbr, "base", "y_rule"),
    "gun_farki": ("Doğru hedef, günün ortalamasından fark (seçim becerisi)", _gbr, "base", "y_dm"),
    "sektor": ("+ sektör hareketi (sektör getirisi, sırası, genişliği)", _gbr, "sector", "y_dm"),
    "sektor_dogrusal": ("Doğrusal model + sektör", _ridge, "sector", "y_dm"),
    "karli_mi": ("Kârla kapanır mı (sınıflandırma) + sektör", _gbc, "sector", "y_win"),
}


def features_of(kind: str) -> list[str]:
    return BASE_FEATURES + (SECTOR_FEATURES if kind == "sector" else [])


def _predict(model, x: pd.DataFrame, target: str) -> np.ndarray:
    return model.predict_proba(x)[:, 1] if target == "y_win" else model.predict(x)


def evaluate(d: pd.DataFrame, embargo: int, key: str) -> pd.DataFrame:
    """Kayan pencereli test tahminleri (canlı süzgeçten geçen test satırları)."""
    _, make, kind, target = CANDIDATES[key]
    feats = features_of(kind)
    parts = []
    for train, test in folds(d, embargo):
        if target == "y_win" and train[target].nunique() < 2:
            continue
        m = make().fit(train[feats], train[target])
        t = test[test["live"]].copy()
        t["pred"] = _predict(m, t[feats], target)
        parts.append(t)
    return pd.concat(parts) if parts else pd.DataFrame()


def weekly(oos: pd.DataFrame, score: str) -> pd.DataFrame:
    """Her test günü: skorla seçilen ilk TOP_K, kuralların ilk TOP_K'sı ve bütün adayların sonucu."""
    rows = []
    for dt, g in oos.groupby("date"):
        top, rule = g.nlargest(learn.TOP_K, score), g.nlargest(learn.TOP_K, "quality")
        rows.append({"date": dt, "top_r": top["r_rule"].mean(), "rule_r": rule["r_rule"].mean(), "all_r": g["r_rule"].mean(),
                     "top_hit": (top["r_rule"] > 0).mean(), "rule_hit": (rule["r_rule"] > 0).mean(),
                     "all_hit": (g["r_rule"] > 0).mean()})
    return pd.DataFrame(rows)


def judge(w: pd.DataFrame, ic: float | None) -> dict:
    """Haftalık sonuçlardan ölçüler ve şampiyonluk şartı."""
    diff = w["top_r"] - w["rule_r"]
    t = float(diff.mean() / diff.std() * np.sqrt(len(diff))) if len(diff) > 1 and diff.std() > 0 else 0.0
    by_year = diff.groupby(w["date"].dt.year).mean()
    best = by_year.idxmax() if len(by_year) else None
    without_best = float(diff[w["date"].dt.year != best].mean()) if best is not None else 0.0
    pos_share = float((by_year > 0).mean()) if len(by_year) else 0.0
    reasons = []
    if len(w) < MIN_TEST_WEEKS:
        reasons.append(f"test haftası az ({len(w)})")
    if t < GATE_T:
        reasons.append(f"fark anlamlı değil (t {t:.2f} < {GATE_T})")
    if diff.mean() < GATE_EDGE:
        reasons.append(f"fark küçük ({diff.mean():+.3f}R)")
    if pos_share < GATE_YEARS:
        reasons.append(f"yılların yalnızca %{pos_share * 100:.0f}'inde iyi")
    if without_best <= 0:
        reasons.append(f"en iyi yıl ({best}) çıkarılınca üstünlük kalmıyor")
    return {
        "weeks": int(len(w)), "top_r": round(float(w["top_r"].mean()), 3), "rule_r": round(float(w["rule_r"].mean()), 3),
        "all_r": round(float(w["all_r"].mean()), 3), "edge": round(float(diff.mean()), 3), "edge_t": round(t, 2),
        "hit": round(float(w["top_hit"].mean()) * 100, 1), "rule_hit": round(float(w["rule_hit"].mean()) * 100, 1),
        "all_hit": round(float(w["all_hit"].mean()) * 100, 1), "ic": round(ic, 3) if ic is not None else None,
        "years": {str(y): round(float(v), 3) for y, v in by_year.items()}, "years_positive": round(pos_share, 2),
        "edge_without_best_year": round(without_best, 3), "passed": not reasons, "why_not": reasons,
    }


def _ic(oos: pd.DataFrame) -> float | None:
    ics = oos.groupby("date").apply(
        lambda g: g["pred"].rank().corr(g["r_rule"].rank()) if len(g) >= 8 else np.nan, include_groups=False).dropna()
    return float(ics.mean()) if len(ics) else None


# ------------------------------------------------------------------ yarış

def run(markets: tuple[str, ...] = ("BIST", "US")) -> dict:
    from . import history as hist
    samples = pd.read_parquet(learn.SAMPLES_FILE)
    trades = pd.read_parquet(exits.TRADES_FILE)
    rep = json.loads(exits.REPORT_JSON.read_text(encoding="utf-8")) if exits.REPORT_JSON.exists() else None
    prices = hist.load_long()
    smap = sector_map()
    old = json.loads(RESEARCH_FILE.read_text(encoding="utf-8")) if RESEARCH_FILE.exists() else {}
    now = pd.Timestamp.now(tz="UTC")
    out = {"generated_at": now.isoformat(), "gate": {"t": GATE_T, "edge": GATE_EDGE, "years": GATE_YEARS},
           "top_k": learn.TOP_K, "markets": {}}
    for market in markets:
        rule = selected_rule(market, rep)
        syms = samples.loc[samples["market"] == market, "yf_symbol"].unique()
        secs = sector_frame(prices[prices["yf_symbol"].isin(syms)], {s: smap[s] for s in syms if s in smap})
        d, embargo = dataset(market, samples, trades, secs, rule)
        print(f"{market}: {len(d):,} örnek ({int(d['live'].sum()):,} canlı süzgeçten), hedef r_{rule}, embargo {embargo} gün",
              flush=True)
        res = {}
        for key, (desc, *_rest) in CANDIDATES.items():
            oos = evaluate(d, embargo, key)
            if oos.empty:
                continue
            res[key] = {"name": desc, **judge(weekly(oos, "pred"), _ic(oos))}
            r = res[key]
            print(f"  {key:16} ilk{learn.TOP_K} {r['top_r']:+.3f}R (kural {r['rule_r']:+.3f}, hepsi {r['all_r']:+.3f}) "
                  f"fark {r['edge']:+.3f} t {r['edge_t']:.2f} isabet %{r['hit']} (kural %{r['rule_hit']}) "
                  f"{'ŞAMPİYON ADAYI' if r['passed'] else '; '.join(r['why_not'])}", flush=True)
        passed = [k for k, r in res.items() if r["passed"]]
        champ = max(passed, key=lambda k: res[k]["edge_t"]) if passed else None
        path = learn.MODEL_DIR / CHAMPION_FILE.name.format(market=market)
        if champ:
            _, make, kind, target = CANDIDATES[champ]
            feats = features_of(kind)
            model = make().fit(d[feats], d[target])
            with open(path, "wb") as fh:
                pickle.dump({"key": champ, "name": CANDIDATES[champ][0], "features": feats, "target": target,
                             "model": model, "rule": rule, "trained_at": now.isoformat(),
                             "trained_until": d["date"].max().date().isoformat(), "metrics": res[champ]}, fh)
            decision = f"{CANDIDATES[champ][0]} testi geçti; {market} sıralamasını devraldı"
        else:
            path.unlink(missing_ok=True)
            best = max(res, key=lambda k: res[k]["edge_t"]) if res else None
            decision = ("Hiçbir model şartları geçemedi; sıralamayı kurallar yapıyor"
                        + (f" (en iyisi: {res[best]['name']}, fark {res[best]['edge']:+.3f}R, t {res[best]['edge_t']:.2f})"
                           if best else ""))
        out["markets"][market] = {"rule": rule, "n": int(len(d)), "n_live": int(d["live"].sum()), "embargo_days": embargo,
                                  "period": {"from": d["date"].min().date().isoformat(), "to": d["date"].max().date().isoformat()},
                                  "candidates": res, "champion": champ, "decision": decision}
        print(f"  -> {decision}", flush=True)
    hist_rows = old.get("history", []) + [{
        "at": now.isoformat(),
        **{m: {"champion": v["champion"], "best_edge": max((c["edge"] for c in v["candidates"].values()), default=None),
               "best_t": max((c["edge_t"] for c in v["candidates"].values()), default=None),
               "rule_hit": next(iter(v["candidates"].values()), {}).get("rule_hit"),
               "n": v["n"]} for m, v in out["markets"].items()},
    }]
    out["history"] = hist_rows[-KEEP_HISTORY:]
    RESEARCH_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def load_champion(market: str) -> dict | None:
    """learn.Scorer için: piyasanın şampiyon modeli (yoksa ya da özellikler değiştiyse None)."""
    try:
        with open(learn.MODEL_DIR / CHAMPION_FILE.name.format(market=market), "rb") as fh:
            c = pickle.load(fh)
        return c if set(c["features"]) <= set(BASE_FEATURES + SECTOR_FEATURES) else None
    except Exception:  # dosya yok ya da sklearn sürümü değişti
        return None


def live_sector_features(prices: pd.DataFrame, scan: pd.DataFrame, market: str) -> dict[str, dict]:
    """Bugün için sektör özellikleri: yahoo kodu -> {özellik: değer} (şampiyon modeli sektör özelliği kullanıyorsa)."""
    smap = sector_map(scan[scan["market"] == market])
    px = prices[prices["yf_symbol"].isin(list(smap))]
    px = px[px["date"] >= px["date"].max() - pd.Timedelta(days=200)]  # 63 iş günü getiri + 50 gün ortalama yeter
    f = sector_frame(px, smap)
    last = f.index.get_level_values("date").max()
    return {sym: row.to_dict() for (_, sym), row in f.xs(last, level="date", drop_level=False).iterrows()}


def main() -> None:
    import argparse
    import time
    p = argparse.ArgumentParser()
    p.add_argument("--market", choices=["BIST", "US"], help="yalnızca bu piyasa (yerel deneme)")
    a = p.parse_args()
    t0 = time.time()
    run((a.market,) if a.market else ("BIST", "US"))
    print(f"Model yarışı bitti ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
