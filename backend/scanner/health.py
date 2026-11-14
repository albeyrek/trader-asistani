"""Sistem sağlığı: her dışa aktarmada veri, kaynaklar, öğrenme ve canlı sonuçlar kontrol edilir (data/health.json).

Durumlar: ok (sorun yok), warn (dikkat), error (asistanın önerilerini etkileyen sorun). Genel durum en kötüsüdür.
  - veri tazeliği: son işlem gününün fiyatı olan hisse oranı (Yahoo bazen eksik gönderiyor)
  - veri güncelliği: piyasanın son veri günü kaç iş günü önce
  - veri hatası: BIST'te günlük sınırı (±%10) aşan sıçrama (bölünme/veri hatası şüphesi)
  - evren: taranan hisse sayısı son günlere göre düştü mü
  - haberler ve KAP: son günlerde gelen haber ve bildirim var mı
  - öğrenme: model ve çıkış kuralı raporu ne kadar eski
  - bulut bekçisi: gündem ve haber turları çalışıyor mu
  - sapma: asistanın canlı işlemleri, 10 yıllık testin beklentisinden istatistiksel olarak kötü mü
"""
import json
from datetime import date

import numpy as np
import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS, WORKER_URL

HISTORY_FILE = DATA_DIR / "health_history.json"  # günlük sayılar (evren boyutu karşılaştırması için)
UNIVERSE_ARCHIVE = DATA_DIR / "universe_history.parquet"  # hayatta kalan yanlılığını ileride azaltmak için
FRESH_OK, FRESH_ERR = 0.95, 0.80
DRIFT_MIN_TRADES = 15
RANK = {"ok": 0, "warn": 1, "error": 2}


def _bdays(d0: date, d1: date) -> int:
    return int(np.busday_count(d0, d1))


def _check(cid: str, name: str, status: str, detail: str, market: str | None = None) -> dict:
    return {"id": cid, "name": name, "status": status, "detail": detail, "market": market}


def data_checks(scan: pd.DataFrame, prices: pd.DataFrame, today: date) -> list[dict]:
    out = []
    for market, g in scan.groupby("market"):
        last = str(g["date"].max())
        share = float((g["date"] == g["date"].max()).mean())
        st = "ok" if share >= FRESH_OK else "warn" if share >= FRESH_ERR else "error"
        out.append(_check(f"fresh_{market}", f"Veri tazeliği ({market})", st,
                          f"Hisselerin %{share * 100:.0f}'inde son işlem gününün ({last}) fiyatı var", market))
        age = _bdays(date.fromisoformat(last), today)
        # Bayram tatilleri 5-6 iş gününe uzayabilir: o kadarı uyarı, fazlası hata
        st = "ok" if age <= 1 else "warn" if age <= 6 else "error"
        out.append(_check(f"age_{market}", f"Veri güncelliği ({market})", st,
                          f"Son veri {last} ({age} iş günü önce){' — tatil olabilir' if st == 'warn' else ''}", market))
    b = prices[prices["yf_symbol"].str.endswith(".IS")].sort_values(["yf_symbol", "date"])
    chg = b.groupby("yf_symbol")["close"].pct_change()
    recent = b["date"] >= b["date"].max() - pd.Timedelta(days=14)
    bad = b.loc[recent & (chg.abs() > 0.35), "yf_symbol"].unique()
    out.append(_check("jumps", "Veri hatası şüphesi (BIST)", "warn" if len(bad) else "ok",
                      f"Son 2 haftada günlük sınırı aşan sıçrama: {', '.join(s.removesuffix('.IS') for s in bad[:5])}"
                      if len(bad) else "Günlük sınırı aşan sıçrama yok", "BIST"))
    return out


