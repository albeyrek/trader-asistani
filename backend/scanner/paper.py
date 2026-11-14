"""Sanal portföy: asistanın önerileri gerçek bir hesap gibi uygulansaydı ne olurdu?

python -m scanner.paper --backtest     # 2018'den bugüne test portföyü (haftalık öğrenmede çalışır)

Kurallar (canlı ve test aynı):
  - Piyasa başına ayrı hesap: BIST 100.000 ₺, ABD 10.000 $ başlangıç.
  - Asistanın listesindeki her aday için, listeden sonraki ENTRY_DAYS gün içinde fiyat giriş bölgesine gelirse alınır
    (açılış bölgedeyse açılıştan, değilse bölge sınırından). Zaten tutulan ya da bekleyen hisse tekrar alınmaz.
  - Lot: sermayenin RISK_PCT'si (zayıf piyasada listenin pozisyon çarpanıyla küçültülür) stopta kaybedilecek şekilde;
    tek pozisyon sermayenin MAX_POS_PCT'sini ve hissenin günlük işlem hacminin PARTICIPATION'ını geçmez; en fazla
    MAX_POSITIONS açık pozisyon; nakit yetmezse alınmaz.
  - BIST'te tavan civarında açılan hisse alınamaz, tabanda kilitli günde satılamaz.
  - Çıkış: adayın çıkış kuralı (BIST'te iz süren stop, ABD'de ilk hedef / 20 gün; bkz. exits.py).
  - Maliyet: her alış ve satışta komisyon + kayma (COST); vergi hesaba katılmaz.
  - Kıyas: aynı gün aynı sermayeyle endeks (BIST 100 / S&P 500) alınsaydı.
"""
import argparse
import json
import math

import numpy as np
import pandas as pd

from . import assistant_track
from .config import DATA_DIR, MAIN_INDEX

LIVE_FILE = DATA_DIR / "paper_live.json"
BACKTEST_FILE = DATA_DIR / "paper_backtest.json"
CAPITAL = {"BIST": 100_000.0, "US": 10_000.0}
CURRENCY = {"BIST": "TRY", "US": "USD"}
COST = {"BIST": 0.0025, "US": 0.0008}  # işlem başına (komisyon + BSMV + kayma) — tek yön
RISK_PCT = 0.01
MAX_POS_PCT = 0.20
MAX_POSITIONS = 10
ENTRY_DAYS = assistant_track.ENTRY_DAYS
BACKTEST_START = "2018-01-01"
BACKTEST_TOP_K = 5
# BIST'te günlük fiyat sınırı ±%10: tek günde bundan çok büyük sıçrama ters bölünme ya da veri hatasıdır.
# Böyle hisseler testten çıkarılır (yeniden oynatma örnekleri eski fiyat ölçeğinde hesaplanmış olabilir).
ANOMALY_JUMP = {"BIST": 0.35}
# Gerçekçilik (BIST): tavan civarında açılan hisse alınamaz (satıcı yok), tabanda kilitli günde satılamaz.
LIMIT_UP_OPEN = 1.095   # açılış önceki kapanışın %9,5 üstündeyse alım yok
LIMIT_DOWN_LOCK = 0.905  # gün boyu tek fiyat ve kapanış %9,5 altındaysa satış ertesi güne kalır
# Likidite: pozisyon, hissenin son 20 günlük ortalama işlem hacminin (tutar) en fazla PARTICIPATION'ı kadar olabilir
# (sığ hisselerde büyük pozisyon gerçekçi değil; bugün likit olan hisse geçmişte çok sığ olabilirdi)
PARTICIPATION = 0.02


def _bars(prices: pd.DataFrame, yf: str) -> pd.DataFrame | None:
    g = prices[prices["yf_symbol"] == yf]
    if not len(g):
        return None
    b = g.set_index("date").sort_index()[["open", "high", "low", "close", "volume"]].copy()
    b["tv"] = (b["close"] * b["volume"]).rolling(20, min_periods=5).mean().shift()  # o güne kadar bilinen hacim
    return b


