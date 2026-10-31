"""Öğrenen asistan: "geçmişte asistanın planları uygulansaydı ne olurdu?" sorusundan öğrenir.

python -m scanner.learn [--limit N] [--workers N]

1) Yeniden oynatma: her hisse için her hafta sonu kapanışında, sadece o güne kadarki veriyle teknik skor ve asistan
   planı (assistant.plan_at) hesaplanır; plan sonraki günlerde simüle edilir (assistant_track.simulate): önce ilk hedef
   mi geldi, stop mu? Uzun geçmiş (scanner/history.py, ~10 yıl) varsa o kullanılır, yoksa günlük taramanın 2 yılı.
   Haber geçmişi olmadığı için haberler modele girmez (canlıda süzgeç olarak kullanılır).
2) Model: iki soru öğrenilir. Olasılık modeli "ilk hedefe stoptan önce ulaşır mı?" (bilgi amaçlı), getiri modeli
   "plan kaç R kazandırır?" (sıralama için). Aday modeller kayan pencereli geçmiş testle karşılaştırılır: geçmiş
   FOLD_WEEKS'lik (6 aylık) dilimlere bölünür; her dilim, o dilimden en az EMBARGO_DAYS önce biten veriyle eğitilen
   modelle tahmin edilir. Yani "6 ay önceki hisseyi, sadece o günün bilgisiyle tahmin et" testi yıllar boyunca tekrarlanır.
   Bu tahminler "zaman makinesi" olarak da yayınlanır (geçmişte bir hafta seç: asistan ne derdi, sonra ne oldu).
3) Güvenlik: getiri modeli ancak testte her haftanın "ilk 5" seçimi kural tabanlı seçimden istatistiksel olarak
   anlamlı iyiyse (haftalık fark t >= MIN_EDGE_T) ve ortalamayı geçiyorsa adayları sıralar. Aksi halde önceki
   güvenilir model korunur; o da yoksa sıralama kural tabanlı kalır ve modelin olasılığı sadece bilgi olarak gösterilir.
   Ayrıca "strateji formu" (planların son haftalardaki sonucu) izlenir; form kötüyse pozisyon küçültülür.
4) Fiyat geçmişi her gün büyüdüğü için model her hafta yeni sonuçlarla yeniden eğitilir.
"""
import argparse
import io
import json
import pickle
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd
import requests

from . import assistant, assistant_track
from .config import DATA_DIR, HTTP_HEADERS, INDEX_SYMBOLS, MAIN_INDEX
from . import history
from .prices import load_prices, to_weekly
from .scan import DAILY_WEIGHT, WEEKLY_WEIGHT, scan_universe
from .signals import DAILY, WEEKLY, WEIGHTS, prepare, score_at
from .strength import RS_PERIODS

MODEL_DIR = DATA_DIR / "model"
MODEL_FILE = MODEL_DIR / "model.pkl"
META_FILE = MODEL_DIR / "model.json"        # uygulamada "Asistan nasıl öğreniyor" kartı
SAMPLES_FILE = MODEL_DIR / "samples.parquet"
RETRAIN_DAYS = 6                             # model bu kadar günden eskiyse günlük çalıştırma yeniden eğitir

# Eğitim alanı: canlı süzgeçten biraz geniş (daha çok örnek), ama aynı türden "yükselişteki" hisseler
DOMAIN_MIN_COMBINED = 15
DOMAIN_MAX_RSI = 80
DOMAIN_MIN_RS = 50
MIN_DAILY_IDX = 200
EMBARGO_DAYS = 35            # en uzun işlem (5 gün giriş + 20 gün tutma) ≈ 5 hafta: test öncesi bu kadar veri atılır
FOLD_WEEKS = 26             # 6 aylık test dilimleri
MIN_TRAIN_WEEKS = 26        # ilk test diliminden önce en az bu kadar eğitim verisi
TOP_K = 5                    # her test gününde piyasa başına seçilen aday sayısı (ekonomik test)
MIN_AUC = 0.53
MIN_TRAIN = 2000
# Geçmişte o günkü likidite (evren bugünün likit hisseleri; ABD'de eskiden kuruş hissesi olanlar elensin)
HIST_MIN_PRICE = {"US": 1.0}
HIST_MIN_DOLLAR_VOL = {"US": 1_000_000}
# Canlı süzgecin geçmişte uygulanabilen kısmı (assistant.prefilter): zaman makinesi ve kural karşılaştırması için
LIVE_MIN_COMBINED, LIVE_MIN_RS, LIVE_MAX_RSI = 30, 70, 78
TIMEMACHINE_FILE = MODEL_DIR / "timemachine.json"
# Hız: 10 yıllık geçmişte her haftanın tam analizi hisse başına ~8 sn. Bu yüzden
#  - DENSE_YEARS'tan eski dönemde iki haftada bir örneklenir (son yıllar haftalık),
#  - önceki çalıştırmanın örnekleri saklanır; sadece son REFRESH_WEEKS (sonucu değişebilecek) ve yeni haftalar hesaplanır.
DENSE_YEARS = 3
REFRESH_WEEKS = 10
SAMPLE_COLUMNS_VERSION = 2   # örnek biçimi değişince artırılır (eski örnekler atılır, baştan hesaplanır)
# İlk 10 yıllık hesap bulutta (4 çekirdek) saatler sürer; bir kez yerelde yapılıp GitHub sürüm dosyası olarak yüklendi.
# Önbellekte uyumlu örnek yoksa buradan başlanır, sonra sadece yeni haftalar hesaplanır.
SEED_URL = "https://github.com/albeyrek/trader-asistani/releases/download/learn-seed/samples.parquet"

