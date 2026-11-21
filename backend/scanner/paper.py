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
# Boştaki nakit endekste (seçenek): haftada bir, sermayenin IDLE_BUFFER'ı nakitte kalacak şekilde fazlası endeks
# fonuna (BYF) yatırılır; yeni alımda nakit yetmezse fon satılır ve nakit payı tamamlanır. Her alım-satım için
# yeni pozisyonda fonu döndürmek maliyetle getiriyi yiyor (testte görüldü); bu yüzden tampon ve haftalık düzen.
IDX_COST = 0.001        # endeks fonu alım-satım maliyeti (tek yön; komisyon + kayma)
IDLE_BUFFER = 0.10      # nakitte tutulan pay
IDLE_MIN_MOVE = 0.02    # bundan küçük fazlalık yatırılmaz
# Düşüş freni (scanner/drawdown.py testi, 16 Kasım 2026; seçenekler ve şart önceden sabitlendi): portföy zirvesinden
# %25 düşünce yeni pozisyonlar yarıya. BIST 2018'den beri: yıllık %49,0 -> %46,3, en büyük düşüş %46,2 -> %38,5
# (getiri/düşüş 1,06 -> 1,20). Bedeli: toparlanmada frende kalınca 2023 +%1,7 yerine -%13,2. ABD'de şartı geçen yok.
BRAKE = {"BIST": {"kind": "dd", "level": -0.25, "scale": 0.5}}
# Portföy düzeni (scanner/diversify.py testi, 16 Kasım 2026; seçenekler ve şart önceden sabit): BIST'te haftada 10 aday,
# en çok 20 pozisyon, işlem başına %0,6 risk, aynı sektörde en çok 3 pozisyon. 2018'den beri: yıllık %46,3 -> %52,3,
# en büyük düşüş %38,5 -> %31,5 (getiri/düşüş 1,20 -> 1,66). Uyarı: kazanç 2018-2023'ten; 2024-2026'da her yıl geride.
# ABD'de şartı geçen yok (varsayılanlar).
PORTFOLIO = {"BIST": {"top_k": 10, "max_positions": 20, "risk_pct": 0.006, "sector_cap": 3}}


def portfolio_settings(market: str) -> dict:
    return {"top_k": BACKTEST_TOP_K, "max_positions": MAX_POSITIONS, "risk_pct": RISK_PCT, "sector_cap": None,
            **PORTFOLIO.get(market, {})}


def _sim_kwargs(market: str, sector_of: dict[str, str] | None) -> dict:
    """simulate için piyasanın düzeni: düşüş freni, risk, pozisyon sayısı, sektör sınırı."""
    ps = portfolio_settings(market)
    return {"brake": BRAKE.get(market), "risk_pct": ps["risk_pct"], "max_positions": ps["max_positions"],
            "sector_cap": ps["sector_cap"], "sector_of": sector_of if ps["sector_cap"] else None}


