"""Çekirdek hesapların birim testleri (ağ gerekmez): cd backend && python -m pytest -q"""
import numpy as np
import pandas as pd
import pytest

from scanner import assistant_track, health, kap_events, paper, prices, sectors


def bars(rows, start="2026-01-05"):
    """rows: (open, high, low, close) listesi -> iş günü tarihli mumlar."""
    d = pd.bdate_range(start, periods=len(rows))
    o, h, l, c = zip(*rows)
    return pd.DataFrame({"date": d, "open": o, "high": h, "low": l, "close": c, "volume": 1e6})


PLAN = {"symbol": "AAA", "setup": "pullback", "entry_low": 99.0, "entry_high": 101.0, "stop": 95.0, "target1": 110.0,
        "close": 100.0, "rr": 2.0}


# ------------------------------------------------------------------ asistan karnesi (çıkış kuralları)

def test_target_hit():
    b = bars([(100, 101, 99, 100), (101, 105, 100, 104), (104, 111, 103, 110)])
    r = assistant_track.simulate(PLAN, b)
    assert r["status"] == "target" and r["fill"] == 100.0
    assert r["r"] == pytest.approx(2.0)  # (110-100)/(100-95)


def test_stop_and_target_same_day_counts_as_stop():
    b = bars([(100, 101, 99, 100), (100, 112, 94, 105)])
    assert assistant_track.simulate(PLAN, b)["status"] == "stop"


def test_gap_below_stop_exits_at_open():
    b = bars([(100, 101, 99, 100), (92, 93, 90, 91)])
    r = assistant_track.simulate(PLAN, b)
    assert r["status"] == "stop" and r["exit"] == 92.0 and r["r"] == pytest.approx(-1.6)


def test_not_filled_when_price_never_reaches_zone():
    b = bars([(105, 107, 104, 106)] * 6)
    assert assistant_track.simulate(PLAN, b)["status"] == "not_filled"


def test_open_position_is_pending_result():
    b = bars([(100, 101, 99, 100), (100, 102, 99, 101)])
    r = assistant_track.simulate(PLAN, b)
    assert r["status"] == "open" and r["exit"] is None and r["last"] == 101.0


def test_trailing_stop_locks_profit():
    rule = {"name": "trail3", "target": None, "hold": 60, "trail": 3.0}
    c = {**PLAN, "atr": 2.0, "exit_rule": rule}
    # 100'den 120'ye çıkıp 110'a düşüyor: iz süren stop = en yüksek kapanış 120 - 3x2 = 114
    rows = [(100, 101, 99, 100)] + [(100 + 2 * i, 101 + 2 * i, 99 + 2 * i, 100 + 2 * i) for i in range(1, 11)]
    rows += [(118, 118, 110, 111)]
    r = assistant_track.simulate(c, bars(rows))
    assert r["status"] == "trail" and r["exit"] == pytest.approx(114.0) and r["r"] > 0


def test_run_exit_partial_and_breakeven():
    o = np.array([100, 101, 104, 101.0])
    h = np.array([101, 103, 106, 101.0])
    l = np.array([99, 100, 103, 99.0])
    c = np.array([100, 102, 105, 100.0])
    # yarısı +1R'de (105) kapanır, stop girişe (100) çekilir; sonra 100'e düşer -> toplam 0.5R
    r, days, px, how = assistant_track.run_exit(o, h, l, c, 0, 100.0, 95.0, None, 20, 2.0, None, 1.0, 1.0)
    assert how == "stop" and px == 100.0 and r == pytest.approx(0.5)


# ------------------------------------------------------------------ fiyat verisi doğrulama

def _px(sym, rows, start="2026-01-05"):
    return bars(rows, start).assign(yf_symbol=sym)


def test_split_and_reverse_split_adjusted():
    split = _px("SPL.IS", [(100, 101, 99, 100), (50, 51, 49, 50), (50, 52, 49, 51)])        # 2'ye bölünme
    rev = _px("REV.IS", [(10, 10.5, 9.5, 10), (100, 101, 99, 100), (100, 102, 99, 101)])  # 10'u 1'e birleşme
    us = _px("USX", [(100, 101, 99, 100), (50, 51, 49, 50)])                               # ABD'ye dokunulmaz
    out = prices.fix_bist_splits(pd.concat([split, rev, us], ignore_index=True)).sort_values(["yf_symbol", "date"])
    c = out.groupby("yf_symbol")["close"].apply(list)
    assert c["SPL.IS"] == pytest.approx([50, 50, 51])
    assert c["REV.IS"] == pytest.approx([100, 100, 101])
    assert c["USX"] == pytest.approx([100, 50])