COMPONENT_KEYS = list(WEIGHTS)
FEATURES = (
    ["mkt_us", "combined_score", "daily_score", "weekly_score", "rsi", "adx", "atr_pct", "vol_ratio",
     "ext_atr", "rr", "risk_pct", "projected", "setup_breakout", "setup_pullback",
     "rs_rating", "ret_1m", "ret_3m", "dist_high",
     "ctx_above50", "ctx_above200", "ctx_idx_above200", "ctx_idx_ret3m"]
    + [f"d_{k}" for k in COMPONENT_KEYS] + [f"w_{k}" for k in COMPONENT_KEYS]
)
FEATURE_TR = {
    "mkt_us": "ABD piyasası", "combined_score": "Teknik skor", "daily_score": "Günlük skor",
    "weekly_score": "Haftalık skor", "rsi": "RSI", "adx": "Trend gücü (ADX)", "atr_pct": "Oynaklık (ATR %)",
    "vol_ratio": "Hacim (20 gün ortalamasına göre)", "ext_atr": "20 günlük ortalamadan uzaklık",
    "rr": "Planın ödül/risk oranı", "risk_pct": "Stop mesafesi (%)", "projected": "Zirvede (üstte direnç yok)",
    "setup_breakout": "Kırılım kurulumu", "setup_pullback": "Geri çekilme kurulumu", "rs_rating": "Göreli güç",
    "ret_1m": "Son 1 ay getirisi", "ret_3m": "Son 3 ay getirisi", "dist_high": "52 haftalık zirveye uzaklık",
    "ctx_above50": "Piyasa genişliği (50 gün ort. üstü %)", "ctx_above200": "Piyasa genişliği (200 gün ort. üstü %)",
    "ctx_idx_above200": "Endeks 200 günlük ortalamanın üstünde", "ctx_idx_ret3m": "Endeksin 3 aylık getirisi",
    "d_breakout": "Günlük kırılım sinyali", "d_vol_spike": "Hacimli hareket", "d_near_52w": "1 yıllık zirveye yakınlık",
    "d_trend_align": "Ortalamaların yükseliş sıralaması", "d_rsi_overbought": "RSI 70 üstü (momentum)",
    "d_macd_cross": "MACD kesişimi", "d_ma_cross": "Golden cross", "w_trend_slow": "Haftalık uzun vadeli trend",
}


def _feature_name(f: str) -> str:
    if f in FEATURE_TR:
        return FEATURE_TR[f]
    tf, key = f.split("_", 1)
    return f"{'Günlük' if tf == 'd' else 'Haftalık'} kural: {key}"


# ------------------------------------------------------------------ özellikler (geçmişte ve canlıda aynı kod)

def row_features(d: pd.DataFrame, t: int, da, wa, plan: dict, market: str) -> dict:
    """Bir hissenin t günündeki özellikleri (göreli güç ve piyasa bağlamı sonradan eklenir)."""
    c = d["close"].to_numpy()
    close = c[t]
    hi52 = float(d["high"].iloc[max(0, t - DAILY.year_bars + 1):t + 1].max())
    vr = d["vol_ratio"].iloc[t]
    out = {
        "mkt_us": 1.0 if market == "US" else 0.0,
        "combined_score": DAILY_WEIGHT * da.score + WEEKLY_WEIGHT * wa.score,
        "daily_score": da.score, "weekly_score": wa.score,
        "rsi": da.metrics["rsi"], "adx": da.metrics["adx"], "atr_pct": da.metrics["atr_pct"],
        "vol_ratio": float(vr) if np.isfinite(vr) else np.nan,
        "ext_atr": plan["ext_atr"], "rr": plan["rr"], "risk_pct": plan["risk_pct"],
        "projected": 1.0 if plan["projected"] else 0.0,
        "setup_breakout": 1.0 if plan["setup"] == "breakout" else 0.0,
        "setup_pullback": 1.0 if plan["setup"] == "pullback" else 0.0,
        "ret_1m": (close / c[t - 21] - 1) * 100 if t >= 21 else np.nan,
        "ret_3m": (close / c[t - 63] - 1) * 100 if t >= 63 else np.nan,
        "dist_high": (close / hi52 - 1) * 100,
    }
    for k in COMPONENT_KEYS:
        out[f"d_{k}"] = float(da.components.get(k, 0.0))
        out[f"w_{k}"] = float(wa.components.get(k, 0.0))
    # Sıfır hacim/fiyat gibi durumlarda sonsuz değer çıkmasın (modelde eksik değer olarak ele alınır)
    return {k: (v if v is None or np.isfinite(v) else np.nan) for k, v in out.items()}


def rule_quality(f: dict) -> float:
    """Kural tabanlı sıralama puanının (assistant._quality) geçmişte hesaplanabilen kısmı: karşılaştırma için."""
    q = 0.35 * f["combined_score"] + 0.35 * f["rs_rating"] + 6 * min(f["rr"], 3)
    return q - 1.5 * max(f["ext_atr"] - 1.5, 0) * 4


