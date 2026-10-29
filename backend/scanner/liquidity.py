"""Likidite filtresi: düşük hacimli ve kuruş hisseleri eler (teknik sinyaller bunlarda güvenilmez)."""
import pandas as pd

from .config import MIN_AVG_TURNOVER, MIN_PRICE


def liquidity_table(prices: pd.DataFrame, universe: pd.DataFrame, window: int = 20) -> pd.DataFrame:
    recent = prices.sort_values("date").groupby("yf_symbol").tail(window).copy()
    recent["turnover"] = recent["close"] * recent["volume"]
    stats = recent.groupby("yf_symbol").agg(
        last_date=("date", "max"),
        last_close=("close", "last"),
        avg_turnover=("turnover", "mean"),
        bars=("close", "size"),
    ).reset_index()
    stats = stats.merge(universe[["yf_symbol", "market", "symbol", "name", "sector"]], on="yf_symbol")
    min_turn = stats["market"].map(MIN_AVG_TURNOVER)
    min_price = stats["market"].map(MIN_PRICE)
    stats["liquid"] = (stats["avg_turnover"] >= min_turn) & (stats["last_close"] >= min_price) & (stats["bars"] >= window)
    return stats