def _sector_map() -> dict[str, str] | None:
    try:
        from . import research
        return research.sector_map()
    except Exception as exc:  # sektör bilgisi yoksa sektör sınırı uygulanmaz
        print(f"  ! sektör eşlemesi: {exc!r}")
        return None


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
             max_closed: int = 40, idle: str = "cash", brake: dict | None = None,
             risk_pct: float = RISK_PCT, max_positions: int = MAX_POSITIONS,
             sector_cap: int | None = None, sector_of: dict[str, str] | None = None,
             cooldown_days: int = 0, week_cap: int | None = None) -> dict:
    """signals: date (liste günü), symbol, yf, entry_low, entry_high, stop, target1, atr, exit_rule (dict|None),
    risk_scale. Günlük adımlarla nakit, pozisyon ve özsermaye izlenir.
    idle: boştaki para "cash" (getirisiz nakit) ya da "index" (gün sonunda endeks fonuna; yeni alım için açılışta
    satılır; her yönde IDX_COST maliyet).
    brake: düşüş kontrolü (yalnızca o güne kadar bilinenle; yeni alımlarda pozisyon çarpanı):
      {"kind": "dd", "level": -0.15, "scale": 0.5}  portföy zirvesinden düşüş level'ın altındaysa
      {"kind": "form", "n": 10, "scale": 0.5}         son n kapanan işlemin ortalama R'si <= 0 ise
    risk_pct, max_positions: işlem başına risk ve en fazla açık pozisyon (varsayılan: RISK_PCT, MAX_POSITIONS).
    sector_cap: aynı sektörde en fazla bu kadar açık pozisyon (sector_of: yahoo kodu -> sektör).
    cooldown_days: bir hisse stop olunca bu kadar iş günü o hisseye yeniden girilmez.
    week_cap: bir takvim haftasında en fazla bu kadar yeni pozisyon (aynı hafta açılıp birlikte stop olmasın)."""
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
    idle_units = 0.0  # boştaki paranın endeks fonundaki payı (idle="index")
    positions: dict[str, dict] = {}
    pending: dict[str, dict] = {}
    closed: list[dict] = []
    curve = []
    by_day = {d: g for d, g in signals.groupby("date")}
    index_units = CAPITAL[market] / idx.loc[days[0], "open"]  # ilk gün açılışta endeks alınsaydı
    peak_eq, max_dd, peak_ix, max_dd_ix = 0.0, 0.0, 0.0, 0.0
    brake_buys = [0]  # frenli alım sayısı (iç fonksiyondan değiştirilebilsin diye liste)
    last_stop: dict[str, pd.Timestamp] = {}  # hisse -> son stop günü (cooldown_days)
    week_buys: dict[tuple, int] = {}  # (yıl, hafta) -> yeni pozisyon sayısı (week_cap)

    def cooling(key: str, d) -> bool:
        return bool(cooldown_days and key in last_stop
                    and np.busday_count(last_stop[key].date(), d.date()) < cooldown_days)

    def braking() -> bool:
        if not brake:
            return False
        if brake["kind"] == "dd":
            return bool(peak_eq) and eq / peak_eq - 1 <= brake["level"]
        rs_ = [c["r"] for c in closed[-brake["n"]:]]
        return len(rs_) >= brake["n"] and float(np.mean(rs_)) <= 0
    invested_share = []

    def equity_at(d) -> float:
        val = cash + (idle_units * idx["close"].asof(d) if idle_units else 0.0)
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

    periods = days.to_period("W")
    week_ends = {d for i, d in enumerate(days) if i == len(days) - 1 or periods[i + 1] != periods[i]}

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
                if how == "stop":
                    last_stop[key] = d
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
            sector_full = bool(sector_cap and sector_of and sector_of.get(s.yf) and sum(
                sector_of.get(p["yf"]) == sector_of[s.yf] for p in positions.values()) >= sector_cap)
            wk = tuple(d.isocalendar()[:2])
            week_full = bool(week_cap and week_buys.get(wk, 0) >= week_cap)
            if cooling(key, d):
                del pending[key]  # stop sonrası bekleme: bu hisseye şimdilik girilmez
                continue
            if (l <= s.entry_high and h >= s.entry_low and not limit_up and len(positions) < max_positions
                    and not sector_full and not week_full
                    and key not in positions):
                fill = float(min(max(o, s.entry_low), s.entry_high))
                risk = fill - s.stop
                if risk > 0:
                    scale = s.risk_scale if pd.notna(s.risk_scale) else 1.0
                    if braking():
                        scale *= brake["scale"]
                        brake_buys[0] += 1
                    tv = b.loc[d, "tv"]
                    liquidity_cap = PARTICIPATION * tv / fill if pd.notna(tv) and tv > 0 else 0
                    ix_open = idx.loc[d, "open"]
                    avail = cash + idle_units * ix_open * (1 - IDX_COST)  # endeksteki para satılarak kullanılabilir
                    shares = math.floor(min(eq * risk_pct * scale / risk, eq * MAX_POS_PCT / fill,
                                            avail / (fill * (1 + cost)), liquidity_cap))
                    if shares > 0:
                        rule = s.exit_rule if isinstance(s.exit_rule, dict) else assistant_track.BASE_RULE
                        target = s.target1 if rule["target"] == "plan" else (fill + rule["target"] * risk if rule["target"] else None)
                        need = shares * fill * (1 + cost)
                        if need > cash and idle_units > 0:
                            # eksik nakit için endeks payı açılışta satılır; nakit payı da tamamlanır (sık satış olmasın)
                            want = need - cash + IDLE_BUFFER * eq
                            sell = min(idle_units, want / (ix_open * (1 - IDX_COST)))
                            idle_units -= sell
                            cash += sell * ix_open * (1 - IDX_COST)
                        cash -= need
                        week_buys[wk] = week_buys.get(wk, 0) + 1
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
                            last_stop[key] = d
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
            if s.symbol not in positions and s.symbol not in pending and not cooling(s.symbol, d):
                pending[s.symbol] = {"s": s, "left": ENTRY_DAYS}

        # 4) boştaki nakit (idle="index"): haftanın son günü, IDLE_BUFFER'ın üstündeki nakit endeks fonuna yatırılır
        if idle == "index" and d in week_ends:
            eq_now = equity_at(d)
            excess = cash - IDLE_BUFFER * eq_now
            if excess > IDLE_MIN_MOVE * eq_now:
                idle_units += excess / (idx.loc[d, "close"] * (1 + IDX_COST))
                cash -= excess

        # 5) özsermaye ve endeks
        eq = equity_at(d)
        ix = index_units * idx.loc[d, "close"]
        peak_eq, peak_ix = max(peak_eq, eq), max(peak_ix, ix)
        max_dd = min(max_dd, eq / peak_eq - 1)
        max_dd_ix = min(max_dd_ix, ix / peak_ix - 1)
        invested_share.append(1 - (cash + idle_units * idx.loc[d, "close"]) / eq if eq else 0)  # hisselerdeki pay
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
        "market": market, "currency": CURRENCY[market], "capital": CAPITAL[market], "idle": idle,
        **({"brake": brake, "brake_buys": brake_buys[0]} if brake else {}),
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
        "settings": {"risk_pct": risk_pct * 100, "max_pos_pct": MAX_POS_PCT * 100, "max_positions": max_positions,
                     "sector_cap": sector_cap,
                     "cost_pct": COST[market] * 100, "entry_days": ENTRY_DAYS},
    }


