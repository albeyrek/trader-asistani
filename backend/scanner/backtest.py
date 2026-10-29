"""Skorların geçmiş performans testi: python -m scanner.backtest [--market US|BIST] [--limit N]

Yöntem:
- Her hisse için her 2 haftada bir, haftanın son işlem günü kapanışında skor hesaplanır
  (sadece o güne kadarki veri kullanılır; haftalık mum o gün kapanmış olur).
- Sonraki 5, 20 ve 60 işlem günündeki getiri ölçülür.
- Getiri, aynı tarihte aynı piyasadaki medyan hisse getirisinden çıkarılır (piyasa etkisi ayıklanır).
"""
import argparse
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .prices import load_prices, to_weekly
from .scan import DAILY_WEIGHT, WEEKLY_WEIGHT, scan_universe
from .signals import DAILY, WEEKLY, outlook_label, prepare, score_at

HORIZONS = {"5g": 5, "20g": 20, "60g": 60}
EVAL_EVERY_WEEKS = 2
MIN_DAILY_IDX = 200   # EMA200'ün oturması için gereken günlük mum
RESULTS_FILE = DATA_DIR / "backtest_samples.parquet"
REPORT_FILE = DATA_DIR / "backtest_report.txt"


def _symbol_samples(args) -> list[dict]:
    sym, market, daily, weekly = args
    daily = daily.reset_index(drop=True)
    weekly = weekly.reset_index(drop=True)
    if len(daily) <= MIN_DAILY_IDX or len(weekly) < WEEKLY.min_bars:
        return []
    d, piv_d = prepare(daily, DAILY)
    w, piv_w = prepare(weekly, WEEKLY)
    dates = daily["date"].to_numpy()
    closes = daily["close"].to_numpy()
    n = len(daily)
    out = []
    for j in range(WEEKLY.min_bars - 1, len(w)):
        label = w["date"].iloc[j]
        # Tüm hisseler aynı haftalarda değerlendirilsin diye takvime sabitlenir
        if (label.toordinal() // 7) % EVAL_EVERY_WEEKS != 0:
            continue
        # Haftalık mum etiketi (Cuma) tarihindeki ya da öncesindeki son işlem günü
        t = int(np.searchsorted(dates, label.to_datetime64(), side="right")) - 1
        if t < MIN_DAILY_IDX:
            continue
        da = score_at(d, piv_d, t, DAILY, market)
        wa = score_at(w, piv_w, j, WEEKLY, market)
        if da is None or wa is None:
            continue
        row = {
            "yf_symbol": sym,
            "market": market,
            "date": pd.Timestamp(dates[t]),
            "daily_score": da.score,
            "weekly_score": wa.score,
            "combined_score": DAILY_WEIGHT * da.score + WEEKLY_WEIGHT * wa.score,
            "atr_pct": da.metrics["atr_pct"],
        }
        for k, h in HORIZONS.items():
            row[f"ret_{k}"] = closes[t + h] / closes[t] - 1 if t + h < n else np.nan
        row.update({f"d_{k}": v for k, v in da.components.items()})
        row.update({f"w_{k}": v for k, v in wa.components.items()})
        out.append(row)
    return out


def collect_samples(market: str | None, limit: int | None, workers: int) -> pd.DataFrame:
    meta = scan_universe(market)
    prices = load_prices()
    prices = prices[prices["yf_symbol"].isin(meta.index)]
    if limit:
        keep = prices["yf_symbol"].drop_duplicates().sample(limit, random_state=1)
        prices = prices[prices["yf_symbol"].isin(keep)]
    weekly = dict(tuple(to_weekly(prices).groupby("yf_symbol")))
    tasks = [(sym, meta.loc[sym, "market"], g, weekly[sym])
             for sym, g in prices.groupby("yf_symbol") if sym in weekly]
    rows = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for i, res in enumerate(ex.map(_symbol_samples, tasks, chunksize=20), 1):
            rows.extend(res)
            if i % 500 == 0:
                print(f"  {i}/{len(tasks)} hisse")
    df = pd.DataFrame(rows)
    # Piyasaya göre fazla getiri: aynı gün, aynı piyasadaki medyan getiri çıkarılır
    for k in HORIZONS:
        med = df.groupby(["market", "date"])[f"ret_{k}"].transform("median")
        df[f"ex_{k}"] = df[f"ret_{k}"] - med
    return df


# ---------------------------------------------------------------- değerlendirme

def _ic(df: pd.DataFrame, score: str, ret: str) -> dict:
    """Bilgi katsayısı (IC): her tarihte skor sıralaması ile getiri sıralaması arasındaki korelasyon."""
    def one(g):
        g = g[[score, ret]].dropna()
        return g[score].rank().corr(g[ret].rank()) if len(g) >= 20 else np.nan
    ics = df.groupby("date").apply(one, include_groups=False).dropna()
    if ics.empty:
        return {"IC": np.nan, "t": np.nan, "pozitif%": np.nan, "n_tarih": 0}
    return {
        "IC": ics.mean(),
        "t": ics.mean() / ics.std() * np.sqrt(len(ics)) if len(ics) > 1 else np.nan,
        "pozitif%": (ics > 0).mean() * 100,
        "n_tarih": len(ics),
    }


def _quintiles(df: pd.DataFrame, score: str, ret: str) -> pd.DataFrame:
    """Her tarihte hisseler skora göre 5 gruba ayrılır; Q1 en düşük, Q5 en yüksek skor."""
    g = df[["date", score, ret]].dropna().copy()
    g["q"] = g.groupby("date")[score].transform(
        lambda s: pd.qcut(s.rank(method="first"), 5, labels=False) + 1 if len(s) >= 25 else np.nan)
    g = g.dropna(subset=["q"])
    t = g.groupby("q")[ret].agg(ort=lambda x: x.mean() * 100, medyan=lambda x: x.median() * 100,
                                isabet=lambda x: (x > 0).mean() * 100, n="size")
    t.index = [f"Q{int(i)}" for i in t.index]
    return t


def _labels(df: pd.DataFrame, score: str, ret: str) -> pd.DataFrame:
    g = df[[score, ret]].dropna().copy()
    g["etiket"] = g[score].map(outlook_label)
    order = ["Güçlü Düşüş", "Düşüş", "Nötr", "Yükseliş", "Güçlü Yükseliş"]
    t = g.groupby("etiket")[ret].agg(ort=lambda x: x.mean() * 100, isabet=lambda x: (x > 0).mean() * 100, n="size")
    return t.reindex([o for o in order if o in t.index])


def _components(df: pd.DataFrame, prefix: str, ret: str) -> pd.DataFrame:
    """Her kural için: yükseliş yönünde tetiklendiğinde ve düşüş yönünde tetiklendiğinde ortalama fazla getiri.
    İyi bir kural: (+) tarafı pozitif, (-) tarafı negatif getiri; fark ne kadar büyükse o kadar faydalı."""
    rows = []
    for col in [c for c in df.columns if c.startswith(prefix)]:
        x = df[[col, ret]].dropna(subset=[ret])
        pos = x[x[col] > 0][ret]
        neg = x[x[col] < 0][ret]
        rows.append({
            "kural": col[len(prefix):],
            "(+) ort%": pos.mean() * 100 if len(pos) else np.nan,
            "(+) n": len(pos),
            "(-) ort%": neg.mean() * 100 if len(neg) else np.nan,
            "(-) n": len(neg),
        })
    t = pd.DataFrame(rows).set_index("kural")
    # Sadece tek yönlü kurallarda (örn. aşırı alım) fark, eksik tarafı 0 sayarak hesaplanır
    t["fark"] = t["(+) ort%"].fillna(0) - t["(-) ort%"].fillna(0)
    return t.sort_values("fark", ascending=False)


def build_report(df: pd.DataFrame) -> str:
    lines = []
    fmt = lambda x: f"{x:8.2f}"  # noqa: E731
    span = f"{df['date'].min().date()} - {df['date'].max().date()}"
    lines.append(f"BACKTEST RAPORU  |  örnek: {len(df):,}  |  hisse: {df['yf_symbol'].nunique():,}  |  dönem: {span}")
    lines.append("Getiriler piyasa medyanına göre FAZLA getiridir (%). IC > 0.03 ve t > 2 anlamlı kabul edilir.\n")

    tests = [("daily_score", "5g"), ("daily_score", "20g"), ("weekly_score", "20g"),
             ("weekly_score", "60g"), ("combined_score", "20g"), ("combined_score", "60g")]
    for mkt, g in [("TÜMÜ", df), *df.groupby("market")]:
        lines.append("=" * 78)
        lines.append(f"PİYASA: {mkt}   (örnek {len(g):,})")
        lines.append("-" * 78)
        lines.append(f"{'skor':<16}{'vade':>6}{'IC':>9}{'t':>8}{'IC>0 %':>9}{'Q5-Q1 %':>10}{'Q5 isabet':>11}")
        for score, h in tests:
            ic = _ic(g, score, f"ex_{h}")
            q = _quintiles(g, score, f"ex_{h}")
            spread = q.loc["Q5", "ort"] - q.loc["Q1", "ort"] if {"Q1", "Q5"} <= set(q.index) else np.nan
            hit = q.loc["Q5", "isabet"] if "Q5" in q.index else np.nan
            lines.append(f"{score:<16}{h:>6}{ic['IC']:>9.3f}{ic['t']:>8.2f}{ic['pozitif%']:>9.0f}"
                         f"{spread:>10.2f}{hit:>11.0f}")
        lines.append("\nBirleşik skor beşte birlikleri (20 gün sonrası fazla getiri):")
        lines.append(_quintiles(g, "combined_score", "ex_20g").to_string(float_format=fmt))
        lines.append("\nEtiketlere göre (birleşik skor, 20 gün):")
        lines.append(_labels(g, "combined_score", "ex_20g").to_string(float_format=fmt))
        lines.append("")

    lines.append("=" * 78)
    lines.append("KURAL BAZINDA ANALİZ (tüm piyasalar)")
    lines.append("\nGünlük kurallar -> 20 gün sonrası fazla getiri:")
    lines.append(_components(df, "d_", "ex_20g").to_string(float_format=fmt))
    lines.append("\nHaftalık kurallar -> 60 gün sonrası fazla getiri:")
    lines.append(_components(df, "w_", "ex_60g").to_string(float_format=fmt))
    for mkt, g in df.groupby("market"):
        lines.append(f"\nGünlük kurallar -> 20 gün ({mkt}):")
        lines.append(_components(g, "d_", "ex_20g").to_string(float_format=fmt))
    return "\n".join(lines)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--market", choices=["US", "BIST"])
    p.add_argument("--limit", type=int, help="Test için rastgele N hisse")
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--report-only", action="store_true", help="Kayıtlı örneklerden sadece raporu üret")
    args = p.parse_args()

    t0 = time.time()
    if args.report_only:
        df = pd.read_parquet(RESULTS_FILE)
    else:
        df = collect_samples(args.market, args.limit, args.workers)
        df.to_parquet(RESULTS_FILE, index=False)
        print(f"{len(df):,} örnek toplandı ({time.time() - t0:.0f} sn)")
    report = build_report(df)
    REPORT_FILE.write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