def test_normal_limit_moves_not_adjusted():
    s = _px("LIM.IS", [(100, 101, 99, 100), (110, 110, 110, 110), (99, 100, 98, 99)])  # tavan ve taban
    out = prices.fix_bist_splits(s)
    assert out["close"].tolist() == pytest.approx([100, 110, 99])


def test_missing_latest_finds_stale_symbols():
    df = pd.concat([_px("A.IS", [(1, 1, 1, 1)] * 5), _px("B.IS", [(1, 1, 1, 1)] * 4), _px("X", [(1, 1, 1, 1)] * 3),
                    _px("Y", [(1, 1, 1, 1)] * 3), _px("USDTRY=X", [(1, 1, 1, 1)] * 2)], ignore_index=True)
    assert prices.missing_latest(df, ["A.IS", "B.IS", "X", "Y", "USDTRY=X"]) == ["B.IS"]


# ------------------------------------------------------------------ sanal portföy

def _signal(day, **kw):
    s = {"date": pd.Timestamp(day), "symbol": "AAA", "yf": "AAA.IS", "entry_low": 99.0, "entry_high": 101.0, "stop": 95.0,
         "target1": 110.0, "atr": 2.0, "exit_rule": None, "risk_scale": 1.0}
    return pd.DataFrame([{**s, **kw}])


def _market(rows):
    idx = _px("XU100.IS", [(1000, 1000, 1000, 1000)] * len(rows))
    stock = _px("AAA.IS", rows).assign(volume=1e8)  # likidite sınırı devreye girmesin
    return pd.concat([idx, stock], ignore_index=True)


def test_paper_trade_with_costs():
    px = _market([(100, 100, 100, 100)] * 25 + [(100, 101, 99, 100), (104, 111, 103, 110), (110, 110, 110, 110)])
    rep = paper.simulate(_signal("2026-02-06"), px, "BIST")  # 25. gün (sinyal) sonrası alım
    assert rep["trades"] == 1
    t = rep["closed"][0]
    assert t["how"] == "target" and t["r"] == pytest.approx(2.0)
    shares = 100_000 * paper.RISK_PCT / 5  # risk 1.000 ₺ / hisse başı 5 ₺ risk = 200 lot
    expected = shares * (110 * (1 - paper.COST["BIST"]) - 100 * (1 + paper.COST["BIST"]))
    assert t["pnl"] == pytest.approx(expected, abs=0.01)


def test_paper_no_buy_at_limit_up_open():
    px = _market([(100, 100, 100, 100)] * 25 + [(100, 100, 100, 100), (110, 110, 100.5, 110)] + [(113, 114, 112, 113)] * 6)
    rep = paper.simulate(_signal("2026-02-09", entry_low=100.0, entry_high=111.0), px, "BIST")
    assert rep["trades"] == 0 and rep["open_count"] == 0


# ------------------------------------------------------------------ KAP ve sektörler

@pytest.mark.parametrize("subject,summary,expected", [
    ("Sermaye Artırımı - Bedelsiz", "Yönetim kurulu bedelsiz sermaye artırımı kararı aldı", "bedelsiz_karar"),
    ("SPK Bülteni", "Bedelsiz sermaye artırımı SPK tarafından onaylandı", "bedelsiz_onay"),
    ("Pay Geri Alım Programı", "Geri alım programı başlatılmasına karar verildi", "geri_alim_program"),
    ("Kar Payı Dağıtım İşlemlerine İlişkin Bildirim", "", "temettu"),
    ("Yeni İş İlişkisi", "Sözleşme imzalandı", "yeni_is"),
    ("Özel Durum Açıklaması (Genel)", "Genel kurul toplantısı yapıldı", None),
])
def test_kap_classify(subject, summary, expected):
    assert kap_events.classify(subject, summary) == expected


@pytest.mark.parametrize("sector,expected", [
    ("Bankacılık", "banka"), ("Gayrimenkul Yatırım Ortaklıkları", "gyo"), ("Elektrik Gaz ve Buhar", "enerji"),
    ("İletişim", "iletisim"), ("Demir, Çelik Temel", "metal"), (None, None), ("Bilinmeyen", None),
])
def test_agenda_sector(sector, expected):
    assert sectors.agenda_sector(sector) == expected


# ------------------------------------------------------------------ sistem sağlığı

def _scan(dates_bist, dates_us):
    rows = [{"market": "BIST", "symbol": f"B{i}", "yf_symbol": f"B{i}.IS", "date": d, "avg_turnover": 1.0}
            for i, d in enumerate(dates_bist)]
    rows += [{"market": "US", "symbol": f"U{i}", "yf_symbol": f"U{i}", "date": d, "avg_turnover": 1.0}
             for i, d in enumerate(dates_us)]
    return pd.DataFrame(rows)


