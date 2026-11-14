"""ABD için strateji araştırması: python -m scanner.us_strategy

Asistanın kısa vadeli işlem planı (kırılım/geri çekilme + stop) ABD'de 2018'den beri S&P 500'ün çok gerisinde kaldı.
Burada akademik ve pratikte en çok bilinen, az parametreli yaklaşımlar aynı veride ve aynı maliyetle karşılaştırılır:
  - index_trend : S&P 500, endeks 200 günlük ortalamasının üstündeyken; altındayken nakit
  - mom_N       : her ay sonu son 12 ayın (son 1 ay hariç) en güçlü N hissesi, eşit ağırlık, 1 ay tut
  - mom_N_trend : aynısı, endeks 200 günlük ortalamanın altındaysa nakit
  - ramom_N_trend: getiri/oynaklık ile sıralanmış momentum (daha sakin güçlü hisseler) + trend filtresi
  - hi52_N_trend: 52 haftalık zirveye en yakın N hisse + trend filtresi
Evren: o ay sonunda fiyatı >= MIN_PRICE ve 20 günlük ortalama işlem hacmi >= MIN_DOLLAR_VOL olan hisseler (orta ve büyük
şirketler). Maliyet: her alım-satımda COST (ay ay değişen kısım üzerinden). Önceden belirlenen ana aday: mom_20_trend.

Sonuç (Kasım 2026): önceden seçilen aday S&P 500'ün gerisinde kaldı; trend filtreleri aylık kontrolde zarar verdi.
Risk hesaba katıldığında en iyisi endeksi tutmak (Sharpe 0,81). Oynaklığa göre düzeltilmiş momentum (ramom_20) en iyi
hisse stratejisi ama 12 varyant arasından seçildiği ve evren bugünün hisseleri olduğu için iyimser olabilir. Bu yüzden:
ana öneri endeks (RECOMMENDED), ramom_20 deneysel (EXPERIMENT): FORWARD_START'tan itibaren canlı (ileriye dönük) test edilir.

Not: hisse evreni bugün işlem görenlerdir (batanlar yok); bu, hisse stratejilerini endekse göre iyimser gösterir.
"""
import json

import numpy as np
import pandas as pd

from . import history
from .config import DATA_DIR

REPORT_JSON = DATA_DIR / "us_strategy.json"
REPORT_TXT = DATA_DIR / "us_strategy.txt"
INDEX = "^GSPC"
MIN_PRICE = 5.0
MIN_DOLLAR_VOL = 20e6
COST = 0.001  # tek yön (komisyon + kayma)
START = "2018-01-01"


def _panels(prices: pd.DataFrame):
    us = prices[~prices["yf_symbol"].str.endswith(".IS") & ~prices["yf_symbol"].str.contains(r"[\^=]")]
    close = us.pivot(index="date", columns="yf_symbol", values="close").sort_index()
    dv = (us.assign(dv=us["close"] * us["volume"]).pivot(index="date", columns="yf_symbol", values="dv").sort_index())
    idx = prices[prices["yf_symbol"] == INDEX].set_index("date")["close"].sort_index()
    return close, dv, idx


