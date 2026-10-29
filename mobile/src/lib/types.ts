export type Market = 'BIST' | 'US';
export type Level = 'Düşük' | 'Orta' | 'Yüksek';
export type Outlook = 'Güçlü Yükseliş' | 'Yükseliş' | 'Nötr' | 'Düşüş' | 'Güçlü Düşüş';

export interface StockSummary {
  symbol: string;
  market: Market;
  name: string;
  sector: string;
  close: number;
  change_pct: number;
  combined_score: number;
  daily_score: number;
  weekly_score: number | null;
  outlook: Outlook;
  overall_risk: Level;
  volatility: Level;
  news_score: number | null;
  news_risk: Level;
  at_new_high: boolean;
  at_new_low: boolean;
  alerts: string[];
}

export interface RiskFlag {
  category: string;
  count: number;
  severe: boolean;
  latest: { title: string; url: string; date: string | null; source: string } | null;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  sentiment: number;
  date: string | null;
  categories: string[];
  kap_subject: string | null;
}

export interface Bar {
  d: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ema_fast: number | null;
  ema_mid: number | null;
  ema_slow: number | null;
}

export interface PriceLevel {
  price: number;
  touches: number;
  dist_pct: number;
  last_date: string;
}

export interface TrendLine {
  kind: 'support' | 'resistance';
  start: { d: string; price: number };
  end: { d: string; price: number };
  slope_pct: number;
  touches: number;
  broken: boolean;
  dist_pct: number;
}

export interface LevelSet {
  supports: PriceLevel[];
  resistances: PriceLevel[];
  trendlines: TrendLine[];
}

export type PerformanceKey = '1H' | '1A' | '3A' | '6A' | '1Y';

export interface Reliability {
  level: Level;
  note: string;
}

export interface StockDetail extends StockSummary {
  date: string;
  daily_outlook: Outlook;
  weekly_outlook: Outlook | null;
  rsi: number;
  adx: number | null;
  atr_pct: number;
  support: number | null;
  resistance: number | null;
  stop: number;
  target: number | null;
  risk_reward: number | null;
  max_drawdown_1y_pct: number;
  high_52w: number;
  low_52w: number;
  weekly_support: number | null;
  weekly_resistance: number | null;
  daily_reasons: string[];
  weekly_reasons: string[];
  risk_flags: RiskFlag[];
  circuit_breakers: number | null;
  chart_daily: Bar[];
  chart_weekly: Bar[];
  // Grafik asistanı (eski veride olmayabilir)
  levels_daily?: LevelSet;
  levels_weekly?: LevelSet;
  performance?: Record<PerformanceKey, number | null>;
  insights?: string[];
  news: NewsItem[];
  reliability: Reliability | null;
}

export interface IndexSnapshot {
  symbol: string;
  name: string;
  close: number;
  date: string;
  chg_1d: number | null;
  chg_1m: number | null;
  chg_3m: number | null;
  chg_1y: number | null;
  above_ema200: boolean;
  ema50_rising: boolean;
}

export interface MarketRegime {
  score: number; // -5..+5
  label: 'Boğa' | 'Temkinli boğa' | 'Nötr' | 'Zayıf' | 'Ayı';
  summary: string;
  factors: { text: string; signal: number }[];
}

export interface MarketData {
  index_name: string;
  regime: MarketRegime;
  indices: IndexSnapshot[];
  breadth: {
    pct_above_50: number;
    pct_above_200: number;
    advancers: number;
    decliners: number;
    new_highs: number;
    new_lows: number;
    median_1m: number | null;
    stocks: number;
  };
  breadth_history: { d: string; a50: number; a200: number }[];
  outlook: Partial<Record<Outlook, number>>;
  chart: Bar[];
}

export type MarketOverview = Partial<Record<Market, MarketData>>;

export interface Meta {
  last_date: string;
  updated_at: string;
  counts: Record<Market, number>;
  reliability: Record<Market, Reliability>;
  disclaimer: string;
}
