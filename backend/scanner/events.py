"""Bilanço takvimi: python -m scanner.events

- ABD: Nasdaq bilanço takvimi (kesin tarih, açıklama zamanı, beklenen EPS)
- BIST: KAP'ta kesin takvim olmadığı için tahmin: şirketin geçen yıl aynı dönem finansal raporunu yayınladığı
  tarih + 1 yıl. Bu dönemin raporu son günlerde zaten yayınlandıysa "açıklandı" olarak işaretlenir.

Çıktı data/events.json: { "PİYASA:KOD": {"date", "status", "source", ...} }
  status: "expected" (ABD, kesin) | "estimated" (BIST, tahmini) | "reported" (son günlerde açıklandı)
"""
import json
import time
from datetime import date, datetime, timedelta

import requests

from .config import DATA_DIR, HTTP_HEADERS
from .news_sources import KAP_URL, REQUEST_PAUSE_SEC

EVENTS_FILE = DATA_DIR / "events.json"
NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings?date={d}"
NASDAQ_HEADERS = {**HTTP_HEADERS, "Accept": "application/json",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36"}
US_AHEAD_DAYS = 21
US_BACK_DAYS = 5
BIST_AHEAD_DAYS = 45
BIST_BACK_DAYS = 10


def _days(start: date, n: int) -> list[date]:
    return [start + timedelta(days=i) for i in range(n)]


def us_calendar(today: date) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for d in _days(today - timedelta(days=US_BACK_DAYS), US_BACK_DAYS + US_AHEAD_DAYS):
        if d.weekday() >= 5:
            continue
        try:
            r = requests.get(NASDAQ_URL.format(d=d.isoformat()), headers=NASDAQ_HEADERS, timeout=30)
            rows = (r.json().get("data") or {}).get("rows") or []
        except Exception as exc:
            print(f"  ! Nasdaq {d}: {exc}")
            continue
        for x in rows:
            sym = (x.get("symbol") or "").strip().replace("/", ".")
            if not sym:
                continue
            out[f"US:{sym}"] = {
                "date": d.isoformat(),
                "status": "reported" if d < today else "expected",
                "source": "Nasdaq",
                "time": {"time-pre-market": "açılış öncesi", "time-after-hours": "kapanış sonrası"}.get(x.get("time") or ""),
                "eps_forecast": (x.get("epsForecast") or "").strip() or None,
                "period": (x.get("fiscalQuarterEnding") or "").strip() or None,
            }
        time.sleep(REQUEST_PAUSE_SEC)
    return out


def _kap_reports(day: date) -> list[dict]:
    """O gün yayınlanan finansal raporlar (sadece FR sınıfı: 2000 kayıt sınırına takılmasın)."""
    r = requests.post(KAP_URL, json={"fromDate": day.isoformat(), "toDate": day.isoformat(), "disclosureClass": "FR"},
                      headers=HTTP_HEADERS, timeout=60)
    r.raise_for_status()
    return [x for x in r.json() if (x.get("subject") or "").strip() == "Finansal Rapor" and x.get("stockCodes")]


def bist_calendar(today: date, bist_symbols: set[str]) -> dict[str, dict]:
    def collect(days: list[date]) -> dict[str, tuple[date, int, int]]:
        found: dict[str, tuple[date, int, int]] = {}
        for d in days:
            if d.weekday() >= 5:
                continue
            try:
                rows = _kap_reports(d)
            except Exception as exc:
                print(f"  ! KAP {d}: {exc}")
                continue
            for x in rows:
                pub = datetime.strptime(x["publishDate"], "%d.%m.%Y %H:%M:%S").date()
                for s in (c.strip() for c in x["stockCodes"].split(",")):
                    if s in bist_symbols and s not in found:
                        found[s] = (pub, int(x.get("year") or 0), int(x.get("period") or 0))
            time.sleep(REQUEST_PAUSE_SEC)
        return found

    # Bu dönem zaten açıklayanlar (son günler) ve geçen yılın aynı penceresi
    recent = collect(_days(today - timedelta(days=BIST_BACK_DAYS), BIST_BACK_DAYS + 1))
    last_year = collect(_days(today - timedelta(days=364), BIST_AHEAD_DAYS))
    out: dict[str, dict] = {}
    for s, (pub, year, period) in recent.items():
        out[f"BIST:{s}"] = {"date": pub.isoformat(), "status": "reported", "source": "KAP",
                            "period": f"{year}/{period * 3} ay" if period else None}
    for s, (pub, year, period) in last_year.items():
        key = f"BIST:{s}"
        if key in out:
            continue
        est = pub + timedelta(days=364)  # aynı haftanın günü
        if est >= today:
            out[key] = {"date": est.isoformat(), "status": "estimated", "source": "KAP (geçen yılın tarihine göre)",
                        "period": f"{year + 1}/{period * 3} ay" if period else None, "last_year": pub.isoformat()}
    return out


def build(scan_symbols: dict[str, set[str]], today: date | None = None) -> dict[str, dict]:
    today = today or date.today()
    events = us_calendar(today)
    events = {k: v for k, v in events.items() if k.split(":", 1)[1] in scan_symbols.get("US", set())}
    events.update(bist_calendar(today, scan_symbols.get("BIST", set())))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EVENTS_FILE.write_text(json.dumps(events, ensure_ascii=False), encoding="utf-8")
    return events


def load() -> dict[str, dict]:
    if not EVENTS_FILE.exists():
        return {}
    try:
        return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def days_until(ev: dict | None, today: date | None = None) -> int | None:
    if not ev:
        return None
    return (date.fromisoformat(ev["date"]) - (today or date.today())).days


TR_MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]
SOON_DAYS = 14


def _tr_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.day} {TR_MONTHS[d.month - 1]}"


def event_note(ev: dict | None, today: date | None = None) -> str | None:
    """Asistan notu: yaklaşan ya da yeni açıklanmış bilanço."""
    n = days_until(ev, today)
    if n is None:
        return None
    when = _tr_date(ev["date"])
    if ev["status"] == "reported":
        return f"Bilanço {when} tarihinde açıklandı; fiyatın bilançoya tepkisi izlenmeli." if n >= -7 else None
    if n > SOON_DAYS or n < 0:
        return None
    est = " (geçen yılın tarihine göre tahmini)" if ev["status"] == "estimated" else ""
    t = f", {ev['time']}" if ev.get("time") else ""
    day = "bugün" if n == 0 else "yarın" if n == 1 else f"{n} gün sonra"
    return (f"Bilanço {day}: {when}{t}{est}. Açıklama öncesi ve sonrası sert fiyat hareketleri olabilir; "
            "yeni pozisyonda dikkatli ol.")


def main() -> None:
    import pandas as pd

    from .scan import RESULTS_FILE
    t0 = time.time()
    scan = pd.read_parquet(RESULTS_FILE)
    syms = {m: set(g["symbol"]) for m, g in scan.groupby("market")}
    ev = build(syms)
    by = {}
    for k, v in ev.items():
        by.setdefault((k.split(":")[0], v["status"]), 0)
        by[(k.split(":")[0], v["status"])] += 1
    print(f"{len(ev)} olay ({time.time() - t0:.0f} sn): {by}")


if __name__ == "__main__":
    main()