# ------------------------------------------------------------------ canlı: asistanın gerçek listeleri

def drawdown_now(res: dict | None) -> float | None:
    """Portföyün şu anki düşüşü (zirveye göre, 0 ile -1 arası); eğri yoksa None."""
    if not res or not res.get("curve"):
        return None
    eq = [e for _, e, _ in res["curve"]]
    return eq[-1] / max(eq) - 1 if max(eq) > 0 else None


def live(history: list[dict], prices: pd.DataFrame, yf_of: dict[str, str]) -> dict:
    out = {}
    smap = _sector_map()
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
            sig = sig.dropna(subset=["yf"])
            start = str(sig["date"].min().date())
            kw = _sim_kwargs(market, smap)
            res = simulate(sig, prices, market, start=start, **kw)
            if res:
                res["idle_index"] = idle_summary(simulate(sig, prices, market, start=start, idle="index", **kw))
                out[market] = res
    return out


IDLE_FIELDS = ("equity", "return_pct", "cagr_pct", "max_dd_pct", "exposure_pct", "curve")


def idle_summary(res: dict) -> dict | None:
    """Aynı işlemler, boştaki para endekste tutularak: karşılaştırma için özet (ve getiri eğrisi)."""
    return {k: res[k] for k in IDLE_FIELDS if k in res} if res else None


# ------------------------------------------------------------------ test: 2018'den bugüne

def regime_labels(g: pd.DataFrame, prices: pd.DataFrame, market: str) -> pd.Series:
    """Asistanın piyasa rejimi (market.regime) geçmişteki her örnek günü için: endeks 200 günlük ortalamanın üstünde
    mi, endeksin 50 günlük ortalaması yükseliyor mu, 200 ve 50 günlük ortalamanın üstündeki hisse oranı. (Yeni
    zirve/dip bileşeni örneklerde yok; puan -4..+4 aralığında, etiket eşikleri aynı.)"""
    from .market import REGIMES
    idx = prices[prices["yf_symbol"] == MAIN_INDEX[market]].set_index("date")["close"].sort_index()
    e50 = idx.ewm(span=50, adjust=False).mean()
    rising = g["date"].map((e50 > e50.shift(10)).astype(int) * 2 - 1).fillna(0)
    breadth = lambda s: np.where(s >= 60, 1, np.where(s <= 40, -1, 0))  # noqa: E731
    score = (g["ctx_idx_above200"].fillna(1) * 2 - 1) + rising + breadth(g["ctx_above200"]) + breadth(g["ctx_above50"])
    return pd.Series([next(lab for th, lab, _ in REGIMES if s >= th) for s in score], index=g.index)


