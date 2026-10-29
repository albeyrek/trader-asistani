"""Hisse evreni: ABD (NASDAQ/NYSE/AMEX) ve BIST hisse listelerini ücretsiz kaynaklardan çeker."""
import io
import re

import pandas as pd
import requests

from .config import DATA_DIR, HTTP_HEADERS

NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
BIST_URL = "https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/Temel-Degerler-Ve-Oranlar.aspx"

# Hisse olmayan menkul kıymetleri (varant, birim, rüçhan, tahvil, imtiyazlı vb.) ayıklamak için
EXCLUDE_NAME = re.compile(
    r"\b(?:warrants?|units?|rights?|preferred|notes?|debentures?|subordinated|fund)\b|%",
    re.IGNORECASE,
)
OTHER_EXCHANGES = {"N": "NYSE", "A": "AMEX", "P": "ARCA", "Z": "BATS", "V": "IEX"}


def _read_pipe(url: str) -> pd.DataFrame:
    text = requests.get(url, headers=HTTP_HEADERS, timeout=60).text
    # Son satır "File Creation Time" bilgisidir
    lines = [ln for ln in text.splitlines() if not ln.startswith("File Creation Time")]
    return pd.read_csv(io.StringIO("\n".join(lines)), sep="|", dtype=str, keep_default_na=False)


def fetch_us() -> pd.DataFrame:
    nas = _read_pipe(NASDAQ_URL)
    nas = nas[(nas["ETF"] == "N") & (nas["Test Issue"] == "N")]
    nas = pd.DataFrame({"symbol": nas["Symbol"], "name": nas["Security Name"], "exchange": "NASDAQ"})

    oth = _read_pipe(OTHER_URL)
    oth = oth[(oth["ETF"] == "N") & (oth["Test Issue"] == "N")]
    oth = pd.DataFrame({
        "symbol": oth["ACT Symbol"],
        "name": oth["Security Name"],
        "exchange": oth["Exchange"].map(OTHER_EXCHANGES).fillna("OTHER"),
    })

    us = pd.concat([nas, oth], ignore_index=True)
    us = us[~us["name"].str.contains(EXCLUDE_NAME)]
    # "$" içeren semboller imtiyazlı/özel sınıflardır
    us = us[~us["symbol"].str.contains(r"[\$\^]", regex=True)]
    us["yf_symbol"] = us["symbol"].str.replace(".", "-", regex=False)
    us["market"] = "US"
    us["sector"] = ""
    return us.drop_duplicates("symbol")


def fetch_bist() -> pd.DataFrame:
    html = requests.get(BIST_URL, headers=HTTP_HEADERS, timeout=60).text
    tables = pd.read_html(io.StringIO(html), attrs={"id": "summaryBasicData"})
    t = tables[0].iloc[:, :3]
    t.columns = ["symbol", "name", "sector"]
    t = t.dropna(subset=["symbol"])
    t["symbol"] = t["symbol"].astype(str).str.strip()
    t = t[t["symbol"].str.fullmatch(r"[A-Z0-9]+")]
    t["yf_symbol"] = t["symbol"] + ".IS"
    t["exchange"] = "BIST"
    t["market"] = "BIST"
    return t.drop_duplicates("symbol")


def build_universe() -> pd.DataFrame:
    df = pd.concat([fetch_us(), fetch_bist()], ignore_index=True)
    df = df[["market", "exchange", "symbol", "yf_symbol", "name", "sector"]]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(DATA_DIR / "universe.csv", index=False, encoding="utf-8")
    return df


def load_universe() -> pd.DataFrame:
    return pd.read_csv(DATA_DIR / "universe.csv", dtype=str, keep_default_na=False)