def universe_checks(scan: pd.DataFrame, today: date) -> list[dict]:
    hist = json.loads(HISTORY_FILE.read_text(encoding="utf-8")) if HISTORY_FILE.exists() else []
    counts = scan["market"].value_counts().to_dict()
    out = []
    for market, n in counts.items():
        past = [h["counts"].get(market) for h in hist[-30:] if h["counts"].get(market)]
        med = float(np.median(past)) if past else None
        st = "ok" if med is None or n >= 0.9 * med else "warn"
        out.append(_check(f"universe_{market}", f"Taranan hisse ({market})", st,
                          f"{n} hisse" + (f" (son günlerin ortası {med:.0f})" if med else ""), market))
    hist = [h for h in hist if h["date"] != today.isoformat()] + [{"date": today.isoformat(), "counts": counts}]
    HISTORY_FILE.write_text(json.dumps(hist[-120:]), encoding="utf-8")
    return out


def source_checks(news: pd.DataFrame | None) -> list[dict]:
    if news is None or news.empty:
        return [_check("news", "Haberler ve KAP", "warn", "Haber verisi yok")]
    pub = pd.to_datetime(news["published"], utc=True)
    now = pd.Timestamp.now(tz="UTC")
    n48 = int((pub >= now - pd.Timedelta(hours=48)).sum())
    kap = int(((news["source"] == "KAP") & (pub >= now - pd.Timedelta(days=4))).sum())
    st = "ok" if n48 > 0 and kap > 0 else "warn"
    return [_check("news", "Haberler ve KAP", st, f"Son 48 saatte {n48} haber; son 4 günde {kap} KAP bildirimi")]


def learning_checks(model_meta: dict | None, exits_rep: dict | None, kap_days: int | None) -> list[dict]:
    now = pd.Timestamp.now(tz="UTC")
    out = []
    for cid, name, meta, key in (("model", "Öğrenen model", model_meta, "trained_at"),
                                 ("exits", "Çıkış kuralı testi", exits_rep, "generated_at")):
        if not meta:
            out.append(_check(cid, name, "warn", "Henüz çalışmadı"))
            continue
        age = (now - pd.Timestamp(meta[key])).days
        st = "ok" if age <= 8 else "warn" if age <= 15 else "error"
        out.append(_check(cid, name, st, f"Son güncelleme {age} gün önce (haftalık öğrenme cumartesi çalışır)"))
    if kap_days is not None:
        total = (date.today() - date(2016, 11, 1)).days
        pct = min(100.0, kap_days / total * 100)
        out.append(_check("kap_archive", "KAP arşivi", "ok", f"%{pct:.0f} tamamlandı ({kap_days} gün)"))
    return out


def worker_checks() -> list[dict]:
    try:
        st = requests.get(f"{WORKER_URL}/api/status", headers=HTTP_HEADERS, timeout=20).json()
    except (requests.RequestException, ValueError):
        return [_check("worker", "Bulut bekçisi", "error", "Bulut bekçisine ulaşılamadı")]
    now = pd.Timestamp.now(tz="UTC")
    out = []
    for cid, name, part, limit_min in (("worker_news", "Haber bekçisi (5 dk)", st.get("last"), 30),
                                       ("worker_agenda", "Gündem (15 dk)", st.get("agenda"), 90)):
        if not part or not part.get("at"):
            out.append(_check(cid, name, "warn", "Henüz çalışmadı"))
            continue
        age = (now - pd.Timestamp(part["at"])).total_seconds() / 60
        err = part.get("error")
        # gündem: tüm kaynaklar başarısızsa (ör. haber sitesi bulut IP'lerini engelledi) gündem eskir
        unreachable = part.get("failed", 0) > 0 and not part.get("fetched")
        status = "error" if age > limit_min * 4 else "warn" if age > limit_min or err or unreachable else "ok"
        out.append(_check(cid, name, status, f"Son tur {age:.0f} dk önce" + (f"; hata: {str(err)[:80]}" if err else "")
                          + (f"; {part['failed']} kaynağın hiçbirine ulaşılamadı" if unreachable else "")
                          + (f" ({part['fail_reason']})" if unreachable and part.get("fail_reason") else "")))
    return out