def backtest_signals(top_k: int | None = None, adjust=None,
                     ) -> tuple[pd.DataFrame, dict[str, tuple[pd.DataFrame, dict, list[str]]]]:
    """Test portföyünün girdileri: (fiyatlar, piyasa -> (sinyaller, yıl yıl çıkış kuralı, çıkarılan hisseler)).
    top_k: haftalık aday sayısı (yoksa piyasanın düzeni: portfolio_settings).
    adjust: isteğe bağlı fonksiyon (aday tablosu, piyasa) -> aday tablosu; sıralamadan önce uygulanır, satır silebilir ya
    da "quality"yi değiştirebilir (araştırmalar için, ör. kaplab: KAP olaylarına göre eleme ve öne alma)."""
    from . import assistant, exits, history as hist, learn
    samples = pd.read_parquet(learn.SAMPLES_FILE)
    samples = samples[learn.live_like(samples) & (samples["date"] >= BACKTEST_START)].copy()
    samples["quality"] = [learn.rule_quality(f) for f in samples[["combined_score", "rs_rating", "rr", "ext_atr"]].to_dict("records")]
    rep = json.loads(exits.REPORT_JSON.read_text(encoding="utf-8")) if exits.REPORT_JSON.exists() else {}
    prices = hist.load_long()
    out = {}
    for market, g in samples.groupby("market"):
        bad = anomalies(prices, market)
        g = g[~g["yf_symbol"].isin(bad)].copy()
        g["regime"] = regime_labels(g, prices, market)
        weak = g["regime"].isin(["Zayıf", "Ayı"]) & (market in assistant.BEAR_MIN_RS_MARKETS)
        g = g[g["rs_rating"] >= np.where(weak, assistant.BEAR_MIN_RS, assistant.MIN_RS)]
        if adjust is not None:
            g = adjust(g, market)
        ranked = g.sort_values("quality", ascending=False)
        rank = ranked.groupby("date").cumcount()
        limit = ranked["regime"].map(lambda r: assistant.REGIME_LIMITS[r][0])
        top = ranked[rank < np.minimum(top_k or portfolio_settings(market)["top_k"], limit)]
        wf = {y["year"]: y["chosen"] for y in rep.get("walk_forward", {}).get("live", {}).get(market, {}).get("years", [])}
        rule_of = lambda d: ({"name": wf[d.year], **exits.POLICIES[wf[d.year]][1]} if d.year in wf else None)  # noqa: E731
        sig = pd.DataFrame({
            "date": top["date"], "symbol": top["symbol"].fillna(top["yf_symbol"]), "yf": top["yf_symbol"],
            "entry_low": top["entry_low"], "entry_high": top["entry_high"], "stop": top["stop"], "target1": top["target1"],
            "atr": top["atr_pct"] / 100 * top["close"], "exit_rule": [rule_of(d) for d in top["date"]],
            "risk_scale": top["regime"].map(lambda r: assistant.REGIME_LIMITS[r][1]),
            "regime": top["regime"],
        })
        out[market] = (sig, wf, sorted(s.removesuffix(".IS") for s in bad))
    return prices, out


def backtest() -> dict:
    """Yeniden oynatma örneklerinden her hafta canlı süzgeçten geçen ilk BACKTEST_TOP_K kurulum (asistanın sıralaması);
    çıkış kuralı her yıl, o yıldan önceki yıllarda en iyi olan kuraldır (exits.py kayan seçim: geleceği görmeden).
    Canlı asistanın rejim kuralları da uygulanır: zayıf piyasada liste kısalır ve pozisyon küçülür (REGIME_LIMITS),
    ABD'de zayıf/ayı piyasada yalnızca göreli gücü yüksek hisseler (BEAR_MIN_RS)."""
    prices, inputs = backtest_signals()
    smap = _sector_map()
    out = {}
    for market, (sig, wf, excluded) in inputs.items():
        kw = _sim_kwargs(market, smap)
        res = simulate(sig, prices, market, start=BACKTEST_START, **kw)
        if res:
            res["idle_index"] = idle_summary(simulate(sig, prices, market, start=BACKTEST_START, idle="index", **kw))
            if BRAKE.get(market):  # karşılaştırma: fren olmasaydı (aynı düzen)
                nb = simulate(sig, prices, market, start=BACKTEST_START, **{**kw, "brake": None})
                res["without_brake"] = {k: nb[k] for k in ("cagr_pct", "max_dd_pct", "return_pct") if k in nb}
            res["rules_by_year"] = {str(y): r for y, r in sorted(wf.items())}
            res["excluded"] = excluded
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
            ii = r.get("idle_index")
            if ii:
                print(f"    boştaki nakit endekste: portföy {ii['return_pct']:+.1f}% (yıllık {ii['cagr_pct']}%) | "
                      f"en büyük düşüş {ii['max_dd_pct']}%")


if __name__ == "__main__":
    main()
