"""Asistan: günün alım adayları ve her aday için işlem planı.

Teknik skor, göreli güç, haber akışı, bilanço takvimi ve piyasa rejimi birlikte süzülür; kalan az sayıdaki hisse için
giriş bölgesi, stop, hedefler ve "plan ne zaman geçersiz" koşulu çıkarılır. Yorum metni kural tabanlıdır; bulut
bekçisi (Cloudflare Worker) bunun üstüne yapay zekâ ile yazılmış bir paragraf ekler.

Yatırım tavsiyesi değildir: adaylar "koşullu alım adayı"dır, sonuç asistan karnesinde (assistant_track.py) ölçülür.
"""
import json

import numpy as np
import pandas as pd

from . import events, levels, views
from .patterns import PIVOT_K, Pivots
from .prices import to_weekly
from .signals import DAILY, WEEKLY, prepare, score_at

# Süzgeç eşikleri
MIN_SCORE = 30            # birleşik teknik skor (-100..100)
MIN_RS = 70               # göreli güç (1-99)
MAX_RSI = 78              # daha yukarısı "kovalama"
MAX_EXT_ATR = 3.0         # fiyat 20 günlük ortalamadan bu kadar ATR'den uzaksa giriş geç kalmış sayılır
MIN_NEWS_SCORE = -15      # haber skoru (-100..100)
EARNINGS_BLACKOUT = 5     # bu kadar gün içinde bilanço varsa aday olmaz (sonucu yazı-tura)
MIN_RR = 1.5              # ilk hedefe göre ödül/risk
MIN_ATR_PCT = 1.0         # günlük ortalama oynaklık bundan azsa (ör. birleşme teklifi) aday olmaz
MAX_RISK_PCT = 12         # girişten stopa en fazla %12
# Piyasa rejimine göre en fazla aday ve önerilen pozisyon çarpanı
REGIME_LIMITS = {
    "Boğa": (8, 1.0), "Temkinli boğa": (7, 1.0), "Nötr": (5, 0.75), "Zayıf": (4, 0.5), "Ayı": (3, 0.5),
}
BEAR_MIN_RS = 85          # zayıf/ayı piyasada sadece en güçlüler
MIN_EXP_R = 0.05          # öğrenen model güvenilirse: beklenen getirisi bundan düşük aday listeye girmez
FORM_WEEKS_TEXT = "8 haftada"

RADAR_N = 6
RADAR_FIELDS = ("symbol", "market", "name", "close", "change_pct", "rs_rating", "setup", "setup_text", "entry_low",
                "entry_high", "stop", "target1", "rr", "risk_pct", "quality", "model")

SETUPS = {
    "breakout": "Kırılım",
    "pullback": "Geri çekilmede alım",
    "trend": "Trend devamı",
}


def _fmt(v: float) -> str:
    digits = 0 if abs(v) >= 1000 else 2 if abs(v) >= 10 else 3
    return f"{v:,.{digits}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _pct(v: float, digits: int = 1) -> str:
    return f"%{abs(v):.{digits}f}".replace(".", ",")


def _round(v: float) -> float:
    return round(float(v), 4 if v < 10 else 2)


def prefilter(g: pd.DataFrame) -> pd.DataFrame:
    """Planı hesaplanacak hisseler (ucuz sütun kontrolleri)."""
    m = (
        (g["combined_score"] >= MIN_SCORE)
        & (g["daily_score"] > 0)
        & (g["weekly_score"].fillna(1) > 0)
        & (g["rs_rating"].fillna(0) >= MIN_RS)
        & (g["rsi"] <= MAX_RSI)
        & (g["news_score"].fillna(0) >= MIN_NEWS_SCORE)
        & (g["news_risk"] != "Yüksek")
        & (g["overall_risk"] != "Yüksek")
        & (g["alerts"].fillna("[]") == "[]")  # aşırı devre kesici, ciddi haber gibi uyarılar
    )
    return g[m]


