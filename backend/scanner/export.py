"""Tarama sonuçlarını GitHub Pages'te yayınlanacak statik JSON dosyalarına çevirir:
python -m scanner.export [--out site]

site/data/
  meta.json                     son veri tarihi, hisse sayıları, güvenilirlik notları
  {BIST,US}/up.json             en yüksek skorlu 100 hisse  ({total, items})
  {BIST,US}/down.json           en düşük skorlu 100 hisse
  {BIST,US}/alerts.json         uyarısı olan hisseler
  {BIST,US}/index.json          tüm hisselerin özet satırları (arama ve izleme listesi telefonda yapılır)
  stock/{BIST,US}/{KOD}.json    hisse detayı (grafik, gerekçeler, haberler)
  watch_meta.json               haber bekçisi (Cloudflare Worker) için hisse kodları, şirket adı anahtarları,
                                sınıflandırma kuralları ve eşikler (tek kaynak: Python kodu)
  levels.json                   gün içi alarmlar için son kapanış, destek, direnç, stop seviyeleri
  market.json                   piyasa rejimi: endeksler, genişlik ve geçmişi, rejim etiketi, sektörler
  assistant.json                asistan: günün alım adayları, işlem planları, kural tabanlı yorumlar
  assistant_score.json          asistan karnesi: geçmiş adaylar plana uyulsaydı sonuç (R)
  assistant_history.json        karnenin ham geçmişi
  model.json                    öğrenen model: eğitim tarihi, ileriye dönük test sonuçları, öğrenilenler
  scorecard.json                sinyal karnesi: geçmiş listelerin 5/10/20 gün sonraki fazla getirisi
  signals_history.json          karnenin ham geçmişi (önbellek silinirse buradan devam edilir)
"""
import argparse
import json
import shutil
import time
from pathlib import Path

import pandas as pd

from . import market as market_view  # "market" döngü değişkeni olarak da kullanılıyor
from . import assistant, assistant_track, learn, scorecard, views
from .config import DATA_DIR, ROOT
from .news import HIGH_SEVERITY, ITEMS_FILE, SOFT_CATEGORIES, _name_token
from .prices import load_prices, to_weekly
from .scan import RESULTS_FILE
from .sentiment import rules_json
from .watch import MAX_PER_DEVICE, MIN_ABS_SENTIMENT

TOP_N = 100


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _list(df: pd.DataFrame, total: int | None = None) -> dict:
    """total: listenin kesilmeden önceki boyu (uygulama '470 hisse' gibi gösterir)."""
    return {"total": len(df) if total is None else total,
            "items": [views.row(r, views.LIST_FIELDS) for _, r in df.iterrows()]}