def _replay_symbol(args) -> list[dict]:
    sym, market, daily, weekly, since, dense_from = args
    daily = daily.sort_values("date").reset_index(drop=True)
    weekly = weekly.sort_values("date").reset_index(drop=True)
    if len(daily) <= MIN_DAILY_IDX or len(weekly) < WEEKLY.min_bars:
        return []
    d, piv_d = prepare(daily, DAILY)
    w, piv_w = prepare(weekly, WEEKLY)
    dates = daily["date"].to_numpy()
    bars = daily[["date", "open", "high", "low", "close"]]
    closes = daily["close"].to_numpy()
    dollar_vol = (daily["close"] * daily["volume"]).rolling(20, min_periods=10).mean().to_numpy()
    min_px, min_dv = HIST_MIN_PRICE.get(market), HIST_MIN_DOLLAR_VOL.get(market)
    horizon = assistant_track.ENTRY_DAYS + assistant_track.MAX_HOLD
    out = []
    for j in range(WEEKLY.min_bars - 1, len(w)):
        label = w["date"].iloc[j]
        if since is not None and label <= since:
            continue
        # Eski dönemde iki haftada bir (tüm hisselerde aynı haftalar: takvime sabit)
        if label < dense_from and (label.toordinal() // 7) % 2:
            continue
        t = int(np.searchsorted(dates, label.to_datetime64(), side="right")) - 1
        if t < MIN_DAILY_IDX:
            continue
        if (min_px and closes[t] < min_px) or (min_dv and not dollar_vol[t] >= min_dv):
            continue
        da = score_at(d, piv_d, t, DAILY, market)
        if da is None or da.score <= 0 or da.metrics["rsi"] > DOMAIN_MAX_RSI:
            continue
        wa = score_at(w, piv_w, j, WEEKLY, market)
        if wa is None or DAILY_WEIGHT * da.score + WEEKLY_WEIGHT * wa.score < DOMAIN_MIN_COMBINED:
            continue
        plan = assistant.plan_at(d, piv_d, t)
        if plan is None:
            continue
        res = assistant_track.simulate(plan, bars.iloc[t + 1:t + 1 + horizon])
        out.append({
            "yf_symbol": sym, "market": market, "date": pd.Timestamp(dates[t]),
            **row_features(d, t, da, wa, plan, market),
            "status": res["status"], "r": res["r"], "days": res["days"],
            # zaman makinesi için plan ve sonuç ayrıntıları
            "setup": plan["setup"], "close": float(closes[t]), "entry_low": plan["entry_low"],
            "entry_high": plan["entry_high"], "stop": plan["stop"], "target1": plan["target1"],
            "exit_date": res["exit_date"],
            "ret_20": float(closes[t + 20] / closes[t] - 1) * 100 if t + 20 < len(closes) else np.nan,
        })
    return out


def market_context(prices: pd.DataFrame, symbols: dict[str, list[str]]) -> dict[str, pd.DataFrame]:
    """Piyasa başına günlük bağlam: genişlik (50/200 gün ortalaması üstündeki hisse %), endeks trendi.
    Ayrıca her hissenin o günkü göreli güç puanı (strength.compute ile aynı formül)."""
    out = {}
    for market, syms in symbols.items():
        px = (prices[prices["yf_symbol"].isin(syms)]
              .pivot(index="date", columns="yf_symbol", values="close").sort_index().ffill(limit=3))
        sma50 = px.rolling(50, min_periods=50).mean()
        sma200 = px.rolling(200, min_periods=200).mean()
        v50, v200 = sma50.notna(), sma200.notna()
        ctx = pd.DataFrame(index=px.index)
        ctx["ctx_above50"] = ((px > sma50) & v50).sum(axis=1) / v50.sum(axis=1).replace(0, np.nan) * 100
        ctx["ctx_above200"] = ((px > sma200) & v200).sum(axis=1) / v200.sum(axis=1).replace(0, np.nan) * 100
        idx = prices[prices["yf_symbol"] == MAIN_INDEX[market]].set_index("date")["close"].sort_index()
        idx = idx.reindex(px.index).ffill()
        ctx["ctx_idx_above200"] = (idx > idx.ewm(span=200, adjust=False).mean()).astype(float)
        ctx["ctx_idx_ret3m"] = (idx / idx.shift(63) - 1) * 100
        r63 = px / px.shift(63) - 1
        weighted = sum(w * (px / px.shift(n) - 1).fillna(r63) for n, w in RS_PERIODS)
        rs = (weighted.rank(axis=1, pct=True) * 98 + 1).round()
        out[market] = (ctx, rs)
    return out


def attach_context(df: pd.DataFrame, ctx: dict) -> pd.DataFrame:
    parts = []
    for market, g in df.groupby("market"):
        c, rs = ctx[market]
        g = g.join(c, on="date")
        stacked = rs.stack().rename("rs_rating")
        g = g.join(stacked, on=["date", "yf_symbol"])
        parts.append(g)
    return pd.concat(parts, ignore_index=True)


def _previous_samples(meta: pd.DataFrame, limit: int | None) -> pd.DataFrame | None:
    """Önceki çalıştırmanın örnekleri (artımlı hesap için); biçim değiştiyse ya da deneme çalıştırmasıysa None."""
    if limit:
        return None

    def compatible(df: pd.DataFrame) -> bool:
        return "version" in df and len(df) and df["version"].iloc[0] == SAMPLE_COLUMNS_VERSION

    old = pd.read_parquet(SAMPLES_FILE) if SAMPLES_FILE.exists() else None
    if old is None or not compatible(old):
        try:
            r = requests.get(SEED_URL, headers=HTTP_HEADERS, timeout=120)
            r.raise_for_status()
            seed = pd.read_parquet(io.BytesIO(r.content))
            old = seed if compatible(seed) else None
            print(f"Başlangıç örnekleri indirildi: {len(seed):,}" if old is not None else "Başlangıç örnekleri uyumsuz",
                  flush=True)
        except (requests.RequestException, OSError, ValueError) as exc:
            print(f"  ! başlangıç örnekleri alınamadı: {exc}", flush=True)
            return None
    return old[old["yf_symbol"].isin(meta.index)] if old is not None else None


def collect(limit: int | None, workers: int | None, full: bool = False) -> pd.DataFrame:
    meta = scan_universe(None)
    prices = history.load_long() if history.LONG_FILE.exists() else load_prices()
    last = prices["date"].max()
    print(f"Fiyat geçmişi: {prices['date'].min().date()} – {last.date()}", flush=True)
    old = None if full else _previous_samples(meta, limit)
    # Eski örnekler ancak fiyat geçmişini kapsıyorsa kullanılır (ör. 2 yıldan 10 yıla geçince baştan hesaplanır)
    if old is not None and old["date"].min() > prices["date"].min() + pd.Timedelta(days=400):
        old = None
    since = last - pd.Timedelta(weeks=REFRESH_WEEKS) if old is not None and len(old) else None
    dense_from = last - pd.DateOffset(years=DENSE_YEARS)
    print("Artımlı: " + (f"{since.date()} sonrası yeniden hesaplanıyor" if since is not None else "tüm geçmiş hesaplanıyor"),
          flush=True)
    stocks = prices[prices["yf_symbol"].isin(meta.index)]
    if limit:
        keep = stocks["yf_symbol"].drop_duplicates().sample(limit, random_state=1)
        stocks = stocks[stocks["yf_symbol"].isin(keep)]
    weekly = dict(tuple(to_weekly(stocks).groupby("yf_symbol")))
    tasks = [(sym, meta.loc[sym, "market"], g, weekly[sym], since, dense_from)
             for sym, g in stocks.groupby("yf_symbol") if sym in weekly]
    rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for i, res in enumerate(ex.map(_replay_symbol, tasks, chunksize=20), 1):
            rows.extend(res)
            if i % 1000 == 0:
                print(f"  {i}/{len(tasks)} hisse", flush=True)
    df = pd.DataFrame(rows)
    if len(df):
        symbols = {m: meta.index[meta["market"] == m].tolist() for m in INDEX_SYMBOLS}
        df = attach_context(df, market_context(prices, symbols))
        df["symbol"] = df["yf_symbol"].map(meta["symbol"])
        df = df[df["rs_rating"].fillna(0) >= DOMAIN_MIN_RS]
    if since is not None:
        df = pd.concat([old[old["date"] <= since], df], ignore_index=True)
    df["version"] = SAMPLE_COLUMNS_VERSION
    return df.sort_values(["date", "yf_symbol"]).reset_index(drop=True)


# ------------------------------------------------------------------ model
#
# İki ayrı soru öğrenilir:
#   olasılık modeli  : "ilk hedefe stoptan önce ulaşır mı?"  (sınıflandırma; bilgi amaçlı, uygulamada % olarak görünür)
#   getiri modeli    : "plan kaç R kazandırır/kaybettirir?"   (regresyon; testi geçerse adayları o sıralar)
# İlk denemelerde olasılığı yüksek planların ortalamada DAHA AZ kazandırdığı görüldü (yakın hedef = sık ama küçük
# kazanç); bu yüzden sıralama olasılıkla değil, doğrudan beklenen getiriyle yapılır.

def _clf_specs() -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return {
        "logit": lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                                       LogisticRegression(C=0.2, max_iter=3000)),
        "gbm": lambda: HistGradientBoostingClassifier(max_depth=3, learning_rate=0.04, max_iter=250,
                                                      min_samples_leaf=300, l2_regularization=1.0,
                                                      early_stopping=False, random_state=0),
    }


