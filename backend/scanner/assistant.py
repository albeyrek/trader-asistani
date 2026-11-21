"""Asistan: günün alım adayları ve her aday için işlem planı.

Teknik skor, göreli güç, haber akışı, bilanço takvimi ve piyasa rejimi birlikte süzülür; kalan az sayıdaki hisse için
giriş bölgesi, stop, hedefler ve "plan ne zaman geçersiz" koşulu çıkarılır. Yorum metni kural tabanlıdır; bulut
bekçisi (Cloudflare Worker) bunun üstüne yapay zekâ ile yazılmış bir paragraf ekler.

Yatırım tavsiyesi değildir: adaylar "koşullu alım adayı"dır, sonuç asistan karnesinde (assistant_track.py) ölçülür.
"""
import json

import numpy as np
import pandas as pd
import requests

from . import events, levels, views
from .config import HTTP_HEADERS, WORKER_URL
from .sectors import agenda_sector
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
BEAR_MIN_RS = 85          # zayıf/ayı piyasada sadece en güçlüler...
# ...ama yalnızca ABD'de. 2018'den beri sanal portföy testinde (rejim her hafta yeniden hesaplanarak) BIST'te bu filtre
# yılda ~4 puan getiri kaybettirdi ve düşüşü azaltmadı: BIST'te zayıf/ayı piyasadaki kurulumlar ortalamada en iyi R'yi
# verdi (+0,8R; boğada +0,5R). Liste sınırı ve pozisyon çarpanı düşüşü azalttığı için iki piyasada da kalıyor.
# (liste+çarpan+RS85: yıllık %41,5, düşüş %29,4 -> liste+çarpan: %45,5, düşüş %28,2; ABD'de filtre zararsız)
BEAR_MIN_RS_MARKETS = {"US"}
MIN_EXP_R = 0.05          # öğrenen model güvenilirse: beklenen getirisi bundan düşük aday listeye girmez
RANK_MIN_SHARE = 0.8      # şampiyon model adayların en az bu kadarını puanlayabiliyorsa sıralar
FORM_WEEKS_TEXT = "8 haftada"

# Gündem (bulut bekçisi): politik risk "Yüksek" ise BIST'te önerilen pozisyon yarıya iner; liste kısaltılmaz.
# Başlık geçmişi olmadığı için piyasa şokları vekil alınarak test edildi (BIST 100 günde <= -%4 ya da dolar/TL >= +%3;
# sonraki 5 iş günü "yüksek risk"): şoktan sonra açılan işlemler ortalamada +1,06R (normal günler +0,55R). 2018'den
# beri: liste 2'ye + yarım pozisyon yıllık %36,8 / düşüş %25,5; yalnızca yarım pozisyon %40,5 / %24,5 (en iyi
# getiri/düşüş oranı); kural yok %45,5 / %28,2.
RISK_SCALE = 0.5
def _backtest_summary(market: str) -> dict | None:
    """2018'den beri test portföyünün özeti (paper.py); strateji endeksin belirgin gerisindeyse uyarı."""
    from . import paper
    if not paper.BACKTEST_FILE.exists():
        return None
    r = json.loads(paper.BACKTEST_FILE.read_text(encoding="utf-8")).get("markets", {}).get(market)
    if not r or r.get("cagr_pct") is None:
        return None
    lagging = r["cagr_pct"] < r["index_cagr_pct"] - 3
    pct = lambda v: f"%{v:.1f}".replace(".", ",")  # noqa: E731
    note = (f"Uyarı: 2018'den beri test portföyünde bu strateji {('BIST 100' if market == 'BIST' else 'S&P 500')}'ün "
            f"belirgin gerisinde kaldı (yıllık {pct(r['cagr_pct'])}, endeks {pct(r['index_cagr_pct'])}); önerileri bir "
            "sistem olarak takip etmek yerine fikir listesi olarak kullanın."
            + (" Araştırmada risk/getiri açısından en iyisi S&P 500'ü bir endeks fonuyla tutmak çıktı (ayrıntı: "
               "“ABD için strateji” kartı)." if market == "US" else "")) if lagging else None
    return {"cagr_pct": r["cagr_pct"], "index_cagr_pct": r["index_cagr_pct"], "max_dd_pct": r["max_dd_pct"],
            "lagging": lagging, "note": note}


def fetch_agenda() -> dict | None:
    """Bulut bekçisinin gündem özeti (politik risk, sektör etkisi). Ulaşılamazsa None: asistan gündemsiz devam eder."""
    try:
        r = requests.get(f"{WORKER_URL}/api/agenda", headers=HTTP_HEADERS, timeout=20)
        return r.json() if r.ok else None
    except (requests.RequestException, ValueError):
        return None


