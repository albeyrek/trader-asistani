"""Günlük tam çalıştırma: veri güncelleme -> teknik tarama -> haber ve KAP analizi [-> statik dışa aktarma].

python -m scanner.daily                       # iki piyasa
python -m scanner.daily --market BIST         # sadece BIST verisi ve taraması (ABD açıkken yarım gün verisi alınmasın)
python -m scanner.daily --export site         # sonunda GitHub Pages için JSON üret
"""
import argparse
import sys
import time

from . import events, export, news, scan, update_data


def _run(step: str, fn, *args: str) -> None:
    print(f"\n========== {step} ==========", flush=True)
    t0 = time.time()
    saved = sys.argv
    sys.argv = [saved[0], *args]  # alt komutlar kendi argümanlarını sys.argv'den okur
    try:
        fn()
    finally:
        sys.argv = saved
    print(f"({step}: {time.time() - t0:.0f} sn)", flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--market", choices=["US", "BIST"], help="Sadece bir piyasanın verisini ve taramasını güncelle")
    p.add_argument("--export", metavar="KLASÖR", help="Sonunda statik JSON dosyalarını bu klasöre yaz")
    args = p.parse_args()
    market = ["--market", args.market] if args.market else []

    _run("1/5 Veri güncelleme", update_data.main, *market)
    _run("2/5 Teknik tarama", scan.main, *market)
    _run("3/5 Haber ve KAP analizi", news.main)
    _run("4/5 Bilanço takvimi", events.main)
    if args.export:
        _run("5/5 Dışa aktarma", export.main, "--out", args.export)


if __name__ == "__main__":
    main()