def _reg_specs() -> dict:
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return {
        "ridge": lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=50)),
        "gbr": lambda: HistGradientBoostingRegressor(max_depth=2, learning_rate=0.03, max_iter=200,
                                                     min_samples_leaf=800, l2_regularization=2.0,
                                                     early_stopping=False, random_state=0),
    }


SPEC_TR = {"logit": "lojistik regresyon", "gbm": "gradyan artırmalı karar ağaçları",
           "ridge": "doğrusal (ridge) regresyon", "gbr": "gradyan artırmalı regresyon ağaçları"}
R_CLIP = (-1.5, 4.0)        # aşırı uç sonuçlar (boşluklu açılış, çok büyük kazanç) eğitimi bozmasın
MIN_EDGE_T = 2.0            # getiri modeli: "ilk 5" seçimi haftadan haftaya kurallardan anlamlı iyi olmalı (t >= 2)
FORM_WEEKS = 8              # strateji formu: sonuçlanmış son 8 haftanın ortalama R'si
FORM_LAG_WEEKS = 5          # en uzun işlem ~5 hafta: daha yeni sinyallerin sonucu henüz belli değil


def resolved(df: pd.DataFrame) -> pd.DataFrame:
    """Sonucu belli örnekler. Son EMBARGO_DAYS içindeki sinyaller atılır: onların sadece hızlı sonuçlananları (çoğu stop)
    belli olduğu için eğitimi ve testi kötümser yönde bozarlar."""
    complete = df["date"] <= df["date"].max() - pd.Timedelta(days=EMBARGO_DAYS)
    out = df[complete & df["status"].isin(["target", "stop", "timeout"])].copy()
    out[FEATURES] = out[FEATURES].replace([np.inf, -np.inf], np.nan)
    out["y"] = (out["status"] == "target").astype(int)
    out["rc"] = out["r"].clip(*R_CLIP)
    out["quality"] = [rule_quality(f) for f in out[["combined_score", "rs_rating", "rr", "ext_atr"]].to_dict("records")]
    return out


def _top_r(test: pd.DataFrame, score_col: str) -> float | None:
    """Her test gününde piyasa başına en yüksek puanlı TOP_K kurulumun ortalama R'si."""
    top = test.sort_values(score_col, ascending=False).groupby(["market", "date"]).head(TOP_K)
    return float(top["r"].mean()) if len(top) else None


def _folds(df: pd.DataFrame):
    """Kayan pencereli geçmiş test: sondan geriye FOLD_WEEKS'lik dilimler (fold 0 = en yeni).
    Her dilimin modeli, dilim başlangıcından EMBARGO_DAYS önce biten veriyle eğitilir (geleceği görmez)."""
    first, end = df["date"].min(), df["date"].max()
    k = 0
    while True:
        start = end - pd.Timedelta(weeks=FOLD_WEEKS)
        if start < first + pd.Timedelta(weeks=MIN_TRAIN_WEEKS):
            break
        train = df[df["date"] <= start - pd.Timedelta(days=EMBARGO_DAYS)]
        test = df[(df["date"] > start) & (df["date"] <= end)].copy()
        if len(train) >= MIN_TRAIN and len(test) >= 100 and train["y"].nunique() == 2:
            test["fold"] = k
            yield train, test
        end, k = start, k + 1