def _agenda_check(impact: dict) -> dict:
    good = impact["score"] > 0
    return {"label": "Gündem", "ok": good,
            "text": f"Son 24 saatin gündemi {impact['name'].lower()} için {'olumlu' if good else 'olumsuz'}: "
                    + ", ".join(impact["reasons"][:2])}


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
        & (g["date"] == g["date"].max())       # son işlem gününün fiyatı olmayan (eksik veri, işlem durdurma) aday olmaz
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
    rule = c.get("exit_rule")
    if rule and rule.get("trail"):
        p.append(f"Plan: {_fmt(c['entry_low'])}–{_fmt(c['entry_high'])} aralığında alım, günlük kapanış "
                 f"{_fmt(c['stop'])} altına inerse çıkış (risk {_pct(c['risk_pct'])}). Sabit hedef yok: fiyat yükseldikçe "
                 f"stop, en yüksek kapanışın {_fmt(rule['trail'] * c['atr'])} ({rule['trail']:g} ATR) altına çekilir; "
                 f"en çok {rule['hold']} gün. {_fmt(c['target1'])} ilk direnç olarak izlenebilir.")
    else:
        p.append(f"Plan: {_fmt(c['entry_low'])}–{_fmt(c['entry_high'])} aralığında alım, günlük kapanış "
                 f"{_fmt(c['stop'])} altına inerse çıkış (risk {_pct(c['risk_pct'])}); ilk hedef {_fmt(c['target1'])}, "
                 f"ikinci hedef {_fmt(c['target2'])}.")
    if c["projected"] and not (rule and rule.get("trail")):
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
    if market == "BIST" and label in ("Zayıf", "Ayı"):
        # BIST'te göreli güç eşiği yükseltilmiyor (bkz. BEAR_MIN_RS_MARKETS): metin buna göre
        base = ("Hisselerin çoğu düşüşte; liste kısaltıldı ve önerilen pozisyon yarıya indirildi. 2018'den beri testte "
                "BIST'te zayıf piyasadaki kurulumlar ortalamada iyi sonuç verdi ama dalgalanma yüksek: stoplara sıkı uyun.")
    rel = " ABD'de teknik skorun geçmiş başarısı düşük; adayları ek araştırmayla değerlendirin." if market == "US" else ""
    return base + rel