def month_ends(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    s = pd.Series(index, index=index)
    return pd.DatetimeIndex(s.groupby(index.to_period("M")).max().values)


def signals(close: pd.DataFrame, dv: pd.DataFrame, idx: pd.Series) -> dict[str, pd.DataFrame]:
    """Her ay sonu için sıralama puanları (yüksek = daha iyi) ve uygunluk maskesi."""
    c = close.ffill(limit=5)
    mom = c.shift(21) / c.shift(252) - 1                              # 12-1 ay momentum
    vol = c.pct_change(fill_method=None).rolling(126, min_periods=100).std() * np.sqrt(252)
    hi52 = c / c.rolling(252, min_periods=200).max()                  # 52 hafta zirvesine yakınlık
    dv20 = dv.rolling(20, min_periods=10).mean()
    eligible = (c >= MIN_PRICE) & (dv20 >= MIN_DOLLAR_VOL) & mom.notna()
    trend = (idx > idx.rolling(200, min_periods=200).mean()).reindex(c.index).ffill()
    return {"mom": mom, "ramom": mom / vol, "hi52": hi52, "eligible": eligible, "trend": trend}


def backtest(close: pd.DataFrame, sig: dict, idx: pd.Series, score: str | None, n: int, trend: bool) -> pd.DataFrame:
    """Aylık yeniden dengeleme. Dönüş: ay sonu bazında portföy ve endeks aylık getirileri."""
    me = month_ends(close.index)
    me = me[me >= pd.Timestamp(START) - pd.DateOffset(months=1)]
    c = close.ffill(limit=5)
    rows = []
    prev_hold: set[str] = set()
    for t0, t1 in zip(me[:-1], me[1:]):
        ix_ret = float(idx.asof(t1) / idx.asof(t0) - 1)
        in_market = bool(sig["trend"].asof(t0)) if trend else True
        if score is None:  # endeks stratejisi
            hold = {"__INDEX__"} if in_market else set()
            ret = ix_ret if in_market else 0.0
        elif not in_market:
            hold, ret = set(), 0.0
        else:
            elig = sig["eligible"].loc[t0]
            sc = sig[score].loc[t0][elig].dropna()
            hold = set(sc.nlargest(n).index)
            r = (c.loc[t1, list(hold)] / c.loc[t0, list(hold)] - 1).fillna(0)
            ret = float(r.mean()) if len(r) else 0.0
        turnover = len(hold ^ prev_hold) / max(len(hold | prev_hold), 1) if hold or prev_hold else 0.0
        ret -= turnover * 2 * COST if score is not None or hold != prev_hold else 0.0
        rows.append({"date": t1, "ret": ret, "ix": ix_ret, "n": len(hold), "invested": bool(hold)})
        prev_hold = hold
    return pd.DataFrame(rows).set_index("date")


def stats(m: pd.DataFrame) -> dict:
    eq, ix = (1 + m["ret"]).cumprod(), (1 + m["ix"]).cumprod()
    years = len(m) / 12
    dd = float((eq / eq.cummax() - 1).min())
    ixdd = float((ix / ix.cummax() - 1).min())
    by_year = m.groupby(m.index.year).apply(lambda g: pd.Series({"p": (1 + g["ret"]).prod() - 1, "i": (1 + g["ix"]).prod() - 1}),
                                             include_groups=False)
    vol = float(m["ret"].std() * np.sqrt(12))
    return {
        "cagr": round(float(eq.iloc[-1] ** (1 / years) - 1) * 100, 2), "index_cagr": round(float(ix.iloc[-1] ** (1 / years) - 1) * 100, 2),
        "total": round(float(eq.iloc[-1] - 1) * 100, 1), "index_total": round(float(ix.iloc[-1] - 1) * 100, 1),
        "max_dd": round(dd * 100, 1), "index_max_dd": round(ixdd * 100, 1),
        "sharpe": round(float(m["ret"].mean() * 12 / vol), 2) if vol else None,
        "invested": round(float(m["invested"].mean()) * 100, 0),
        "beat_years": int((by_year["p"] > by_year["i"]).sum()), "years": int(len(by_year)),
        "by_year": {int(y): {"p": round(float(r.p) * 100, 1), "i": round(float(r.i) * 100, 1)} for y, r in by_year.iterrows()},
        "curve": [[d.date().isoformat(), round(float(a), 4), round(float(b), 4)] for d, a, b in zip(m.index, eq, ix)],
    }


STRATEGIES = {
    "index_trend": ("S&P 500, sadece endeks 200 günlük ortalamanın üstündeyken", None, 0, True),
    "mom_10": ("12-1 ay momentum, en güçlü 10 hisse", "mom", 10, False),
    "mom_20": ("12-1 ay momentum, en güçlü 20 hisse", "mom", 20, False),
    "mom_10_trend": ("12-1 ay momentum, en güçlü 10 hisse + endeks trend filtresi", "mom", 10, True),
    "mom_20_trend": ("12-1 ay momentum, en güçlü 20 hisse + endeks trend filtresi", "mom", 20, True),
    "mom_50_trend": ("12-1 ay momentum, en güçlü 50 hisse + endeks trend filtresi", "mom", 50, True),
    "ramom_20_trend": ("Oynaklığa göre düzeltilmiş momentum, 20 hisse + trend filtresi", "ramom", 20, True),
    "hi52_20_trend": ("52 haftalık zirveye en yakın 20 hisse + trend filtresi", "hi52", 20, True),
    "ramom_20": ("Oynaklığa göre düzeltilmiş momentum, 20 hisse (trend filtresiz)", "ramom", 20, False),
    "index": ("S&P 500'ü tut (endeks fonu)", None, 0, False),
}
PRIMARY = "mom_20_trend"        # önceden belirlenen aday (geçemedi)
RECOMMENDED = "index"           # risk/getiri en iyisi
EXPERIMENT = "ramom_20"         # canlı test edilen deneysel strateji
FORWARD_START = "2026-11-13"    # deneysel stratejinin canlı testi bu tarihten başlar (araştırma tarihi)


def run(prices: pd.DataFrame) -> dict:
    close, dv, idx = _panels(prices)
    sig = signals(close, dv, idx)
    out = {}
    for name, (desc, score, n, trend) in STRATEGIES.items():
        out[name] = {"desc": desc, **stats(backtest(close, sig, idx, score, n, trend))}
    return out


def current_portfolio(prices: pd.DataFrame, name: str = PRIMARY) -> dict:
    """Bugünkü (son ay sonu değil, son işlem günü) portföy önerisi: trend durumu ve sıralı hisseler."""
    desc, score, n, trend = STRATEGIES[name]
    close, dv, idx = _panels(prices)
    sig = signals(close, dv, idx)
    t = close.index[-1]
    in_market = bool(sig["trend"].asof(t)) if trend else True
    elig = sig["eligible"].loc[t]
    sc = sig[score].loc[t][elig].dropna().nlargest(n)
    ma200 = float(idx.rolling(200).mean().iloc[-1])
    return {"strategy": name, "desc": desc, "date": t.date().isoformat(), "in_market": in_market,
            "index_close": round(float(idx.iloc[-1]), 2), "index_ma200": round(ma200, 2),
            "holdings": [{"yf": s, "score": round(float(v) * 100, 1)} for s, v in sc.items()] if in_market else []}


def forward(prices: pd.DataFrame, name: str = EXPERIMENT, start: str = FORWARD_START) -> dict | None:
    """Canlı (ileriye dönük) test: başlangıç gününde ve her ay sonunda yeniden dengeleme; sadece o güne kadarki veri."""
    desc, score, n, _ = STRATEGIES[name]
    close, dv, idx = _panels(prices)
    sig = signals(close, dv, idx)
    c = close.ffill(limit=5)
    t_start = close.index[close.index >= pd.Timestamp(start)]
    if not len(t_start):
        return None
    reb = [t_start[0]] + [d for d in month_ends(close.index) if d > t_start[0]]
    if reb[-1] != close.index[-1]:
        reb.append(close.index[-1])  # son nokta: bugünkü değer
    eq, ix, curve, prev = 1.0, 1.0, [[reb[0].date().isoformat(), 1.0, 1.0]], set()
    holdings: list[str] = []
    for t0, t1 in zip(reb[:-1], reb[1:]):
        elig = sig["eligible"].loc[t0]
        hold = list(sig[score].loc[t0][elig].dropna().nlargest(n).index)
        turnover = len(set(hold) ^ prev) / max(len(set(hold) | prev), 1)
        r = float((c.loc[t1, hold] / c.loc[t0, hold] - 1).fillna(0).mean()) - turnover * 2 * COST
        eq *= 1 + r
        ix *= float(idx.asof(t1) / idx.asof(t0))
        curve.append([t1.date().isoformat(), round(eq, 4), round(ix, 4)])
        prev, holdings = set(hold), hold
    return {"strategy": name, "desc": desc, "start": reb[0].date().isoformat(), "end": reb[-1].date().isoformat(),
            "return_pct": round((eq - 1) * 100, 2), "index_return_pct": round((ix - 1) * 100, 2), "curve": curve,
            "holdings": holdings}


def _txt(res: dict) -> str:
    lines = ["ABD STRATEJİ KARŞILAŞTIRMASI (aylık yeniden dengeleme, maliyet dahil, 2018'den beri)", "",
             f"{'strateji':16} {'yıllık':>7} {'S&P':>6} {'düşüş':>7} {'S&P':>6} {'Sharpe':>7} {'yatırımda':>9} {'yıl önde':>9}"]
    for k, r in res.items():
        lines.append(f"{k:16} {r['cagr']:>6.1f}% {r['index_cagr']:>5.1f}% {r['max_dd']:>6.1f}% {r['index_max_dd']:>5.1f}% "
                     f"{r['sharpe'] if r['sharpe'] is not None else '-':>7} {r['invested']:>8.0f}% {r['beat_years']:>4}/{r['years']}")
    lines.append("")
    for k in (PRIMARY, "index_trend"):
        lines.append(f"{k} yıl yıl: " + ", ".join(f"{y}: {v['p']:+.0f}% (S&P {v['i']:+.0f}%)" for y, v in res[k]["by_year"].items()))
    return "\n".join(lines)


def main() -> None:
    prices = history.load_long()
    res = run(prices)
    REPORT_JSON.write_text(json.dumps({"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "primary": PRIMARY,
                                       "strategies": res}, ensure_ascii=False), encoding="utf-8")
    txt = _txt(res)
    REPORT_TXT.write_text(txt, encoding="utf-8")
    print(txt)


if __name__ == "__main__":
    main()