def test_health_blocks_market_with_missing_data():
    from datetime import date
    scan = _scan(["2026-11-13"] * 7 + ["2026-11-12"] * 3, ["2026-11-13"] * 10)
    px = _px("B0.IS", [(1, 1, 1, 1)] * 3)
    checks = {c["id"]: c for c in health.data_checks(scan, px, date(2026, 11, 16))}
    assert checks["fresh_BIST"]["status"] == "error"     # %70 < %80
    assert checks["fresh_US"]["status"] == "ok"
    assert checks["age_US"]["status"] == "ok"           # cuma -> pazartesi: 1 iş günü


def test_health_flags_bist_jump():
    from datetime import date
    scan = _scan(["2026-01-07"], ["2026-01-07"])
    px = _px("JMP.IS", [(10, 10, 10, 10), (10, 10, 10, 10), (15, 15, 15, 15)])
    checks = {c["id"]: c for c in health.data_checks(scan, px, date(2026, 1, 8))}
    assert checks["jumps"]["status"] == "warn" and "JMP" in checks["jumps"]["detail"]


def test_universe_shrink_warns(tmp_path, monkeypatch):
    from datetime import date
    monkeypatch.setattr(health, "HISTORY_FILE", tmp_path / "h.json")
    full = _scan(["2026-11-13"] * 100, ["2026-11-13"] * 100)
    for day in (10, 11, 12):
        health.universe_checks(full, date(2026, 11, day))
    small = _scan(["2026-11-13"] * 60, ["2026-11-13"] * 100)
    checks = {c["id"]: c for c in health.universe_checks(small, date(2026, 11, 13))}
    assert checks["universe_BIST"]["status"] == "warn" and checks["universe_US"]["status"] == "ok"


def test_drift_alarm():
    exits_rep = {"selected": {"BIST": {"avg_r": 0.3, "std_r": 1.2}, "US": {"avg_r": 0.2}}}
    score = {"BIST": {"closed_rs": [-1.0] * 12 + [0.5] * 8}, "US": {"closed_rs": [0.4] * 5}}
    d = health.drift(score, exits_rep)
    assert d["BIST"]["status"] == "alarm" and d["BIST"]["z"] < -2
    assert d["US"]["status"] == "insufficient"
    good = health.drift({"BIST": {"closed_rs": [0.3, -1, 2, 0.5, -1, 1.5] * 4}}, exits_rep)
    assert good["BIST"]["status"] == "ok"


# ------------------------------------------------------------------ değişiklik günlüğü