def plan_at(d_full: pd.DataFrame, piv_full: Pivots, t: int) -> dict | None:
    """t. günün kapanışında giriş bölgesi, stop ve hedefler (sadece t ve öncesi kullanılır; geçmişte yeniden oynatılabilir).
    d_full: signals.prepare(günlük, DAILY) çıktısı (ema_fast=EMA20, ema_mid=EMA50, atr).
    Uygun plan çıkmazsa None (ör. stop çok uzak, ödül/risk düşük)."""
    d = d_full.iloc[:t + 1]
    last = d.iloc[-1]
    close, a = float(last["close"]), float(last["atr"])
    if not np.isfinite(a) or a < MIN_ATR_PCT / 100 * close:
        return None  # hiç oynamayan hisse (ör. satın alma teklifi altında): plan anlamsız
    ema20, ema50 = float(last["ema_fast"]), float(last["ema_mid"])
    ext = (close - ema20) / a
    if ext > MAX_EXT_ATR:
        return None
    cutoff = t - PIVOT_K  # pivot onayı için sağda PIVOT_K mum gerekir
    piv = Pivots(piv_full.highs[piv_full.highs <= cutoff], piv_full.lows[piv_full.lows <= cutoff])
    lv = levels.price_levels(d, piv, a, views.LEVELS_DAILY_LOOKBACK)
    sups = [s["price"] for s in lv["supports"]]
    ress = [s["price"] for s in lv["resistances"]]
    hi20 = float(d["high"].iloc[-21:-1].max())  # bugünden önceki 20 günün zirvesi
    high_52w = float(d["high"].iloc[-DAILY.year_bars:].max())

    # Kurulum tipi
    if close > hi20 and close - hi20 <= 1.5 * a:
        setup, base = "breakout", hi20                  # kırılan seviye artık destek
    elif 0 <= ext <= 1.0 or (sups and close - sups[0] <= 1.0 * a):
        # dayanak: fiyatın altındaki en yakın ortalama ya da destek
        floors = [x for x in (ema20, ema50, sups[0] if sups else None) if x is not None and x <= close]
        setup, base = "pullback", max(floors) if floors else close - a
    else:
        setup, base = "trend", ema20

    # Giriş bölgesi: kovalamamak için en fazla bugünkü kapanışın biraz üstü
    entry_high = close + 0.25 * a
    entry_low = max(min(base, close - 0.5 * a), close - 1.5 * a)
    entry = (entry_low + entry_high) / 2

    # Stop: giriş bölgesinin altındaki ilk destek - yarım ATR; en az 1 ATR, en çok 3 ATR uzakta
    below = [s for s in sups if s < entry_low]
    stop = (below[0] - 0.5 * a) if below else entry_low - 1.5 * a
    stop = min(stop, entry_low - 1.0 * a)
    stop = max(stop, entry - 3.0 * a)
    risk = entry - stop
    risk_pct = risk / entry * 100
    if risk <= 0 or risk_pct > MAX_RISK_PCT:
        return None

    # Hedefler: girişin en az 1 ATR üstündeki dirençler; yoksa (zirvede) risk katları
    above = [x for x in ress if x >= entry_high + a]
    if high_52w >= entry_high + a and all(abs(high_52w - x) > 0.5 * a for x in above):
        above = sorted(above + [high_52w])
    if above and (above[0] - entry) / risk < MIN_RR:
        # İlk direnç çok yakın: arkasında yeterince uzak ikinci bir direnç yoksa plan yok
        if len(above) > 1 and (above[1] - entry) / risk >= MIN_RR + 0.5:
            above = above[1:]
        else:
            return None
    target1 = above[0] if above else entry + 2 * risk
    target2 = above[1] if len(above) > 1 and above[1] >= target1 + 0.5 * a else max(target1 + risk, entry + 3 * risk)
    rr = (target1 - entry) / risk
    return {
        "setup": setup,
        "entry_low": _round(entry_low), "entry_high": _round(entry_high),
        "stop": _round(stop), "target1": _round(target1), "target2": _round(target2),
        "rr": round(rr, 2), "risk_pct": round(risk_pct, 2),
        "atr": _round(a), "ema20": _round(ema20), "ema50": _round(ema50), "ext_atr": round(ext, 2),
        "base": _round(base),
        "projected": not above,  # üstte direnç yok (zirvede): hedefler risk katlarıyla hesaplandı
    }