def eval_clf(df: pd.DataFrame, spec: str) -> dict:
    from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
    make = _clf_specs()[spec]
    parts = []
    for train, test in _folds(df):
        test["p"] = make().fit(train[FEATURES], train["y"]).predict_proba(test[FEATURES])[:, 1]
        parts.append(test)
    if not parts:
        return {"ok": False}
    oos = pd.concat(parts)
    return {"ok": True, "oos": oos, "auc": float(roc_auc_score(oos["y"], oos["p"])),
            "brier": float(brier_score_loss(oos["y"], oos["p"])), "logloss": float(log_loss(oos["y"], oos["p"])),
            "base_rate": float(oos["y"].mean())}


def eval_reg(df: pd.DataFrame, spec: str) -> dict:
    make = _reg_specs()[spec]
    parts = []
    for train, test in _folds(df):
        test["pred"] = make().fit(train[FEATURES], train["rc"]).predict(test[FEATURES])
        parts.append(test)
    if not parts:
        return {"ok": False}
    oos = pd.concat(parts)
    ics = (oos.groupby(["market", "date"])
           .apply(lambda g: g["pred"].rank().corr(g["r"].rank()) if len(g) >= 10 else np.nan, include_groups=False)
           .dropna())
    return {
        "ok": True, "oos": oos,
        "ic": float(ics.mean()), "ic_t": float(ics.mean() / ics.std() * np.sqrt(len(ics))) if len(ics) > 1 else 0.0,
        "model_top_r": _top_r(oos, "pred"), "rule_top_r": _top_r(oos[live_like(oos)], "quality"),
        "all_r": float(oos["r"].mean()),
        **_weekly_edge(oos),
        "n_test": int(len(oos)), "test_from": oos["date"].min().date().isoformat(),
        "test_to": oos["date"].max().date().isoformat(),
    }


def _weekly_edge(oos: pd.DataFrame) -> dict:
    """Asıl kullanım "her hafta ilk 5": model seçimi ile kural seçimi arasındaki haftalık fark ve anlamlılığı (t).
    Her hafta eşit ağırlıklı (çok kurulumlu haftalar sonucu domine etmesin)."""
    rows = []
    for _, g in oos.groupby(["market", "date"]):
        live = g[live_like(g)]
        if len(live):
            rows.append((g.nlargest(TOP_K, "pred")["r"].mean(), live.nlargest(TOP_K, "quality")["r"].mean(), g["r"].mean()))
    if len(rows) < 10:
        return {"edge": None, "edge_t": None, "weeks": len(rows)}
    m, r, a = (np.array(x) for x in zip(*rows))
    diff = m - r
    return {"edge": round(float(diff.mean()), 4), "edge_t": round(float(diff.mean() / diff.std() * np.sqrt(len(diff))), 2),
            "weeks": len(rows), "wk_model_r": round(float(m.mean()), 4), "wk_rule_r": round(float(r.mean()), 4),
            "wk_all_r": round(float(a.mean()), 4)}


def calibration(oos: pd.DataFrame) -> list[dict]:
    """Tahmin edilen olasılık dilimlerine göre gerçekleşen oran (güvenilirlik eğrisi)."""
    bins = [0, 0.15, 0.25, 0.35, 0.45, 1.0]
    g = oos.groupby(pd.cut(oos["p"], bins), observed=True)
    return [{"from": float(iv.left), "to": float(iv.right), "n": int(len(x)),
             "predicted": round(float(x["p"].mean()) * 100, 1), "actual": round(float(x["y"].mean()) * 100, 1),
             "avg_r": round(float(x["r"].mean()), 3)}
            for iv, x in g if len(x) >= 30]


def strategy_form(data: pd.DataFrame) -> dict:
    """Asistanın planları son dönemde işe yarıyor mu? Geçmiş veride, sonraki haftanın sonucuyla ilişkili çıktı
    (trend takip eden yöntemler bazı dönemlerde topluca çalışmaz)."""
    out = {}
    for market, g in data.groupby("market"):
        last = g["date"].max()
        recent = g[g["date"] > last - pd.Timedelta(weeks=FORM_WEEKS)]
        out[market] = {
            "recent_r": round(float(recent["r"].mean()), 3) if len(recent) else None, "recent_n": int(len(recent)),
            "recent_win": round(float(recent["y"].mean()) * 100, 1) if len(recent) else None,
            "recent_from": (last - pd.Timedelta(weeks=FORM_WEEKS)).date().isoformat(), "recent_to": last.date().isoformat(),
            "long_r": round(float(g["r"].mean()), 3), "long_n": int(len(g)),
            "weekly": [{"w": w.start_time.date().isoformat(), "r": round(float(x["r"].mean()), 3), "n": int(len(x))}
                       for w, x in g.groupby(g["date"].dt.to_period("W"))][-26:],
        }
    return out


def live_like(df: pd.DataFrame) -> pd.Series:
    """Canlı süzgecin geçmişte uygulanabilen kısmı (haber ve bilanço hariç)."""
    return ((df["combined_score"] >= LIVE_MIN_COMBINED) & (df["daily_score"] > 0) & (df["weekly_score"] > 0)
            & (df["rs_rating"] >= LIVE_MIN_RS) & (df["rsi"] <= LIVE_MAX_RSI))


def yearly(oos: pd.DataFrame) -> list[dict]:
    """Yıl yıl geçmiş test: o yılın her haftasında, o tarihe kadarki veriyle eğitilmiş modelin tahmini."""
    from sklearn.metrics import roc_auc_score
    rows = []
    for (market, year), g in oos.groupby(["market", oos["date"].dt.year]):
        live = g[live_like(g)]
        auc = float(roc_auc_score(g["y"], g["p"])) if g["y"].nunique() == 2 else None
        rows.append({
            "market": market, "year": int(year), "n": int(len(g)), "weeks": int(g["date"].nunique()),
            "win": round(float(g["y"].mean()) * 100, 1), "all_r": round(float(g["r"].mean()), 3),
            "rule_top_r": round(_top_r(live, "quality"), 3) if len(live) else None,
            "model_top_r": round(_top_r(g, "pred"), 3),
            "auc": round(auc, 3) if auc is not None else None,
        })
    return rows