def candidates(scan: pd.DataFrame, prices: pd.DataFrame, overview: dict, side: "views.SideData",
               agenda: dict | None = None, health: dict | None = None) -> dict:
    """Piyasa başına günün adayları. scan: SideData ile zenginleştirilmiş tarama. agenda: fetch_agenda() çıktısı.
    health: sistem sağlığı (health.build): veri sorunu olan piyasada aday verilmez; canlı sonuçlar testten belirgin
    kötüyse (sapma alarmı) liste kısalır, pozisyon yarıya iner."""
    from . import exits, learn  # bu modülü kullanıyorlar (döngüsel içe aktarma olmasın)
    from . import paper as paper_mod
    scorer = learn.Scorer(prices, scan)
    risk = (agenda or {}).get("risk")
    impacts = {s["sector"]: s for s in (agenda or {}).get("sectors", [])}
    out: dict[str, dict] = {}
    for market, g in scan.groupby("market"):
        mk = overview.get(market)
        if not mk:
            continue
        regime = {k: mk["regime"][k] for k in ("label", "score", "summary")}
        # Çıkış kuralı: 10 yıllık testte temel plandan anlamlı iyi olan kural (yoksa temel plan; bkz. exits.py)
        exit_sel = exits.selected_rule(market)
        exit_rule = {k: exit_sel[k] for k in ("name", "target", "hold", "trail", "breakeven", "partial") if k in exit_sel} \
            if exit_sel else None
        exit_note = (f"{exit_sel['desc']}. 10 yıllık testte işlem başına ortalama {_r(exit_sel['avg_r'])} (sabit hedefli "
                     f"plan {_r(exit_sel['base_avg_r'])}); her yıl yalnızca önceki yıllara bakarak seçildiğinde de "
                     f"{_r(exit_sel['oos_r'])} (plan {_r(exit_sel['oos_base_r'])}).") if exit_sel else None
        limit, scale = REGIME_LIMITS[regime["label"]]
        # Strateji formu: planlar son haftalarda zarar ettirdiyse liste kısalır, pozisyon küçülür
        form = scorer.form(market)
        if form and form["recent_r"] <= 0 and form["effective"]:
            limit, scale = min(limit, learn.FORM_LIMIT), scale * learn.FORM_SCALE
        # Politik risk (sadece BIST): yüksekse pozisyon küçülür (liste kısalmaz; bkz. RISK_SCALE)
        high_risk = market == "BIST" and risk and risk.get("level") == "Yüksek"
        if high_risk:
            scale = scale * RISK_SCALE
        # Düşüş freni: asistanın sanal portföyü zirvesinden belirli oranda aşağıdaysa pozisyon küçülür (paper.BRAKE)
        brake = paper_mod.BRAKE.get(market)
        pdd = ((health or {}).get("paper_dd") or {}).get(market)
        braking = bool(brake and pdd is not None and pdd <= brake["level"])
        if braking:
            scale = scale * brake["scale"]
        drift = ((health or {}).get("drift") or {}).get(market) or {}
        drift_alarm = drift.get("status") == "alarm"
        if drift_alarm:
            limit, scale = min(limit, learn.FORM_LIMIT), scale * learn.FORM_SCALE
        data_issue = next((c["detail"] for c in (health or {}).get("checks", [])
                           if c.get("market") == market and c["status"] == "error" and c["id"].startswith(("fresh_", "age_"))),
                          None)
        if data_issue:
            limit = 0
        pre = prefilter(g)
        # Bilanço yaklaşan hisseler çıkarılır. Maske boolean Series olmalı: süzgeçten hiç hisse geçmezse boş liste
        # pre[[]] sütun seçimi olur ve tablo sütunsuz kalır (Kasım 2026'da günlük taramayı bu çökertti).
        keep = pd.Series([events.days_until(side.events.get(f"{market}:{s}")) is None
                          or not (0 <= events.days_until(side.events.get(f"{market}:{s}")) <= EARNINGS_BLACKOUT)
                          or side.events[f"{market}:{s}"]["status"] == "reported" for s in pre["symbol"]],
                         index=pre.index, dtype=bool)
        pre = pre[keep]
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
                                       score_at(w, pw, len(w) - 1, WEEKLY, market), plan, market, r["rs_rating"],
                                       r["yf_symbol"])
            key = f"{market}:{r['symbol']}"
            ev = side.events.get(key)
            sector = side.sector_info(market, r.get("sector") or None)
            checks = _checks(r, plan, sector, regime, ev)
            if model:
                checks.append(_model_check(model))
            impact = impacts.get(agenda_sector(r.get("sector"))) if market == "BIST" else None
            if impact:
                checks.append(_agenda_check(impact))
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
            if exit_rule:
                c["exit_rule"] = exit_rule
                c["exit_note"] = exit_note
            c["quality"] = _quality(r, plan, checks)
            rows.append(c)
        min_rs = BEAR_MIN_RS if regime["label"] in ("Zayıf", "Ayı") and market in BEAR_MIN_RS_MARKETS else MIN_RS
        rejected = 0
        champion = scorer.champion_name(market)
        n_ranked = sum(1 for c in rows if (c.get("model") or {}).get("rank") is not None)
        # Şampiyon, adayların çoğunu puanlayabiliyorsa sıralar (haftalık verisi yetersiz birkaç hisse yüzünden bütün
        # sıralamayı kurallara bırakmak yanlıştı: 20 Kasım'da şampiyonun ortalamanın altında gördüğü hisseler listeye
        # girdi). Puanı olmayanlar sona kalır.
        by_champion = bool(champion and rows and n_ranked >= RANK_MIN_SHARE * len(rows))
        if by_champion:
            # Sıralama yetkisi yalnızca model yarışının şampiyonunda (piyasaya özel, çıkış kuralının R'siyle sıkı testi
            # geçti: t >= 2,5, yılların çoğunda iyi, tek yıla dayanmıyor). Ortak eski model (learn.train) daha gevşek
            # testini geçse bile sıralamaz ve aday elemez; yalnızca kazanma olasılığını gösterir.
            def champ_key(c: dict) -> tuple:
                r = (c.get("model") or {}).get("rank")
                return (r is None, -(r if r is not None else 0.0), -c["quality"])
            rows.sort(key=champ_key)
            eligible = [c for c in rows if c["rs_rating"] >= min_rs]
        else:
            rows.sort(key=lambda c: -c["quality"])
            eligible = [c for c in rows if c["rs_rating"] >= min_rs]
        picked = eligible[:limit]
        # Yakın takip: planı olan ama bugün seçilmeyenler (zayıf piyasada göreli gücü yetmeyenler ya da sıra dışı kalanlar)
        radar = [c for c in rows if c not in picked][:RADAR_N]
        for c in picked:
            c["commentary"] = commentary(c, regime)
        backtest = _backtest_summary(market)
        out[market] = {
            "date": str(g["date"].max()),
            "regime": regime,
            "risk_scale": scale,
            "stance": (f"Veri sorunu: {data_issue}. Yanlış veriyle plan üretmemek için bugün aday verilmiyor. "
                       if data_issue else "")
                      + (f"Düşüş freni: asistanın sanal portföyü zirvesinden %{-pdd * 100:.0f} aşağıda; önerilen pozisyon "
                         "yarıya indirildi (2018'den beri testte en büyük düşüşü %46'dan %38'e indirdi). " if braking else "")
                      + (f"Sapma alarmı: {drift['text']}. Liste kısaltıldı, önerilen pozisyon yarıya indirildi. "
                         if drift_alarm else "")
                      + (f"Politik risk yüksek ({risk['score']}/100): {'; '.join(risk.get('notes', [])[:2])}. Önerilen "
                       "pozisyon yarıya indirildi; liste kısaltılmadı (geçmişte BIST'te sert düşüşlerin ardından "
                       "açılan işlemler ortalamada iyi sonuç verdi ama dalgalanma yüksek). " if high_risk else "")
                      + stance(regime, len(picked), market, rejected, form)
                      + (f" {backtest['note']}" if backtest and backtest["note"] else ""),
            "data_issue": data_issue,
            # Test edilen portföy düzeni (paper.PORTFOLIO): işlem başına risk, en çok pozisyon, aynı sektörde en çok
            "portfolio": {k: v for k, v in {"risk_pct": round(paper_mod.portfolio_settings(market)["risk_pct"] * 100, 2),
                                             "max_positions": paper_mod.portfolio_settings(market)["max_positions"],
                                             "sector_cap": paper_mod.portfolio_settings(market)["sector_cap"]}.items()},
            "brake": {"drawdown_pct": round(pdd * 100, 1), "scale": brake["scale"]} if braking else None,
            "drift": drift or None,
            "political_risk": {k: risk.get(k) for k in ("score", "level", "notes")} if market == "BIST" and risk else None,
            "backtest": backtest,
            "form": {k: form[k] for k in ("recent_r", "recent_n", "recent_win", "long_r", "long_n", "effective")}
            if form else None,
            "ranking": "champion" if by_champion else "rules",
            "champion": champion if by_champion else None,
            "screened": int(len(g)), "passed_filter": int(len(pre)), "with_plan": len(rows),
            "candidates": picked,
            "radar": [{k: c[k] for k in RADAR_FIELDS} for c in radar],
        }
    return out