def drift(score: dict, exits_rep: dict | None) -> dict:
    """Canlı işlemlerin ortalama R'si, 10 yıllık testin beklentisinden anlamlı (z <= -2) kötü mü?"""
    out = {}
    for market, sc in score.items():
        rs = np.array(sc.get("closed_rs", []), dtype=float)
        sel = (exits_rep or {}).get("selected", {}).get(market)
        expected = sel["avg_r"] if sel else None
        sd = sel.get("std_r") if sel and sel.get("std_r") else 1.5
        if expected is None or len(rs) < DRIFT_MIN_TRADES:
            out[market] = {"status": "insufficient", "n": int(len(rs)), "expected": expected,
                           "live": round(float(rs.mean()), 3) if len(rs) else None,
                           "text": f"Canlı sonuç için en az {DRIFT_MIN_TRADES} kapanmış işlem gerekiyor (şu an {len(rs)})"}
            continue
        z = (rs.mean() - expected) / (sd / np.sqrt(len(rs)))
        status = "alarm" if z <= -2 else "watch" if z <= -1 else "ok"
        out[market] = {"status": status, "n": int(len(rs)), "expected": round(float(expected), 3),
                       "live": round(float(rs.mean()), 3), "z": round(float(z), 2),
                       "text": (f"Canlı {len(rs)} işlemde ortalama {rs.mean():+.2f}R; test beklentisi {expected:+.2f}R"
                                + (" — test beklentisinin belirgin şekilde altında" if status == "alarm"
                                   else " — beklentinin altında, izleniyor" if status == "watch" else ""))}
    return out


def archive_universe(scan: pd.DataFrame, day: str) -> None:
    row = scan[["market", "symbol", "yf_symbol", "avg_turnover"]].assign(date=day)
    if UNIVERSE_ARCHIVE.exists():
        old = pd.read_parquet(UNIVERSE_ARCHIVE)
        row = pd.concat([old[old["date"] != day], row], ignore_index=True)
    row.to_parquet(UNIVERSE_ARCHIVE, index=False)


def build(scan: pd.DataFrame, prices: pd.DataFrame, news: pd.DataFrame | None, score: dict, model_meta: dict | None,
          exits_rep: dict | None, kap_days: int | None) -> dict:
    today = date.today()
    checks = (data_checks(scan, prices, today) + universe_checks(scan, today) + source_checks(news)
              + learning_checks(model_meta, exits_rep, kap_days) + worker_checks())
    dr = drift(score, exits_rep)
    for market, d in dr.items():
        status = {"alarm": "error", "watch": "warn"}.get(d["status"], "ok")
        checks.append(_check(f"drift_{market}", f"Canlı sonuç / test beklentisi ({market})", status, d["text"], market))
    overall = max((c["status"] for c in checks), key=lambda s: RANK[s], default="ok")
    blocked = sorted({c["market"] for c in checks if c["status"] == "error" and c["id"].startswith(("fresh_", "age_"))})
    return {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "overall": overall, "checks": checks, "drift": dr,
            "blocked_markets": blocked}


def kap_archive_days() -> int | None:
    from . import kap_history
    if not kap_history.HISTORY_FILE.exists():
        return None
    return int(pd.read_parquet(kap_history.HISTORY_FILE, columns=["day"])["day"].nunique())


def safe_build(*args) -> dict:
    """Sağlık kontrolünün kendisi hata verirse dışa aktarma durmasın; durum 'uyarı' olarak bildirilir."""
    try:
        return build(*args)
    except Exception as exc:  # noqa: BLE001
        return {"generated_at": pd.Timestamp.now(tz="UTC").isoformat(), "overall": "warn", "drift": {},
                "blocked_markets": [],
                "checks": [_check("health", "Sağlık kontrolü", "warn", f"Kontrol çalışmadı: {exc!r}"[:200])]}