def form_test(data: pd.DataFrame) -> dict:
    """Strateji formu kuralı geçmişte işe yaradı mı? Form (sonucu belli son 8 haftanın ortalaması) iyiyken ve kötüyken
    sonraki haftanın ortalama sonucu."""
    out = {}
    for market, g in data.groupby("market"):
        wk = g.groupby(g["date"].dt.to_period("W"))["r"].mean()
        form = wk.shift(FORM_LAG_WEEKS).rolling(FORM_WEEKS, min_periods=4).mean()
        x = pd.DataFrame({"form": form, "next": wk}).dropna()
        good, bad = x[x["form"] > 0]["next"], x[x["form"] <= 0]["next"]
        out[market] = {"weeks": int(len(x)), "good_weeks": int(len(good)), "bad_weeks": int(len(bad)),
                       "good_next_r": round(float(good.mean()), 3) if len(good) else None,
                       "bad_next_r": round(float(bad.mean()), 3) if len(bad) else None}
    return out


def _tm_pick(r) -> dict:
    return {"s": r.symbol, "setup": r.setup, "close": round(r.close, 4), "el": r.entry_low, "eh": r.entry_high,
            "stop": r.stop, "t1": r.target1, "rr": round(r.rr, 2), "rs": int(r.rs_rating), "p": round(float(r.p), 3),
            "pred": round(float(r.pred), 2), "status": r.status, "r": round(float(r.r), 2), "days": int(r.days),
            "ret20": round(float(r.ret_20), 1) if pd.notna(r.ret_20) else None}


def timemachine(oos: pd.DataFrame) -> dict:
    """Zaman makinesi: geçmişteki her hafta için asistanın (kurallar) ve modelin seçeceği ilk TOP_K kurulum ve sonucu.
    Tahminler o tarihten önceki veriyle eğitilmiş modelden gelir (geleceği görmeden)."""
    out: dict = {}
    for (market, date), g in oos.groupby(["market", "date"]):
        live = g[live_like(g)].sort_values("quality", ascending=False).head(TOP_K)
        model = g.sort_values("pred", ascending=False).head(TOP_K)
        out.setdefault(str(date.year), {}).setdefault(market, []).append({
            "date": date.date().isoformat(), "n": int(len(g)), "all_r": round(float(g["r"].mean()), 3),
            "win": round(float(g["y"].mean()) * 100, 1),
            "rule": [_tm_pick(r) for r in live.itertuples()], "model": [_tm_pick(r) for r in model.itertuples()],
        })
    return out


def insights(model, test: pd.DataFrame, data: pd.DataFrame) -> list[dict]:
    """Olasılık modeli en çok neye bakıyor? Permütasyon önemi (görülmemiş test verisinde) + geçmişte gerçekleşenler."""
    from sklearn.inspection import permutation_importance
    sample = test.sample(min(len(test), 6000), random_state=0)
    imp = permutation_importance(model, sample[FEATURES], sample["y"], scoring="neg_log_loss", n_repeats=3,
                                 random_state=0)
    out = []
    for i in np.argsort(-imp.importances_mean)[:10]:
        f = FEATURES[i]
        if imp.importances_mean[i] <= 0:
            break
        x = data[[f, "y", "r"]].dropna()
        if x[f].nunique() <= 3:  # 0/1 (ya da -1/0/1) özellik: var / yok
            hi, lo = x[x[f] > 0], x[x[f] <= 0]
            hi_text, lo_text = "varken", "yokken"
        else:
            q20, q80 = x[f].quantile([0.2, 0.8])
            hi, lo = x[x[f] >= q80], x[x[f] <= q20]
            hi_text, lo_text = "yüksekken", "düşükken"
        if len(hi) < 50 or len(lo) < 50:
            continue
        hw, lw, hr, lr = hi["y"].mean() * 100, lo["y"].mean() * 100, hi["r"].mean(), lo["r"].mean()
        out.append({
            "feature": f, "name": _feature_name(f), "importance": round(float(imp.importances_mean[i]) * 1000, 2),
            "hi": round(float(hw), 1), "lo": round(float(lw), 1), "hi_r": round(float(hr), 3), "lo_r": round(float(lr), 3),
            "text": (f"{_feature_name(f)} {hi_text} hedefe ulaşma %{hw:.0f} (ortalama {hr:+.2f}R), "
                     f"{lo_text} %{lw:.0f} (ortalama {lr:+.2f}R)").replace(".", ","),
        })
    return out[:6]


def breadth_bucket(above50: float | None) -> str:
    if above50 is None or not np.isfinite(above50):
        return "bilinmiyor"
    return "güçlü" if above50 >= 60 else "zayıf" if above50 < 40 else "orta"


def setup_stats(data: pd.DataFrame) -> list[dict]:
    """Benzer kurulumların geçmiş başarısı: piyasa x kurulum x piyasa genişliği."""
    d = data.copy()
    d["setup"] = np.where(d["setup_breakout"] > 0, "breakout", np.where(d["setup_pullback"] > 0, "pullback", "trend"))
    d["breadth"] = d["ctx_above50"].map(breadth_bucket)
    rows = []
    for (m, s, b), g in d.groupby(["market", "setup", "breadth"]):
        if len(g) < 30:
            continue
        rows.append({"market": m, "setup": s, "breadth": b, "n": int(len(g)),
                     "win": round(float(g["y"].mean()) * 100, 1), "avg_r": round(float(g["r"].mean()), 2)})
    return rows


