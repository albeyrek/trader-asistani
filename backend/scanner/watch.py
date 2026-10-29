"""Haber bekçisi: yeni KAP bildirimleri ve haberleri birkaç dakikada bir kontrol edip telefona bildirim gönderir.

    python -m scanner.watch               # 5 dakikada bir, sürekli
    python -m scanner.watch --once        # tek tur (zamanlayıcı için)
    python -m scanner.watch --test-push   # kayıtlı cihazlara deneme bildirimi

Kurallar (cihaz başına):
- İzleme listesindeki hisse: rutin olmayan her KAP bildirimi ve belirgin olumlu/olumsuz haberler
- Tercih açıksa tüm hisseler: ciddi risk haberleri (konkordato, SPK tedbiri, dava, gözaltı vb.)
"""
import argparse
import json
import re
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

from .config import DATA_DIR
from .devices import load_devices, remove_devices
from .news import HIGH_SEVERITY, SOFT_CATEGORIES, classify_items, filter_relevant
from .news_sources import REQUEST_PAUSE_SEC, fetch_google_news_tr, fetch_kap, fetch_yahoo_news
from .scan import RESULTS_FILE

SEEN_FILE = DATA_DIR / "watch_seen.json"
LOG_FILE = DATA_DIR / "watch_log.jsonl"
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

SEEN_KEEP_DAYS = 10
MIN_ABS_SENTIMENT = 0.25     # izlenen hissede KAP dışı haber bu kadar belirgin olmalı
MAX_PER_DEVICE = 8           # bir turda cihaz başına en fazla bildirim (fazlası özetlenir)
NEWS_DAYS = 2


# ------------------------------------------------------------------ görülen haberler

def _key(r) -> str:
    if r.source == "KAP":
        return r.url
    title = re.sub(r"\W+", " ", r.title.lower()).strip()
    return f"{r.market}|{r.symbol}|{title}"


def _load_seen() -> dict[str, str] | None:
    if not SEEN_FILE.exists():
        return None
    try:
        return json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_seen(seen: dict[str, str]) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=SEEN_KEEP_DAYS)).isoformat()
    seen = {k: v for k, v in seen.items() if v >= cutoff}
    SEEN_FILE.write_text(json.dumps(seen, ensure_ascii=False), encoding="utf-8")


# ------------------------------------------------------------------ toplama

def _watched(devices: dict[str, dict]) -> set[tuple[str, str]]:
    return {(w["symbol"], w["market"]) for d in devices.values() for w in d.get("watchlist", [])}


def collect(watched: set[tuple[str, str]], scan: pd.DataFrame) -> pd.DataFrame:
    bist_symbols = set(scan.loc[scan["market"] == "BIST", "symbol"])
    items = [x for x in fetch_kap(NEWS_DAYS) if x["symbol"] in bist_symbols]
    for symbol, market in sorted(watched):
        try:
            if market == "BIST":
                items += fetch_google_news_tr(symbol, NEWS_DAYS)
            else:
                yf_symbol = scan.loc[(scan["symbol"] == symbol) & (scan["market"] == "US"), "yf_symbol"]
                items += fetch_yahoo_news(symbol, yf_symbol.iloc[0] if len(yf_symbol) else symbol)
        except Exception as exc:  # tek hissenin kaynağı çalışmazsa tur devam etsin
            print(f"  ! {symbol}: {exc}")
        time.sleep(REQUEST_PAUSE_SEC)
    if not items:
        return pd.DataFrame()
    df = pd.DataFrame(items)
    df["published"] = pd.to_datetime(df["published"], utc=True)
    df = filter_relevant(df, scan)
    return classify_items(df) if len(df) else df


# ------------------------------------------------------------------ karar ve gönderim

def _is_severe(r) -> bool:
    hard = [c for c in json.loads(r.categories) if c not in SOFT_CATEGORIES]
    return r.sentiment <= HIGH_SEVERITY and bool(hard)


def _message(token: str, r, severe: bool) -> dict:
    cats = [c for c in json.loads(r.categories) if c not in SOFT_CATEGORIES]
    if severe:
        title = f"⚠️ {r.symbol}: Ciddi risk ({', '.join(cats)})"
    else:
        tone = "Olumlu" if r.sentiment > 0.05 else "Olumsuz" if r.sentiment < -0.05 else "Bilgi"
        title = f"{r.symbol} · {tone}{' · KAP' if r.source == 'KAP' else ''}"
    return {
        "to": token,
        "title": title,
        "body": r.title[:178],
        "data": {"symbol": r.symbol, "market": r.market, "url": r.url},
        "sound": "default",
        "priority": "high",
        "channelId": "default",
    }