def _checks(r: pd.Series, plan: dict, sector: dict | None, regime: dict, ev: dict | None) -> list[dict]:
    """Adayın lehine/aleyhine maddeler (uygulamada ✓ / ! olarak görünür)."""
    out = []
    ws = r.get("weekly_score")
    out.append({"label": "Trend", "ok": bool(ws is not None and pd.notna(ws) and ws > 0),
                "text": f"Günlük ve haftalık grafik yükseliş yönünde (skor {r['combined_score']:+.0f})"
                if ws is not None and pd.notna(ws) and ws > 0 else "Haftalık grafik henüz onaylamıyor"})
    rs = int(r["rs_rating"])
    out.append({"label": "Göreli güç", "ok": rs >= 80,
                "text": f"Hisselerin %{rs} kadarından güçlü" + (f"; 3 ayda endeksten {_pct(r['rs_3m'])} iyi"
                                                             if pd.notna(r.get("rs_3m")) and r["rs_3m"] > 0 else "")})
    pos, neg = (int(v) if pd.notna(v) else 0 for v in (r.get("news_positive"), r.get("news_negative")))
    ns = r.get("news_score")
    news_ok = ns is not None and pd.notna(ns) and ns > 5 and r.get("news_risk") == "Düşük"
    out.append({"label": "Haberler", "ok": news_ok,
                "text": (f"Haber akışı olumlu ({pos} olumlu, {neg} olumsuz)" if news_ok
                         else f"Olumsuz başlıklar daha fazla ({pos} olumlu, {neg} olumsuz)" if neg > pos
                         else f"Haber akışı nötr ya da karışık ({pos} olumlu, {neg} olumsuz)" if pos + neg
                         else "Kayda değer haber yok")})
    if sector:
        top = sector["rank"] <= max(3, sector["of"] // 3)
        out.append({"label": "Sektör", "ok": top,
                    "text": f"{sector['sector']}: {sector['of']} sektör içinde {sector['rank']}. sırada"})
    out.append({"label": "Piyasa", "ok": regime["score"] >= 1,
                "text": f"Piyasa rejimi: {regime['label']}"})
    out.append({"label": "Ödül/risk", "ok": plan["rr"] >= 2,
                "text": f"İlk hedefe göre {plan['rr']:.1f} kat ödül, stop {_pct(plan['risk_pct'])} uzakta"
                .replace(".", ",", 1)})
    n = events.days_until(ev)
    if ev and ev["status"] != "reported" and n is not None and 0 <= n <= 21:
        out.append({"label": "Bilanço", "ok": False,
                    "text": f"Bilanço {n} gün sonra{' (tahmini)' if ev['status'] == 'estimated' else ''}; "
                            "açıklama günü sert hareket olabilir"})
    return out


def _r(v: float) -> str:
    return f"{v:+.2f}R".replace(".", ",")


def _model_check(m: dict) -> dict:
    """Öğrenen modelin tahmini, adayın maddelerinden biri olarak."""
    text = f"İlk hedefe stoptan önce ulaşma olasılığı %{m['p'] * 100:.0f}"
    if m["exp_r"] is not None:
        text += f", beklenen getiri {_r(m['exp_r'])}"
    sim = m.get("similar")
    if sim:
        text += f". Geçmişte benzer {sim['n']} kurulumda hedefe ulaşma %{sim['win']:.0f}, ortalama {_r(sim['avg_r'])}"
    ok = m["exp_r"] > MIN_EXP_R if m["exp_r"] is not None else bool(sim and sim["avg_r"] > 0)
    return {"label": "Geçmiş veri", "ok": ok, "text": text}


def _quality(r: pd.Series, plan: dict, checks: list[dict]) -> float:
    """Sıralama puanı (0-100 civarı): teknik skor, göreli güç, ödül/risk ve olumlu maddeler."""
    q = 0.35 * float(r["combined_score"]) + 0.35 * float(r["rs_rating"])
    q += 6 * min(plan["rr"], 3) + 3 * sum(c["ok"] for c in checks)
    q -= 1.5 * max(plan["ext_atr"] - 1.5, 0) * 4  # ortalamadan uzaksa hafif ceza
    pos, neg = (int(v) if pd.notna(v) else 0 for v in (r.get("news_positive"), r.get("news_negative")))
    q -= min(2 * max(neg - pos, 0), 10)  # olumsuz başlıklar ağır basıyorsa ceza
    return round(q, 1)


def _top_news(r: pd.Series) -> list[dict]:
    items = json.loads(r["top_news"]) if isinstance(r.get("top_news"), str) else []
    return [{k: n.get(k) for k in ("title", "url", "source", "sentiment", "date")} for n in items[:3]]


def commentary(c: dict, regime: dict) -> str:
    """Kural tabanlı yorum paragrafı (yapay zekâ yorumu gelmezse ya da yerel modda gösterilir)."""
    p = []
    rs = c["rs_rating"]
    lead = {
        "breakout": f"{c['symbol']} son 20 günün zirvesi olan {_fmt(c['base'])} seviyesini yukarı kırdı",
        "pullback": f"{c['symbol']} yükseliş trendi içinde {_fmt(c['base'])} civarındaki desteğe geri çekildi",
        "trend": f"{c['symbol']} yükseliş trendini sürdürüyor",
    }[c["setup"]]
    p.append(f"{lead}; göreli gücü {rs}/99 ile piyasanın büyük kısmından güçlü.")
    news = next((x for x in c["checks"] if x["label"] == "Haberler"), None)
    if news:
        p.append(news["text"] + ".")
    p.append(f"Plan: {_fmt(c['entry_low'])}–{_fmt(c['entry_high'])} aralığında alım, günlük kapanış "
             f"{_fmt(c['stop'])} altına inerse çıkış (risk {_pct(c['risk_pct'])}); ilk hedef {_fmt(c['target1'])}, "
             f"ikinci hedef {_fmt(c['target2'])}.")
    if c["projected"]:
        p.append("Fiyat zirve bölgesinde ve üstte direnç yok; hedefler stop mesafesinin katları olarak hesaplandı.")
    ev = next((x for x in c["checks"] if x["label"] == "Bilanço"), None)
    if ev:
        p.append(ev["text"] + "; pozisyonu küçük tutmak düşünülebilir.")
    if regime["score"] < 1:
        p.append(f"Piyasa rejimi {regime['label'].lower()}: bu ortamda yükseliş sinyalleri daha sık başarısız olur.")
    m = c.get("model")
    if m:
        extra = f" (beklenen getiri {_r(m['exp_r'])})" if m["exp_r"] is not None else ""
        p.append(f"Geçmiş veride eğitilen modele göre ilk hedefe stoptan önce ulaşma olasılığı %{m['p'] * 100:.0f}{extra}.")
    return " ".join(p)


def form_note(form: dict) -> str:
    return (f"Asistanın planları son {FORM_WEEKS_TEXT} ortalama {_r(form['recent_r'])} ile "
            f"{'kazandırdı' if form['recent_r'] > 0 else 'zarar ettirdi'} ({form['recent_n']} kurulum, geçmiş veride).")


def stance(regime: dict, n: int, market: str, model_rejected: int = 0, form: dict | None = None) -> str:
    """Piyasa geneli için tek cümlelik duruş."""
    if form and form["recent_r"] <= 0:
        t = form["test"]
        if form["effective"]:
            return (f"Temkin modu: {form_note(form)} 10 yıllık testte form kötüyken sonraki hafta ortalama "
                    f"{_r(t['bad_next_r'])}, iyiyken {_r(t['good_next_r'])} oldu; bu yüzden liste kısaltıldı ve önerilen "
                    "pozisyon yarıya indirildi. " + _stance(regime, n, market, model_rejected))
        return (f"{form_note(form)} Ancak bu piyasada 10 yıllık testte form, sonraki haftalar için belirgin bir işaret "
                f"olmadı (form kötüyken {_r(t['bad_next_r'])}, iyiyken {_r(t['good_next_r'])}); liste bu yüzden "
                "kısaltılmadı. " + _stance(regime, n, market, model_rejected))
    return _stance(regime, n, market, model_rejected)


def _stance(regime: dict, n: int, market: str, model_rejected: int = 0) -> str:
    label = regime["label"]
    if n == 0 and model_rejected:
        return (f"Piyasa rejimi {label.lower()}. Süzgeçten geçen {model_rejected} hissenin planı var ama öğrenen model "
                "hiçbirinde yeterli beklenen getiri görmüyor (geçmişte benzer kurulumlar ortalamada kazandırmamış). "
                "Bugün yeni alım için aday yok; nakitte beklemek de bir tercihtir.")
    if n == 0:
        return (f"Piyasa rejimi {label.lower()} ve süzgeçten geçen hisse yok. Bugün yeni alım için uygun aday "
                "görünmüyor; nakitte beklemek de bir tercihtir.")
    base = {
        "Boğa": "Piyasa ortamı yükseliş sinyalleri için elverişli.",
        "Temkinli boğa": "Genel eğilim olumlu ama seçici olmak gerekiyor.",
        "Nötr": "Piyasada belirgin yön yok; adaylarda pozisyonu küçük tutmak ve stoplara uymak önemli.",
        "Zayıf": "Hisselerin çoğu düşüşte; sadece en güçlü hisseler listelendi, pozisyonu yarıya indirmek mantıklı olabilir.",
        "Ayı": "Piyasa düşüş trendinde; aşağıdakiler sadece en güçlü istisnalar. Pozisyonu yarıya indirmek ve stoplara sıkı uymak gerekir.",
    }[label]
    rel = " ABD'de teknik skorun geçmiş başarısı düşük; adayları ek araştırmayla değerlendirin." if market == "US" else ""
    return base + rel


def candidates(scan: pd.DataFrame, prices: pd.DataFrame, overview: dict, side: "views.SideData") -> dict:
    """Piyasa başına günün adayları. scan: SideData ile zenginleştirilmiş tarama."""
    from . import learn  # learn bu modülü kullanıyor (döngüsel içe aktarma olmasın)
    scorer = learn.Scorer(prices, scan)
    out: dict[str, dict] = {}
    for market, g in scan.groupby("market"):
        mk = overview.get(market)
        if not mk:
            continue
        regime = {k: mk["regime"][k] for k in ("label", "score", "summary")}
        limit, scale = REGIME_LIMITS[regime["label"]]
        # Strateji formu: planlar son haftalarda zarar ettirdiyse liste kısalır, pozisyon küçülür
        form = scorer.form(market)
        if form and form["recent_r"] <= 0 and form["effective"]:
            limit, scale = min(limit, learn.FORM_LIMIT), scale * learn.FORM_SCALE
        pre = prefilter(g)
        pre = pre[[events.days_until(side.events.get(f"{market}:{s}")) is None
                   or not (0 <= events.days_until(side.events.get(f"{market}:{s}")) <= EARNINGS_BLACKOUT)
                   or side.events[f"{market}:{s}"]["status"] == "reported" for s in pre["symbol"]]]
        px = prices[prices["yf_symbol"].isin(pre["yf_symbol"])]
        by = dict(tuple(px.groupby("yf_symbol")))
        rows = []
        for _, r in pre.iterrows():
            daily = by.get(r["yf_symbol"])
            if daily is None or len(daily) < 60:
                continue
            daily = daily.sort_values("date").reset_index(drop=True)
            d, piv = prepare(daily, DAILY)
            t = len(d) - 1
            plan = plan_at(d, piv, t)
            if plan is None:
                continue
            model = None
            if scorer.active:
                w, pw = prepare(to_weekly(daily).sort_values("date").reset_index(drop=True), WEEKLY)
                model = scorer.predict(d, t, score_at(d, piv, t, DAILY, market),
                                       score_at(w, pw, len(w) - 1, WEEKLY, market), plan, market, r["rs_rating"])
            key = f"{market}:{r['symbol']}"
            ev = side.events.get(key)
            sector = side.sector_info(market, r.get("sector") or None)
            checks = _checks(r, plan, sector, regime, ev)
            if model:
                checks.append(_model_check(model))
            reasons = json.loads(r["daily_reasons"]) if isinstance(r.get("daily_reasons"), str) else []
            c = {
                "symbol": r["symbol"], "market": market, "name": views.display_name(r["name"]),
                "sector": r.get("sector") or None,
                "close": views.clean(r["close"]), "change_pct": views.clean(r["change_pct"]),
                "combined_score": views.clean(r["combined_score"]), "rs_rating": int(r["rs_rating"]),
                "rsi": views.clean(round(float(r["rsi"]), 1)),
                **plan,
                "setup_text": SETUPS[plan["setup"]],
                "checks": checks,
                "reasons": [x for x in reasons if not x.startswith("Trend güçlü")][:5],
                "news": _top_news(r),
                "earnings_date": ev["date"] if ev else None,
                "earnings_status": ev["status"] if ev else None,
                "fundamentals": {k: (side.fund.get(key) or {}).get(k) for k in ("pe", "pb", "market_cap")},
                "model": model,
            }
            c["quality"] = _quality(r, plan, checks)
            rows.append(c)
        min_rs = BEAR_MIN_RS if regime["label"] in ("Zayıf", "Ayı") else MIN_RS
        rejected = 0
        if scorer.reliable:
            # Öğrenen model testten geçtiyse sıralamayı o yapar ve beklenen getirisi düşük adayları eler
            rows.sort(key=lambda c: -c["model"]["exp_r"])
            eligible = [c for c in rows if c["rs_rating"] >= min_rs]
            rejected = sum(c["model"]["exp_r"] <= MIN_EXP_R for c in eligible)
            eligible = [c for c in eligible if c["model"]["exp_r"] > MIN_EXP_R]
        else:
            rows.sort(key=lambda c: -c["quality"])
            eligible = [c for c in rows if c["rs_rating"] >= min_rs]
        picked = eligible[:limit]
        # Yakın takip: planı olan ama bugün seçilmeyenler (zayıf piyasada göreli gücü yetmeyenler ya da sıra dışı kalanlar)
        radar = [c for c in rows if c not in picked][:RADAR_N]
        for c in picked:
            c["commentary"] = commentary(c, regime)
        out[market] = {
            "date": str(g["date"].max()),
            "regime": regime,
            "risk_scale": scale,
            "stance": stance(regime, len(picked), market, rejected, form),
            "form": {k: form[k] for k in ("recent_r", "recent_n", "recent_win", "long_r", "long_n", "effective")}
            if form else None,
            "ranking": "model" if scorer.reliable else "rules",
            "screened": int(len(g)), "passed_filter": int(len(pre)), "with_plan": len(rows),
            "candidates": picked,
            "radar": [{k: c[k] for k in RADAR_FIELDS} for c in radar],
        }
    return out


def build(scan: pd.DataFrame, prices: pd.DataFrame, overview: dict, side: "views.SideData",
          generated_at: pd.Timestamp) -> dict:
    markets = candidates(scan, prices, overview, side)
    # Sürüm: bulut bekçisi yeni liste geldiğini buradan anlar (yapay zekâ yorumu ve bildirim için)
    version = "|".join(f"{m}:{v['date']}:" + ",".join(c["symbol"] for c in v["candidates"])
                       for m, v in sorted(markets.items()))
    return {
        "version": version,
        "generated_at": generated_at.isoformat(),
        "markets": markets,
        "disclaimer": ("Adaylar otomatik süzgeçten geçen \"koşullu alım adayları\"dır, yatırım tavsiyesi değildir. "
                       "Planlar geçmiş fiyat ve haber başlıklarından üretilir; sonucu garanti etmez. "
                       "Karar ve risk size aittir."),
    }