def _logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def recalibration(oos: pd.DataFrame) -> dict[str, float]:
    """Kendini düzeltme: son test döneminde (model görmemişti) tahmin edilen ve gerçekleşen hedefe ulaşma oranı
    arasındaki fark, piyasa başına log-odds kayması olarak saklanır ve canlı olasılıklara uygulanır.
    (Piyasa ortamı değişince model sistematik olarak iyimser/kötümser kalabiliyor.)"""
    last = oos[oos["fold"] == 0]
    out = {}
    for market, g in last.groupby("market"):
        if len(g) >= 30 and 0 < g["y"].mean() < 1:
            raw = float(_logit(g["y"].mean()) - _logit(g["p"].to_numpy()).mean())
            # Az örnekle ya da tek bir uç dönemle aşırı düzeltme olmasın: örnek sayısıyla küçült, ±MAX_OFFSET ile sınırla
            out[market] = round(float(np.clip(raw * len(g) / (len(g) + OFFSET_SHRINK_N), -MAX_OFFSET, MAX_OFFSET)), 4)
    return out


OFFSET_SHRINK_N = 500
MAX_OFFSET = 1.0


def apply_offset(p: float, offset: float) -> float:
    return float(1 / (1 + np.exp(-(_logit(p) + offset))))


def load_model() -> dict | None:
    try:
        with open(MODEL_FILE, "rb") as fh:
            m = pickle.load(fh)
        return m if m.get("features") == FEATURES and "reg" in m else None  # özellikler değiştiyse kullanılamaz
    except Exception:  # dosya yok ya da sklearn sürümü değişti
        return None


def _round(d: dict) -> dict:
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items() if k not in ("oos", "ok")}