def plan_messages(new: pd.DataFrame, devices: dict[str, dict]) -> list[dict]:
    messages = []
    for token, dev in devices.items():
        watch = {(w["symbol"], w["market"]) for w in dev.get("watchlist", [])}
        picked = []
        for r in new.itertuples():
            if r.routine:
                continue
            severe = _is_severe(r)
            if (r.symbol, r.market) in watch:
                if r.source == "KAP" or abs(r.sentiment) >= MIN_ABS_SENTIMENT or severe:
                    picked.append((r, severe))
            elif dev.get("notify_all_severe") and severe:
                picked.append((r, True))
        for r, severe in picked[:MAX_PER_DEVICE]:
            messages.append(_message(token, r, severe))
        if len(picked) > MAX_PER_DEVICE:
            rest = picked[MAX_PER_DEVICE:]
            symbols = ", ".join(sorted({r.symbol for r, _ in rest})[:6])
            messages.append({"to": token, "title": f"{len(rest)} yeni haber daha",
                             "body": f"{symbols} için yeni haberler var.", "sound": "default", "channelId": "default"})
    return messages


def send(messages: list[dict]) -> int:
    """Expo push servisine gönderir; silinmiş uygulamaların adreslerini temizler. Başarılı gönderim sayısını döndürür."""
    ok, dead = 0, []
    for i in range(0, len(messages), 100):
        batch = messages[i:i + 100]
        try:
            r = requests.post(EXPO_PUSH_URL, json=batch, timeout=30,
                              headers={"Accept": "application/json", "Content-Type": "application/json"})
            tickets = r.json().get("data", [])
        except Exception as exc:
            print(f"  ! bildirim gönderilemedi: {exc}")
            continue
        for msg, t in zip(batch, tickets):
            if t.get("status") == "ok":
                ok += 1
            else:
                err = (t.get("details") or {}).get("error")
                print(f"  ! {msg['to'][:30]}…: {t.get('message')} ({err})")
                if err == "DeviceNotRegistered":
                    dead.append(msg["to"])
    remove_devices(dead)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        now = datetime.now(timezone.utc).isoformat()
        for m in messages:
            f.write(json.dumps({"at": now, "title": m["title"], "body": m["body"], "data": m.get("data")},
                               ensure_ascii=False) + "\n")
    return ok


# ------------------------------------------------------------------ tur

def run_once() -> None:
    t0 = time.time()
    devices = load_devices()
    scan = pd.read_parquet(RESULTS_FILE)
    watched = _watched(devices)
    items = collect(watched, scan)
    seen = _load_seen()
    bootstrap = seen is None
    seen = seen or {}

    keys = [_key(r) for r in items.itertuples()] if len(items) else []
    new = items[[k not in seen for k in keys]] if len(items) else items
    now = datetime.now(timezone.utc).isoformat()
    seen.update({k: now for k in keys})
    _save_seen(seen)

    stamp = datetime.now().strftime("%H:%M")
    if bootstrap:
        print(f"[{stamp}] İlk çalıştırma: {len(keys)} mevcut haber 'görüldü' olarak işaretlendi, bildirim gönderilmedi.")
        return
    messages = plan_messages(new, devices) if len(new) else []
    sent = send(messages) if messages else 0
    print(f"[{stamp}] {len(devices)} cihaz, {len(watched)} izlenen hisse · {len(items)} haber, {len(new)} yeni · "
          f"{sent}/{len(messages)} bildirim gönderildi ({time.time() - t0:.0f} sn)")


def test_push() -> None:
    devices = load_devices()
    if not devices:
        print("Kayıtlı cihaz yok. Uygulamayı (APK) telefonda açıp Ayarlar > Bildirimler'in 'Açık' olduğunu kontrol et.")
        return
    msgs = [{"to": t, "title": "Trader Asistanı", "body": "Deneme bildirimi: bildirimler çalışıyor.",
             "data": {"symbol": "THYAO", "market": "BIST"}, "sound": "default", "channelId": "default"}
            for t in devices]
    print(f"{send(msgs)}/{len(msgs)} cihaza gönderildi.")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--interval", type=float, default=5, help="Dakika cinsinden kontrol aralığı")
    p.add_argument("--once", action="store_true")
    p.add_argument("--test-push", action="store_true")
    args = p.parse_args()

    if args.test_push:
        test_push()
        return
    if args.once:
        run_once()
        return
    print(f"Haber bekçisi başladı: {args.interval:g} dakikada bir kontrol. Durdurmak için Ctrl+C.")
    while True:
        try:
            run_once()
        except Exception as exc:  # internet kesintisi vb. bekçiyi durdurmasın
            print(f"[{datetime.now():%H:%M}] ! tur başarısız: {exc}")
        time.sleep(args.interval * 60)


if __name__ == "__main__":
    main()
