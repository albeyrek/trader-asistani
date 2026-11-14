"""KAP bildirim arşivi (olay çalışması için): python -m scanner.kap_history [--start 2016-11-01] [--budget-min 110]

KAP'ın açık sorgu servisi gün gün sorgulanır (günde ~150-400 bildirim; tek sorgu sınırı 2000). Dosya varsa kaldığı
yerden devam eder. KAP'ı yormamak için istekler arası bekleme vardır (çok hızlı sorguda "Request Limit Exceeded" verir).
En yeni günlerden geriye doğru gider: olay çalışması son yılları önce kullanabilsin. Bulutta günlük iş akışı
(kap_archive.yml) süre sınırı içinde ilerler; arşiv tamamlanınca sadece yeni günleri ekler.
Çıktı data/kap_history.parquet: published (İstanbul saati), symbol (bildirimdeki her hisse için bir satır), subject,
summary, disclosure_index, disclosure_class, category, is_late
"""
import argparse
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS
from .news_sources import CIRCUIT_BREAKER_CODE, KAP_MAX_ROWS, KAP_URL

HISTORY_FILE = DATA_DIR / "kap_history.parquet"
PAUSE_SEC = 1.2
LIMIT_WAIT_SEC = 90  # KAP "Request Limit Exceeded" (429) verirse bu kadar beklenir
SAVE_EVERY = 30  # gün


def _query(day: date) -> list[dict] | None:
    for wait in (5, 20, 60, None):
        try:
            r = requests.post(KAP_URL, json={"fromDate": day.isoformat(), "toDate": day.isoformat()},
                              headers=HTTP_HEADERS, timeout=60)
            if r.status_code == 429:
                print(f"  {day}: KAP istek sınırı, {LIMIT_WAIT_SEC} sn bekleniyor", flush=True)
                time.sleep(LIMIT_WAIT_SEC)
                raise requests.HTTPError("429 Request Limit Exceeded")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as exc:
            if wait is None:
                print(f"  ! {day}: {exc}", flush=True)
                return None
            time.sleep(wait)
    return None


def _rows(day_rows: list[dict]) -> list[dict]:
    out = []
    for x in day_rows:
        summary = (x.get("summary") or "").strip()
        codes = x.get("stockCodes")
        if codes:
            symbols = [c.strip() for c in codes.split(",") if c.strip()]
        else:
            m = CIRCUIT_BREAKER_CODE.match(summary)
            if not m:
                continue  # şirkete özgü olmayan bildirim
            symbols = [m.group(1)]
        published = datetime.strptime(x["publishDate"], "%d.%m.%Y %H:%M:%S")
        for s in symbols:
            out.append({
                "published": published, "symbol": s, "subject": (x.get("subject") or "").strip(), "summary": summary,
                "disclosure_index": int(x["disclosureIndex"]), "disclosure_class": x.get("disclosureClass"),
                "category": x.get("disclosureCategory"), "is_late": bool(x.get("isLate")),
            })
    return out


def update(start: date, end: date, budget_min: float | None = None, pause: float = PAUSE_SEC) -> pd.DataFrame:
    old = pd.read_parquet(HISTORY_FILE) if HISTORY_FILE.exists() else None
    done = set(old["day"].unique()) if old is not None and "day" in old else set()
    rows: list[dict] = []
    failed: list[date] = []
    n = 0
    t0 = time.time()

    def save() -> pd.DataFrame:
        df = pd.DataFrame(rows)
        merged = pd.concat([old, df], ignore_index=True) if old is not None else df
        merged = merged.drop_duplicates(["disclosure_index", "symbol"]).sort_values("published").reset_index(drop=True)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        merged.to_parquet(HISTORY_FILE, index=False)
        return merged

    days = [end - timedelta(days=i) for i in range((end - start).days + 1)]  # yeniden eskiye
    todo = [d for d in days if d.isoformat() not in done]
    print(f"{len(todo)} gün sorgulanacak ({len(done)} gün zaten arşivde)", flush=True)
    for day in todo:
        if budget_min and time.time() - t0 > budget_min * 60:
            print(f"  süre doldu ({budget_min:.0f} dk); kalan {len(todo) - n} gün sonraki çalıştırmada", flush=True)
            break
        iso = day.isoformat()
        res = _query(day)
        if res is None:
            failed.append(day)
        else:
            if len(res) >= KAP_MAX_ROWS:
                print(f"  ! {day}: {KAP_MAX_ROWS} kayıt sınırı, bazı bildirimler eksik olabilir", flush=True)
            rows.extend({**r, "day": iso} for r in _rows(res))
            if not res:  # boş gün de "yapıldı" sayılsın (tekrar sorgulanmasın)
                rows.append({"day": iso, "published": pd.NaT, "symbol": "", "subject": "", "summary": "",
                             "disclosure_index": -day.toordinal(), "disclosure_class": None, "category": None,
                             "is_late": False})
        n += 1
        time.sleep(pause)
        if n % SAVE_EVERY == 0:
            merged = save()
            print(f"  {iso}: {len(merged):,} satır ({time.time() - t0:.0f} sn)", flush=True)
    merged = save()
    if failed:
        print(f"  ! alınamayan {len(failed)} gün: {', '.join(d.isoformat() for d in failed[:10])}"
              f"{' ...' if len(failed) > 10 else ''} (tekrar çalıştırınca yeniden denenir)")
    return merged


def load() -> pd.DataFrame:
    df = pd.read_parquet(HISTORY_FILE)
    return df[df["symbol"] != ""]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--start", default="2016-11-01")
    p.add_argument("--end", default=None)
    p.add_argument("--budget-min", type=float, default=None, help="Bu kadar dakika sonra kaydedip dur")
    p.add_argument("--pause", type=float, default=PAUSE_SEC, help="İstekler arası bekleme (sn)")
    a = p.parse_args()
    end = date.fromisoformat(a.end) if a.end else date.today() - timedelta(days=1)
    df = update(date.fromisoformat(a.start), end, a.budget_min, a.pause)
    real = df[df["symbol"] != ""]
    print(f"KAP arşivi: {real['published'].min()} – {real['published'].max()}, {len(real):,} hisse-bildirim, "
          f"{real['symbol'].nunique()} hisse")


if __name__ == "__main__":
    main()
