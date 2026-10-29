"""Günlük veri güncelleme: python -m scanner.update_data [--refresh-universe] [--market US|BIST] [--limit N]"""
import argparse
import time
import warnings

# yfinance, pandas 3.x ile kullanım dışı uyarıları basıyor; çıktıyı kirletmesin
warnings.filterwarnings("ignore", module="yfinance")

from .config import DATA_DIR, INDEX_SYMBOLS
from .liquidity import liquidity_table
from .prices import update_prices
from .universe import build_universe, load_universe


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--refresh-universe", action="store_true", help="Hisse listesini yeniden çek")
    p.add_argument("--market", choices=["US", "BIST"], help="Sadece bir piyasa")
    p.add_argument("--limit", type=int, help="Test için ilk N sembol")
    args = p.parse_args()

    t0 = time.time()
    if args.refresh_universe or not (DATA_DIR / "universe.csv").exists():
        print("Hisse evreni çekiliyor...")
        universe = build_universe()
    else:
        universe = load_universe()
    if args.market:
        universe = universe[universe["market"] == args.market]
    symbols = universe["yf_symbol"].tolist()[: args.limit]
    markets = [args.market] if args.market else list(INDEX_SYMBOLS)
    symbols += [s for m in markets for s in INDEX_SYMBOLS[m]]  # endeksler, VIX, USD/TRY
    print(f"{len(symbols)} sembol için fiyatlar indiriliyor...")

    prices = update_prices(symbols)
    liq = liquidity_table(prices, universe)
    liq.to_csv(DATA_DIR / "liquidity.csv", index=False, encoding="utf-8")

    print(f"\nTamamlandı ({time.time() - t0:.0f} sn)")
    print(f"Verisi gelen sembol: {prices['yf_symbol'].nunique()} / {len(symbols)}")
    print("Likit hisse sayısı:")
    print(liq[liq["liquid"]].groupby("market").size().to_string())


if __name__ == "__main__":
    main()