def train(df: pd.DataFrame) -> dict:
    """Aday modelleri ileriye dönük testle karşılaştırır, en iyilerini tüm veriyle yeniden eğitir.
    Getiri modeli testi geçemezse (ve önceki güvenilir model yoksa) sıralama kural tabanlı kalır."""
    data = resolved(df)
    clf = {s: eval_clf(data, s) for s in _clf_specs()}
    reg = {s: eval_reg(data, s) for s in _reg_specs()}
    for s, r in clf.items():
        if r["ok"]:
            print(f"  olasılık/{s}: AUC {r['auc']:.3f}  logloss {r['logloss']:.4f}")
    for s, r in reg.items():
        if r["ok"]:
            print(f"  getiri/{s}: IC {r['ic']:+.3f} (t {r['ic_t']:.1f})  model ilk {TOP_K}: {r['model_top_r']:+.3f}R  "
                  f"kural ilk {TOP_K}: {r['rule_top_r']:+.3f}R  tümü {r['all_r']:+.3f}R  (test {r['n_test']}) | "
                  f"haftalık fark {r['edge']:+.3f}R t {r['edge_t']:.2f} ({r['weeks']} hafta)")
    clf = {s: r for s, r in clf.items() if r["ok"]}
    reg = {s: r for s, r in reg.items() if r["ok"]}
    if not clf or not reg:
        raise RuntimeError("Model eğitimi için yeterli veri yok")
    best_clf = min(clf, key=lambda s: clf[s]["logloss"])
    best_reg = max(reg, key=lambda s: reg[s]["edge_t"] if reg[s]["edge_t"] is not None else -99)
    rw = reg[best_reg]
    reliable = bool(rw["edge_t"] is not None and rw["edge_t"] >= MIN_EDGE_T and rw["wk_model_r"] > rw["wk_all_r"])

    # Olasılık ve getiri tahminlerini aynı satırlarda birleştir (yıllık sonuçlar ve zaman makinesi için)
    oos = rw["oos"].join(clf[best_clf]["oos"][["p"]], how="inner")
    TIMEMACHINE_FILE.parent.mkdir(parents=True, exist_ok=True)
    TIMEMACHINE_FILE.write_text(json.dumps(timemachine(oos), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # "Model neye bakıyor" analizi: son test dönemini görmemiş olasılık modeli ile
    last_test = clf[best_clf]["oos"][clf[best_clf]["oos"]["fold"] == 0]
    fold_train = data[data["date"] <= last_test["date"].min() - pd.Timedelta(days=EMBARGO_DAYS + 7)]
    fold_clf = _clf_specs()[best_clf]().fit(fold_train[FEATURES], fold_train["y"])

    now = pd.Timestamp.now(tz="UTC")
    candidate = {
        "features": FEATURES, "trained_at": now.isoformat(), "trained_until": data["date"].max().date().isoformat(),
        "n": int(len(data)), "reliable": reliable,
        "clf_spec": best_clf, "clf": _clf_specs()[best_clf]().fit(data[FEATURES], data["y"]),
        "reg_spec": best_reg, "reg": _reg_specs()[best_reg]().fit(data[FEATURES], data["rc"]),
        "metrics": {"clf": _round(clf[best_clf]), "reg": _round(rw)},
        "clf_offset": recalibration(clf[best_clf]["oos"]),
    }
    previous = load_model()
    old_meta = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else {}
    if reliable or previous is None or not previous.get("reliable"):
        champion = candidate
        decision = "getiri modeli testi geçti, sıralamayı devraldı" if reliable else \
            "getiri modeli henüz kurallardan iyi değil; sıralama kural tabanlı"
    else:
        champion = previous
        decision = "yeni model testi geçemedi; önceki güvenilir model korundu"
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if champion is candidate:
        with open(MODEL_FILE, "wb") as fh:
            pickle.dump(candidate, fh)

    history = old_meta.get("history", []) + [{
        "trained_at": now.isoformat(), "n": int(len(data)), "auc": round(clf[best_clf]["auc"], 4),
        "ic": round(rw["ic"], 4), "model_top_r": round(rw["model_top_r"], 3) if rw["model_top_r"] is not None else None,
        "rule_top_r": round(rw["rule_top_r"], 3) if rw["rule_top_r"] is not None else None,
        "all_r": round(rw["all_r"], 3), "reliable": reliable, "decision": decision,
    }]
    meta = {
        "trained_at": champion["trained_at"], "trained_until": champion["trained_until"],
        "n_samples": champion["n"], "reliable": champion["reliable"],
        "clf_spec": champion["clf_spec"], "reg_spec": champion["reg_spec"],
        "spec_text": f"olasılık: {SPEC_TR[champion['clf_spec']]}, getiri: {SPEC_TR[champion['reg_spec']]}",
        "metrics": champion["metrics"],
        "period": {"from": data["date"].min().date().isoformat(), "to": data["date"].max().date().isoformat()},
        "by_market": {m: {"n": int(len(g)), "win": round(float(g["y"].mean()) * 100, 1),
                          "avg_r": round(float(g["r"].mean()), 3)} for m, g in data.groupby("market")},
        "calibration": calibration(clf[best_clf]["oos"]),
        "clf_offset": champion.get("clf_offset", {}),
        "insights": insights(fold_clf, last_test, data),
        "setup_stats": setup_stats(data),
        "form": strategy_form(data),
        "form_test": form_test(data),
        "yearly": yearly(oos),
        "oos_period": {"from": oos["date"].min().date().isoformat(), "to": oos["date"].max().date().isoformat(),
                       "n": int(len(oos)), "folds": int(oos["fold"].nunique())},
        "candidates": {"clf": {s: _round(r) for s, r in clf.items()}, "reg": {s: _round(r) for s, r in reg.items()}},
        "history": history[-52:],
        "last_decision": decision,
    }
    META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Olasılık: {best_clf}, getiri: {best_reg} -> {decision}")
    return meta


def model_age_days() -> float | None:
    if not META_FILE.exists():
        return None
    meta = json.loads(META_FILE.read_text(encoding="utf-8"))
    return (pd.Timestamp.now(tz="UTC") - pd.Timestamp(meta["trained_at"])).total_seconds() / 86400


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, help="Test için rastgele N hisse")
    p.add_argument("--workers", type=int)
    p.add_argument("--reuse", action="store_true", help="Kayıtlı örneklerle sadece modeli eğit")
    p.add_argument("--full", action="store_true", help="Önceki örnekleri kullanma, tüm geçmişi baştan hesapla")
    args = p.parse_args()
    t0 = time.time()
    if args.reuse and SAMPLES_FILE.exists():
        df = pd.read_parquet(SAMPLES_FILE)
    else:
        df = collect(args.limit, args.workers, args.full)
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        df.to_parquet(SAMPLES_FILE, index=False)
    print(f"{len(df):,} örnek ({df['status'].value_counts().to_dict()}) — {time.time() - t0:.0f} sn", flush=True)
    train(df)
    print(f"Toplam {time.time() - t0:.0f} sn")


if __name__ == "__main__":
    main()


# ------------------------------------------------------------------ canlı kullanım (assistant.py)

FORM_SCALE = 0.5   # strateji formu negatifse pozisyon çarpanı
FORM_LIMIT = 2     # ... ve en fazla bu kadar aday
FORM_MIN_GAP = 0.05       # temkin modu ancak geçmiş testte "form iyi" ile "form kötü" sonrası fark en az bu kadarsa
FORM_MIN_BAD_WEEKS = 30   # ... ve yeterince "form kötü" hafta varsa uygulanır (yoksa sadece bilgi)


class Scorer:
    """Günün adayları için öğrenen modelin tahmini. Model yoksa ya da yüklenemezse active=False."""

    def __init__(self, prices: pd.DataFrame, scan: pd.DataFrame):
        self.model = load_model()
        self.meta = json.loads(META_FILE.read_text(encoding="utf-8")) if META_FILE.exists() else None
        self.active = self.model is not None
        self.reliable = bool(self.active and self.model.get("reliable"))
        self.ctx: dict = {}
        if self.active:
            symbols = {m: g["yf_symbol"].tolist() for m, g in scan.groupby("market")}
            self.ctx = {m: c.iloc[-1].to_dict() for m, (c, _) in market_context(prices, symbols).items()}

    def form(self, market: str) -> dict | None:
        """Strateji formu (son 8 haftanın sonuçlanmış planları); veri yoksa None.
        "effective": bu piyasada form kuralı geçmiş testte işe yaradı mı (temkin modu ancak o zaman uygulanır)."""
        f = (self.meta or {}).get("form", {}).get(market)
        if not f or f.get("recent_r") is None or f["recent_n"] < 30:
            return None
        t = (self.meta or {}).get("form_test", {}).get(market) or {}
        good, bad = t.get("good_next_r"), t.get("bad_next_r")
        effective = (good is not None and bad is not None and good - bad >= FORM_MIN_GAP
                     and t.get("bad_weeks", 0) >= FORM_MIN_BAD_WEEKS)
        return {**f, "effective": bool(effective), "test": t}

    def predict(self, d: pd.DataFrame, t: int, da, wa, plan: dict, market: str, rs_rating: float) -> dict | None:
        if not self.active or da is None or wa is None:
            return None
        f = {**row_features(d, t, da, wa, plan, market), "rs_rating": float(rs_rating), **self.ctx.get(market, {})}
        x = pd.DataFrame([f])[FEATURES]
        p = apply_offset(float(self.model["clf"].predict_proba(x)[0, 1]), self.model.get("clf_offset", {}).get(market, 0.0))
        exp_r = float(np.clip(self.model["reg"].predict(x)[0], *R_CLIP)) if self.reliable else None
        similar = None
        if self.meta:
            bucket = breadth_bucket(f.get("ctx_above50"))
            similar = next((s for s in self.meta.get("setup_stats", [])
                            if s["market"] == market and s["setup"] == plan["setup"] and s["breadth"] == bucket), None)
        return {"p": round(p, 3), "exp_r": round(exp_r, 2) if exp_r is not None else None,
                "similar": similar, "reliable": self.reliable}
