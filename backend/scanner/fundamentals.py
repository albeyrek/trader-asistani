"""Temel veriler: python -m scanner.fundamentals

- BIST: İş Yatırım "Temel Değerler ve Oranlar" (F/K, FD/FAVÖK, FD/Satışlar, PD/DD, piyasa değeri, halka açıklık)
- ABD: Nasdaq hisse tarayıcısı (sektör, endüstri, piyasa değeri, ülke). Ücretsiz güvenilir F/K kaynağı yok.

Çıktı data/fundamentals.json: { "PİYASA:KOD": {...} }
"""
import io
import json
import math
import time

import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS
from .universe import BIST_URL

FUND_FILE = DATA_DIR / "fundamentals.json"
NASDAQ_SCREENER = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true"
NASDAQ_HEADERS = {"Accept": "application/json",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36"}

# Basit risk eşikleri (tek başına al/sat gerekçesi değildir; sadece dikkat çeker)
HIGH_PE = 50
HIGH_PB = 10
LOW_FREE_FLOAT = 15         # %
SMALL_CAP = {"BIST": 1_000, "US": 300}  # BIST: mn TL, ABD: mn $


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def bist() -> dict[str, dict]:
    html = requests.get(BIST_URL, headers=HTTP_HEADERS, timeout=60).text
    tables = pd.read_html(io.StringIO(html), decimal=",", thousands=".")
    summary = next(t for t in tables if any("Halka" in str(c) for c in t.columns))
    ratios = next(t for t in tables if "F/K" in [str(c) for c in t.columns])
    summary.columns = ["symbol", "name", "sector", "close", "mcap_try", "mcap_usd", "free_float", "capital"][:len(summary.columns)]
    ratios.columns = ["symbol", "close", "pe", "ev_ebitda", "ev_sales", "pb", "period"][:len(ratios.columns)]
    df = summary.merge(ratios.drop(columns=["close"]), on="symbol", how="left")
    out = {}
    for r in df.itertuples():
        out[f"BIST:{str(r.symbol).strip()}"] = {
            "pe": _num(r.pe), "ev_ebitda": _num(r.ev_ebitda), "ev_sales": _num(r.ev_sales), "pb": _num(r.pb),
            "market_cap": _num(r.mcap_try), "market_cap_usd": _num(r.mcap_usd), "cap_unit": "mn TL",
            "free_float": _num(r.free_float), "period": str(r.period) if isinstance(r.period, str) else None,
        }
    return out


def us() -> dict[str, dict]:
    rows = requests.get(NASDAQ_SCREENER, headers=NASDAQ_HEADERS, timeout=60).json()["data"]["rows"]
    out = {}
    for x in rows:
        sym = (x.get("symbol") or "").strip().replace("/", ".")
        cap = _num(x.get("marketCap"))
        out[f"US:{sym}"] = {
            "sector": (x.get("sector") or "").strip() or None,
            "industry": (x.get("industry") or "").strip() or None,
            "market_cap": round(cap / 1e6, 1) if cap else None, "cap_unit": "mn $",
            "country": (x.get("country") or "").strip() or None,
        }
    return out


def flags(f: dict | None, market: str) -> list[str]:
    """Temel verilerden dikkat edilmesi gerekenler."""
    if not f:
        return []
    out = []
    pe, pb, ff, cap = f.get("pe"), f.get("pb"), f.get("free_float"), f.get("market_cap")
    if pe is not None and pe < 0:
        out.append("Şirket son 12 ayda zarar etmiş (F/K negatif).")
    elif pe is not None and pe > HIGH_PE:
        out.append(f"F/K {pe:.0f}: kârına göre pahalı fiyatlanıyor; beklentiler karşılanmazsa düşüş sert olabilir.")
    if pb is not None and pb > HIGH_PB:
        out.append(f"PD/DD {pb:.1f}".replace(".", ",") + ": piyasa değeri defter değerinin çok üzerinde.")
    if ff is not None and ff < LOW_FREE_FLOAT:
        out.append(f"Halka açıklık %{ff:.0f}: dolaşımdaki pay az; fiyat oynak ve yönlendirmeye açık olabilir.")
    if cap is not None and cap < SMALL_CAP.get(market, 0):
        out.append("Küçük ölçekli şirket: likidite ve oynaklık riski daha yüksek.")
    return out


def build() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, fn in (("BIST", bist), ("ABD", us)):
        try:
            part = fn()
            out.update(part)
            print(f"  {name}: {len(part)} hisse")
        except Exception as exc:  # bir kaynak çalışmazsa diğeri yine yazılsın
            print(f"  ! {name} temel verileri alınamadı: {exc}")
    if out:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        FUND_FILE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def load() -> dict[str, dict]:
    if not FUND_FILE.exists():
        return {}
    try:
        return json.loads(FUND_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def main() -> None:
    t0 = time.time()
    out = build()
    print(f"{len(out)} hisse için temel veri ({time.time() - t0:.0f} sn)")


if __name__ == "__main__":
    main()