def anomalies(prices: pd.DataFrame, market: str) -> set[str]:
    """Günlük sınırı aşan (veri hatası/ters bölünme) sıçraması olan hisseler."""
    lim = ANOMALY_JUMP.get(market)
    if not lim:
        return set()
    px = prices[prices["yf_symbol"].str.endswith(".IS")] if market == "BIST" else prices
    chg = px.sort_values(["yf_symbol", "date"]).groupby("yf_symbol")["close"].pct_change()
    return set(px.loc[chg.abs() > lim, "yf_symbol"])


def simulate(signals: pd.DataFrame, prices: pd.DataFrame, market: str, start: str | None = None,
             max_closed: int = 40) -> dict:
    """signals: date (liste günü), symbol, yf, entry_low, entry_high, stop, target1, atr, exit_rule (dict|None),
    risk_scale. Günlük adımlarla nakit, pozisyon ve özsermaye izlenir."""
    idx = _bars(prices, MAIN_INDEX[market])
    if idx is None or signals.empty:
        return {}
    signals = signals.sort_values("date")
    first = pd.Timestamp(start) if start else signals["date"].min()
    days = idx.index[idx.index > first]
    if not len(days):
        return {}
    bars = {yf: _bars(prices, yf) for yf in signals["yf"].dropna().unique()}
    for b in bars.values():
        if b is not None:
            b["prev"] = b["close"].shift()
    bist = market == "BIST"
    cost = COST[market]
    cash = CAPITAL[market]
    positions: dict[str, dict] = {}
    pending: dict[str, dict] = {}
    closed: list[dict] = []
    curve = []
    by_day = {d: g for d, g in signals.groupby("date")}
    index_units = CAPITAL[market] / idx.loc[days[0], "open"]  # ilk gün açılışta endeks alınsaydı
    peak_eq, max_dd, peak_ix, max_dd_ix = 0.0, 0.0, 0.0, 0.0
    invested_share = []

    def equity_at(d) -> float:
        val = cash
        for p in positions.values():
            b = bars.get(p["yf"])
            px = b["close"].asof(d) if b is not None else p["fill"]
            val += p["shares"] * (px if pd.notna(px) else p["fill"])
        return val

    # Liste günü <= ilk günden önceki sinyaller bekleyen emir olarak başlar
    for d0, g in by_day.items():
        if d0 <= first:
            for s in g.itertuples():
                pending[s.symbol] = {"s": s, "left": ENTRY_DAYS}

    for d in days:
        # 1) açık pozisyonlarda çıkış
        for key in list(positions):
            p = positions[key]
            b = bars.get(p["yf"])
            if b is None or d not in b.index:
                continue
            o, h, l, c, prev = b.loc[d, ["open", "high", "low", "close", "prev"]]
            first_bar = p["entry_date"] == d
            if bist and h == l and pd.notna(prev) and c <= prev * LIMIT_DOWN_LOCK:
                p["held"] += 1  # taban kilidi: bugün satılamaz, ertesi gün açılışta stop kontrolü
                continue
            exit_px, how = None, None
            if p["trail"]:
                p["cur_stop"] = max(p["cur_stop"], p["peak"] - p["trail"] * p["atr"])
            if l <= p["cur_stop"]:
                exit_px, how = (o if (not first_bar and o < p["cur_stop"]) else p["cur_stop"]), "stop"
            else:
                if p["partial"] and not p["half_done"] and h >= p["fill"] + p["partial"] * p["risk"]:
                    sell = p["shares"] // 2
                    px = p["fill"] + p["partial"] * p["risk"]
                    cash += sell * px * (1 - cost)
                    p["shares"] -= sell
                    p["realized"] += sell * (px * (1 - cost) - p["fill"] * (1 + cost))
                    p["half_done"] = True
                if p["target"] is not None and h >= p["target"]:
                    exit_px, how = (o if (not first_bar and o > p["target"]) else p["target"]), "target"
                elif p["breakeven"] and h >= p["fill"] + p["breakeven"] * p["risk"]:
                    p["cur_stop"] = max(p["cur_stop"], p["fill"])
                p["peak"] = max(p["peak"], c)
                p["held"] += 1
                if exit_px is None and p["held"] >= p["hold"]:
                    exit_px, how = c, "time"
            if exit_px is not None:
                cash += p["shares"] * exit_px * (1 - cost)
                pnl = p["realized"] + p["shares"] * (exit_px * (1 - cost) - p["fill"] * (1 + cost))
                r = (exit_px - p["fill"]) / p["risk"]
                closed.append({"symbol": key, "entry_date": p["entry_date"].date().isoformat(), "fill": round(p["fill"], 4),
                               "exit_date": d.date().isoformat(), "exit": round(float(exit_px), 4), "how": how,
                               "pnl": round(float(pnl), 2), "pnl_pct": round(float(pnl / p["cost_basis"] * 100), 2),
                               "r": round(float(r), 2), "days": p["held"] + (1 if how == "stop" else 0)})
                del positions[key]

        # 2) bekleyen emirler: giriş bölgesine gelen alınır
        eq = equity_at(d)
        for key in list(pending):
            o_ = pending[key]
            s = o_["s"]
            b = bars.get(s.yf)
            if b is None or d not in b.index:
                o_["left"] -= 1
                if o_["left"] <= 0:
                    del pending[key]
                continue
            o, h, l, c, prev = b.loc[d, ["open", "high", "low", "close", "prev"]]
            limit_up = bist and pd.notna(prev) and o >= prev * LIMIT_UP_OPEN
            if (l <= s.entry_high and h >= s.entry_low and not limit_up and len(positions) < MAX_POSITIONS
                    and key not in positions):
                fill = float(min(max(o, s.entry_low), s.entry_high))
                risk = fill - s.stop
                if risk > 0:
                    scale = s.risk_scale if pd.notna(s.risk_scale) else 1.0
                    tv = b.loc[d, "tv"]
                    liquidity_cap = PARTICIPATION * tv / fill if pd.notna(tv) and tv > 0 else 0
                    shares = math.floor(min(eq * RISK_PCT * scale / risk, eq * MAX_POS_PCT / fill,
                                            cash / (fill * (1 + cost)), liquidity_cap))
                    if shares > 0:
                        rule = s.exit_rule if isinstance(s.exit_rule, dict) else assistant_track.BASE_RULE
                        target = s.target1 if rule["target"] == "plan" else (fill + rule["target"] * risk if rule["target"] else None)
                        cash -= shares * fill * (1 + cost)
                        positions[key] = {
                            "yf": s.yf, "shares": shares, "fill": fill, "risk": risk, "stop": s.stop, "cur_stop": s.stop,
                            "peak": fill, "target": target, "hold": rule["hold"], "trail": rule.get("trail"),
                            "breakeven": rule.get("breakeven"), "partial": rule.get("partial"), "half_done": False,
                            "atr": float(s.atr) if pd.notna(s.atr) and s.atr else risk / 1.5, "entry_date": d, "held": 0,
                            "realized": 0.0, "cost_basis": shares * fill * (1 + cost),
                        }
                        # Giriş günü stop kontrolü (temkinli: gün içi sıra bilinmiyor)
                        if l <= s.stop:
                            px = s.stop
                            cash += shares * px * (1 - cost)
                            pnl = shares * (px * (1 - cost) - fill * (1 + cost))
                            closed.append({"symbol": key, "entry_date": d.date().isoformat(), "fill": round(fill, 4),
                                           "exit_date": d.date().isoformat(), "exit": round(float(px), 4), "how": "stop",
                                           "pnl": round(float(pnl), 2), "pnl_pct": round(float(pnl / positions[key]["cost_basis"] * 100), 2),
                                           "r": -1.0, "days": 1})
                            del positions[key]
                        else:
                            positions[key]["peak"] = max(fill, c)
                            positions[key]["held"] = 1
                del pending[key]
            else:
                o_["left"] -= 1
                if o_["left"] <= 0:
                    del pending[key]

        # 3) günün listesi: ertesi günden itibaren bekleyen emir
        for s in by_day.get(d, pd.DataFrame()).itertuples() if d in by_day else []:
            if s.symbol not in positions and s.symbol not in pending:
                pending[s.symbol] = {"s": s, "left": ENTRY_DAYS}

        # 4) özsermaye ve endeks
        eq = equity_at(d)
        ix = index_units * idx.loc[d, "close"]
        peak_eq, peak_ix = max(peak_eq, eq), max(peak_ix, ix)
        max_dd = min(max_dd, eq / peak_eq - 1)
        max_dd_ix = min(max_dd_ix, ix / peak_ix - 1)
        invested_share.append(1 - cash / eq if eq else 0)
        curve.append((d, eq, ix))

    last = days[-1]
    open_rows = []
    for key, p in positions.items():
        b = bars.get(p["yf"])
        px = float(b["close"].asof(last)) if b is not None else p["fill"]
        open_rows.append({"symbol": key, "entry_date": p["entry_date"].date().isoformat(), "fill": round(p["fill"], 4),
                          "last": round(px, 4), "stop": round(float(p["cur_stop"]), 4), "shares": int(p["shares"]),
                          "value": round(p["shares"] * px, 2), "pnl_pct": round((px / p["fill"] - 1) * 100, 2),
                          "r": round((px - p["fill"]) / p["risk"], 2), "days": p["held"]})
    eq_final = curve[-1][1]
    ix_final = curve[-1][2]
    rs = [t["r"] for t in closed]
    years = max((last - days[0]).days / 365.25, 1e-9)
    step = 1 if len(curve) <= 400 else 5  # uzun testte haftalık nokta (dosya küçük kalsın)
    return {
        "market": market, "currency": CURRENCY[market], "capital": CAPITAL[market],
        "start": days[0].date().isoformat(), "end": last.date().isoformat(),
        "equity": round(eq_final, 2), "return_pct": round((eq_final / CAPITAL[market] - 1) * 100, 2),
        "index_return_pct": round((ix_final / CAPITAL[market] - 1) * 100, 2),
        "cagr_pct": round(((eq_final / CAPITAL[market]) ** (1 / years) - 1) * 100, 2) if years >= 1 else None,
        "index_cagr_pct": round(((ix_final / CAPITAL[market]) ** (1 / years) - 1) * 100, 2) if years >= 1 else None,
        "max_dd_pct": round(max_dd * 100, 2), "index_max_dd_pct": round(max_dd_ix * 100, 2),
        "trades": len(closed), "open_count": len(open_rows),
        "win_rate": round(float(np.mean([r > 0 for r in rs])) * 100, 1) if rs else None,
        "avg_r": round(float(np.mean(rs)), 2) if rs else None,
        "exposure_pct": round(float(np.mean(invested_share)) * 100, 1) if invested_share else 0.0,
        "curve": [[d.date().isoformat(), round(e, 2), round(i, 2)] for d, e, i in curve[::step]]
        + ([[curve[-1][0].date().isoformat(), round(curve[-1][1], 2), round(curve[-1][2], 2)]] if step > 1 else []),
        "open": sorted(open_rows, key=lambda x: -x["value"]),
        "closed": list(reversed(closed))[:max_closed],
        "settings": {"risk_pct": RISK_PCT * 100, "max_pos_pct": MAX_POS_PCT * 100, "max_positions": MAX_POSITIONS,
                     "cost_pct": COST[market] * 100, "entry_days": ENTRY_DAYS},
    }