def build(scan: pd.DataFrame, prices: pd.DataFrame, overview: dict, side: "views.SideData",
          generated_at: pd.Timestamp, health: dict | None = None) -> dict:
    from . import assistant_track
    agenda = fetch_agenda()
    markets = candidates(scan, prices, overview, side, agenda, health)
    # Süren planlar: önceki günlerin listesinde olup planı hâlâ açık ya da giriş bekleyen hisse bugün yeniden çıktıysa
    # "devam eden plan, yeniden alma" diye işaretlenir (aynı hisseye farkında olmadan pozisyon büyütülmesin)
    try:
        history = assistant_track.load_history()
        for market, v in markets.items():
            active = assistant_track.active_plans(history, prices, market, v["date"])
            for c in v["candidates"]:
                a = active.get(c["symbol"])
                if a:
                    c["repeat"] = {"since": a["since"], "status": a["status"]}
                    c["commentary"] = (f"Süren plan: bu hisse {a['since']} tarihinden beri listede ve planı "
                                       f"{'açık (girildi)' if a['status'] == 'open' else 'giriş bekliyor'}; yeni alım "
                                       "değil, yeniden almayın. " + c.get("commentary", ""))
    except Exception as exc:  # işaretleme yapılamazsa liste yine yayınlanır
        print(f"  ! süren planlar: {exc!r}")
    # Sürüm: bulut bekçisi yeni liste geldiğini buradan anlar (yapay zekâ yorumu ve bildirim için)
    version = "|".join(f"{m}:{v['date']}:" + ",".join(c["symbol"] for c in v["candidates"])
                       for m, v in sorted(markets.items()))
    return {
        "agenda_snapshot": agenda,  # export günlük arşive yazar (uygulamaya gönderilmeden önce çıkarılır)
        "version": version,
        "generated_at": generated_at.isoformat(),
        "markets": markets,
        "disclaimer": ("Adaylar otomatik süzgeçten geçen \"koşullu alım adayları\"dır, yatırım tavsiyesi değildir. "
                       "Planlar geçmiş fiyat ve haber başlıklarından üretilir; sonucu garanti etmez. "
                       "Karar ve risk size aittir."),
    }