def export(out: Path) -> None:
    t0 = time.time()
    data = out / "data"
    if data.exists():
        shutil.rmtree(data)
    all_prices = load_prices()  # endeksler dahil
    raw_scan = pd.read_parquet(RESULTS_FILE)
    side = views.SideData(all_prices, raw_scan)  # bilanço, temel veriler, göreli güç, sektörler
    scan = side.enrich(raw_scan)
    news = pd.read_parquet(ITEMS_FILE) if ITEMS_FILE.exists() else None
    updated = pd.Timestamp(RESULTS_FILE.stat().st_mtime, unit="s", tz="UTC")

    _write(data / "meta.json", views.meta(scan, updated))
    for market, g in scan.groupby("market"):
        _write(data / market / "up.json", _list(g.sort_values("combined_score", ascending=False).head(TOP_N), len(g)))
        _write(data / market / "down.json", _list(g.sort_values("combined_score").head(TOP_N), len(g)))
        alerts = g[g["alerts"].fillna("[]") != "[]"].sort_values("combined_score")
        _write(data / market / "alerts.json", _list(alerts))
        _write(data / market / "index.json", _list(g.sort_values("symbol")))

    prices = all_prices[all_prices["yf_symbol"].isin(scan["yf_symbol"])]
    daily = dict(tuple(prices.groupby("yf_symbol")))
    weekly = dict(tuple(to_weekly(prices).groupby("yf_symbol")))
    news_by = dict(tuple(news.groupby(["market", "symbol"]))) if news is not None else {}
    for i, (_, r) in enumerate(scan.iterrows(), 1):
        sym = r["yf_symbol"]
        if sym not in daily:
            continue
        detail = views.stock_detail(r, daily[sym], weekly.get(sym, daily[sym].iloc[:0]),
                                    news_by.get((r["market"], r["symbol"])), side)
        _write(data / "stock" / r["market"] / f"{r['symbol']}.json", detail)
        if i % 1000 == 0:
            print(f"  {i}/{len(scan)} hisse detayı")

    _write(data / "watch_meta.json", {
        "bist": sorted(scan.loc[scan["market"] == "BIST", "symbol"]),
        "names": {f"{r.market}:{r.symbol}": _name_token(r.name) for r in scan.itertuples()},
        "yf": {r.symbol: r.yf_symbol for r in scan[scan["market"] == "US"].itertuples()},
        "rules": rules_json(),
        "thresholds": {
            "high_severity": HIGH_SEVERITY,
            "soft_categories": sorted(SOFT_CATEGORIES),
            "min_abs_sentiment": MIN_ABS_SENTIMENT,
            "max_per_device": MAX_PER_DEVICE,
        },
    })
    # Piyasa rejimi: endeksler, genişlik, rejim etiketi (tüm fiyatlar gerekir: endeksler taranan hisselerde değil)
    overview = market_view.overview(all_prices, scan, side.sectors)
    _write(data / "market.json", overview)
    # Asistan: günün alım adayları ve işlem planları; geçmiş adayların sonucu (asistan karnesi)
    asst = assistant.build(scan, all_prices, overview, side, updated)
    _write(data / "assistant.json", asst)
    yf_of = {f"{r.market}:{r.symbol}": r.yf_symbol for r in scan.itertuples()}
    a_hist = assistant_track.record(assistant_track.load_history(), asst, yf_of)
    assistant_track.save_history(a_hist)
    _write(data / "assistant_history.json", a_hist)
    _write(data / "assistant_score.json", assistant_track.evaluate(a_hist, all_prices))
    # Öğrenen model: nasıl öğrendiği, test sonuçları, neye baktığı (haftalık eğitim: scanner/learn.py)
    if learn.META_FILE.exists():
        _write(data / "model.json", json.loads(learn.META_FILE.read_text(encoding="utf-8")))
    # Sinyal karnesi: bugünün listelerini kaydet, geçmiştekilerin sonraki getirisini ölç
    history = scorecard.record(scorecard.load_history(), scan)
    scorecard.save_history(history)
    _write(data / "signals_history.json", history)
    _write(data / "scorecard.json", scorecard.evaluate(history, all_prices, scan))
    # Gün içi fiyat alarmları için seviyeler: "PİYASA:KOD" -> [yahoo kodu, son kapanış, destek, direnç, stop]
    _write(data / "levels.json", views.levels_map(scan))
    # GitHub Pages'in Jekyll işlemesini kapat (alt çizgili dosyalar vb. sorun çıkarmasın)
    (out / ".nojekyll").write_text("", encoding="utf-8")
    index = out / "index.html"
    if not index.exists():
        index.write_text("<!doctype html><meta charset=utf-8><title>Trader Asistanı veri</title>"
                         "<p>Trader Asistanı uygulamasının veri dosyaları. Yatırım tavsiyesi değildir.</p>",
                         encoding="utf-8")
    size = sum(f.stat().st_size for f in data.rglob("*.json")) / 1e6
    print(f"Dışa aktarma tamam: {len(scan)} hisse, {size:.0f} MB ({time.time() - t0:.0f} sn)")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(ROOT.parent / "site"))
    export(Path(p.parse_args().out))


if __name__ == "__main__":
    main()