# ------------------------------------------------------------------ canlı: asistanın gerçek listeleri

def live(history: list[dict], prices: pd.DataFrame, yf_of: dict[str, str]) -> dict:
    out = {}
    for market in ("BIST", "US"):
        rows = []
        for h in (x for x in history if x["market"] == market):
            for c in h["candidates"]:
                rows.append({"date": pd.Timestamp(h["date"]), "symbol": c["symbol"],
                             "yf": c.get("yf") or yf_of.get(f"{market}:{c['symbol']}"), "entry_low": c["entry_low"],
                             "entry_high": c["entry_high"], "stop": c["stop"], "target1": c["target1"],
                             "atr": c.get("atr"), "exit_rule": c.get("exit_rule"), "risk_scale": h.get("risk_scale", 1.0)})
        sig = pd.DataFrame(rows)
        if len(sig):
            res = simulate(sig.dropna(subset=["yf"]), prices, market, start=str(sig["date"].min().date()))
            if res:
                out[market] = res
    return out


# ------------------------------------------------------------------ test: 2018'den bugüne

def backtest() -> dict:
    """Yeniden oynatma örneklerinden her hafta canlı süzgeçten geçen ilk BACKTEST_TOP_K kurulum (asistanın sıralaması);
    çıkış kuralı her yıl, o yıldan önceki yıllarda en iyi olan kuraldır (exits.py kayan seçim: geleceği görmeden)."""
    from . import exits, history as hist, learn
    samples = pd.read_parquet(learn.SAMPLES_FILE)
    samples = samples[learn.live_like(samples) & (samples["date"] >= BACKTEST_START)].copy()
    samples["quality"] = [learn.rule_quality(f) for f in samples[["combined_score", "rs_rating", "rr", "ext_atr"]].to_dict("records")]
    rep = json.loads(exits.REPORT_JSON.read_text(encoding="utf-8")) if exits.REPORT_JSON.exists() else {}
    prices = hist.load_long()
    out = {}
    for market, g in samples.groupby("market"):
        bad = anomalies(prices, market)
        g = g[~g["yf_symbol"].isin(bad)]

        wf = {y["year"]: y["chosen"] for y in rep.get("walk_forward", {}).get("live", {}).get(market, {}).get("years", [])}
        top = g.sort_values("quality", ascending=False).groupby("date").head(BACKTEST_TOP_K)
        rule_of = lambda d: ({"name": wf[d.year], **exits.POLICIES[wf[d.year]][1]} if d.year in wf else None)  # noqa: E731
        sig = pd.DataFrame({
            "date": top["date"], "symbol": top["symbol"].fillna(top["yf_symbol"]), "yf": top["yf_symbol"],
            "entry_low": top["entry_low"], "entry_high": top["entry_high"], "stop": top["stop"], "target1": top["target1"],
            "atr": top["atr_pct"] / 100 * top["close"], "exit_rule": [rule_of(d) for d in top["date"]], "risk_scale": 1.0,
        })
        res = simulate(sig, prices, market, start=BACKTEST_START)
        if res:
            res["rules_by_year"] = {str(y): r for y, r in sorted(wf.items())}
            res["excluded"] = sorted(s.removesuffix(".IS") for s in bad)
            out[market] = res
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--backtest", action="store_true")
    a = p.parse_args()
    if a.backtest:
        res = backtest()
        BACKTEST_FILE.write_text(json.dumps({"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "markets": res},
                                            ensure_ascii=False), encoding="utf-8")
        for m, r in res.items():
            print(f"{m}: {r['start']} – {r['end']} | portföy {r['return_pct']:+.1f}% (yıllık {r['cagr_pct']}%) | "
                  f"endeks {r['index_return_pct']:+.1f}% (yıllık {r['index_cagr_pct']}%) | en büyük düşüş {r['max_dd_pct']}% "
                  f"(endeks {r['index_max_dd_pct']}%) | {r['trades']} işlem, isabet %{r['win_rate']}, ort. {r['avg_r']}R, "
                  f"yatırımda ort. %{r['exposure_pct']}")


if __name__ == "__main__":
    main()
