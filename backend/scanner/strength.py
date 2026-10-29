"""Göreli güç (RS) ve sektör analizi.

RS puanı (1-99): hissenin son 3/6/9/12 aylık getirilerinin ağırlıklı toplamının, aynı piyasadaki diğer hisselere
göre yüzdelik sırası (IBD tarzı; son 3 ay 2 kat ağırlıklı). 90 = hisselerin %90'ından güçlü.
Endekse göre fazla getiri (rs_1m, rs_3m) ayrıca verilir.

Sektörler: her sektör için medyan 1/3 aylık getiri, medyan RS, 200 günlük ortalama üstü oranı ve ortalama skor.
"""
import numpy as np
import pandas as pd

from .config import MAIN_INDEX

RS_PERIODS = ((63, 0.4), (126, 0.2), (189, 0.2), (252, 0.2))
MIN_SECTOR_SIZE = 3


def _ret(px: pd.DataFrame, n: int) -> pd.Series:
    if len(px) <= n:
        return pd.Series(np.nan, index=px.columns)
    return px.iloc[-1] / px.iloc[-1 - n] - 1


def compute(prices: pd.DataFrame, scan: pd.DataFrame, sector_of: dict[str, str | None]) -> tuple[dict, dict]:
    """(hisse başına {rs_rating, rs_1m, rs_3m}, piyasa başına sektör listesi)"""
    per_stock: dict[str, dict] = {}
    sectors: dict[str, list[dict]] = {}
    for market, g in scan.groupby("market"):
        syms = g["yf_symbol"].tolist()
        px = (prices[prices["yf_symbol"].isin(syms)]
              .pivot(index="date", columns="yf_symbol", values="close").sort_index().ffill(limit=3))
        idx = prices[prices["yf_symbol"] == MAIN_INDEX[market]].set_index("date")["close"].sort_index()
        r1, r3 = _ret(px, 21), _ret(px, 63)
        weighted = sum(w * _ret(px, n).fillna(_ret(px, 63)) for n, w in RS_PERIODS)
        rating = (weighted.rank(pct=True) * 98 + 1).round()
        idx_r1 = float(idx.iloc[-1] / idx.iloc[-22] - 1) if len(idx) > 22 else np.nan
        idx_r3 = float(idx.iloc[-1] / idx.iloc[-64] - 1) if len(idx) > 64 else np.nan
        above200 = px.iloc[-1] > px.rolling(200, min_periods=200).mean().iloc[-1]

        yf_to_sym = dict(zip(g["yf_symbol"], g["symbol"]))
        for yf, sym in yf_to_sym.items():
            rt = rating.get(yf)
            per_stock[f"{market}:{sym}"] = {
                "rs_rating": int(rt) if pd.notna(rt) else None,
                "rs_1m": round(float(r1.get(yf) - idx_r1) * 100, 2) if pd.notna(r1.get(yf)) and pd.notna(idx_r1) else None,
                "rs_3m": round(float(r3.get(yf) - idx_r3) * 100, 2) if pd.notna(r3.get(yf)) and pd.notna(idx_r3) else None,
            }

        rows = []
        df = pd.DataFrame({
            "sector": [sector_of.get(f"{market}:{yf_to_sym[y]}") for y in syms],
            "r1": r1.reindex(syms).to_numpy(), "r3": r3.reindex(syms).to_numpy(),
            "rs": rating.reindex(syms).to_numpy(), "a200": above200.reindex(syms).to_numpy(dtype=float),
            "score": g.set_index("yf_symbol")["combined_score"].reindex(syms).to_numpy(),
            "symbol": [yf_to_sym[y] for y in syms],
        }).dropna(subset=["sector"])
        for sec, s in df.groupby("sector"):
            if len(s) < MIN_SECTOR_SIZE:
                continue
            leaders = s.sort_values("rs", ascending=False).head(3)["symbol"].tolist()
            rows.append({
                "sector": sec, "count": int(len(s)),
                "ret_1m": round(float(s["r1"].median()) * 100, 2), "ret_3m": round(float(s["r3"].median()) * 100, 2),
                "rs": int(s["rs"].median()) if s["rs"].notna().any() else None,
                "above200": round(float(s["a200"].mean()) * 100, 1), "score": round(float(s["score"].mean()), 1),
                "leaders": leaders,
            })
        rows.sort(key=lambda x: -(x["rs"] or 0))
        for i, r in enumerate(rows, 1):
            r["rank"] = i
        sectors[market] = rows
    return per_stock, sectors