def test_changelog_detects_rule_and_model_changes(tmp_path, monkeypatch):
    from scanner import changelog
    monkeypatch.setattr(changelog, "AUTO_FILE", tmp_path / "auto.json")
    monkeypatch.setattr(changelog, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(changelog, "MANUAL_FILE", tmp_path / "manual.json")
    (tmp_path / "manual.json").write_text('[{"date": "2026-11-01", "kind": "feature", "title": "A", "detail": "a"}]',
                                          encoding="utf-8")
    sel = lambda name, desc: {"selected": {"BIST": {"name": name, "desc": desc, "avg_r": 0.3, "base_avg_r": 0.1}}}  # noqa: E731
    first = changelog.update({"reliable": False, "spec_text": "x"}, sel("base", "Plan"), "2026-11-10")
    assert [e["title"] for e in first] == ["A"]  # ilk çalıştırma: karşılaştıracak durum yok
    same = changelog.update({"reliable": False, "spec_text": "x"}, sel("base", "Plan"), "2026-11-11")
    assert len(same) == 1
    out = changelog.update({"reliable": True, "spec_text": "x", "last_decision": "model testte daha iyi"},
                           sel("trail3", "İz süren stop"), "2026-11-14")
    titles = [e["title"] for e in out]
    assert titles[:2] == ["BIST çıkış kuralı değişti", "Öğrenen model sıralamayı devraldı"] and titles[-1] == "A"
    assert "Önce: Plan. Şimdi: İz süren stop." in out[0]["detail"] and out[0]["auto"] and out[0]["kind_name"] == "Kural"


def test_paper_idle_cash_in_index():
    # Giriş bölgesine hiç gelmeyen sinyal: hisse alınmaz; endeks her gün %1 yükselir
    n = 40
    idx = bars([(1000 * 1.01 ** i, 1000 * 1.01 ** i, 1000 * 1.01 ** i, 1000 * 1.01 ** i) for i in range(n)]).assign(yf_symbol="XU100.IS")
    stock = _px("AAA.IS", [(120, 121, 119, 120)] * n).assign(volume=1e8)
    px = pd.concat([idx, stock], ignore_index=True)
    sig = _signal("2026-01-06")
    cash = paper.simulate(sig, px, "BIST")
    inv = paper.simulate(sig, px, "BIST", idle="index")
    assert cash["equity"] == pytest.approx(100_000)  # boştaki nakit getirisiz
    assert inv["equity"] > 100_000 * 1.2  # haftalık olarak endekse yatırılan %90 yükselişten pay alır
    assert inv["exposure_pct"] == pytest.approx(0)  # hisse payı yok (endeks hisse sayılmaz)


# ------------------------------------------------------------------ model yarışı

def _weeks(diffs_by_year: dict, base: float = 0.5, n_per_year: int = 20):
    rows = []
    for y, diff in diffs_by_year.items():
        for i in range(n_per_year):
            noise = 0.3 if i % 2 else -0.3
            rows.append({"date": pd.Timestamp(f"{y}-01-01") + pd.Timedelta(weeks=i), "top_r": base + diff + noise,
                         "rule_r": base, "all_r": base - 0.05, "top_hit": 0.5, "rule_hit": 0.4, "all_hit": 0.4})
    return pd.DataFrame(rows)


def test_research_gate_passes_consistent_edge():
    from scanner import research
    j = research.judge(_weeks({2020: 0.15, 2021: 0.2, 2022: 0.1, 2023: 0.15}), 0.05)
    assert j["passed"] and j["edge"] == pytest.approx(0.15, abs=1e-3) and j["years_positive"] == 1.0


def test_research_gate_rejects_single_year_luck():
    from scanner import research
    j = research.judge(_weeks({2020: -0.05, 2021: 0.9, 2022: -0.05, 2023: -0.04}), 0.05)
    assert not j["passed"] and any("en iyi yıl" in w for w in j["why_not"])


def test_sector_frame():
    from scanner import research
    d = pd.bdate_range("2025-01-01", periods=80)
    rows = []
    for s, slope in (("A.IS", 1.01), ("B.IS", 1.0), ("C.IS", 1.005), ("D.IS", 0.99), ("E.IS", 0.995), ("F.IS", 0.992)):
        rows += [{"date": x, "yf_symbol": s, "close": 100 * slope ** i} for i, x in enumerate(d)]
    f = research.sector_frame(pd.DataFrame(rows), {"A.IS": "tek", "B.IS": "tek", "C.IS": "tek",
                                                   "D.IS": "iki", "E.IS": "iki", "F.IS": "iki"})
    last = f.xs(d[-1], level="date")
    assert last.loc["A.IS", "sec_rank_1m"] == 1.0 and last.loc["D.IS", "sec_rank_1m"] == 0.5  # yükselen sektör önde
    assert last.loc["A.IS", "sec_rel_1m"] > 0 > last.loc["B.IS", "sec_rel_1m"]  # sektör medyanına göre (C medyan)
    assert last.loc["A.IS", "sec_breadth50"] > last.loc["D.IS", "sec_breadth50"]


def test_static_json_files_valid():
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    log = json.loads((root / "changelog.json").read_text(encoding="utf-8"))
    assert all({"date", "kind", "title", "detail"} <= set(e) for e in log)
    road = json.loads((root / "roadmap.json").read_text(encoding="utf-8"))
    assert all(i["status"] in {"done", "active", "next", "planned", "dropped"} for p in road["phases"] for i in p["items"])


def test_paper_drawdown_brake_halves_next_position():
    flat = [(100, 100, 100, 100)] * 25
    rows = flat + [(100, 101, 99, 100), (96, 96, 94, 95)] + [(100, 100, 100, 100)] * 3 + [(100, 101, 99, 100), (104, 111, 103, 110)]
    px = _market(rows)
    days = pd.bdate_range("2026-01-05", periods=len(rows))
    sig = pd.concat([_signal(days[24]), _signal(days[29])], ignore_index=True)  # ikinci sinyal ilk işlem kapandıktan sonra
    plain = paper.simulate(sig, px, "BIST")
    braked = paper.simulate(sig, px, "BIST", brake={"kind": "form", "n": 1, "scale": 0.5})
    win_plain = next(t for t in plain["closed"] if t["how"] == "target")
    win_braked = next(t for t in braked["closed"] if t["how"] == "target")
    assert plain["trades"] == braked["trades"] == 2 and braked["brake_buys"] == 1
    assert win_braked["pnl"] == pytest.approx(win_plain["pnl"] / 2, rel=0.03)
    dd = paper.simulate(sig, px, "BIST", brake={"kind": "dd", "level": -0.005, "scale": 0.5})
    assert dd["brake_buys"] == 1
