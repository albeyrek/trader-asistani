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
  earnings_date?: string | null;
  earnings_status?: EarningsStatus | null;
  rs_rating?: number | null; // 1-99
  rs_3m?: number | null; // endekse göre 3 aylık fazla getiri (%)
  pe?: number | null;
  pb?: number | null;
  market_cap?: number | null; // BIST: mn TL, ABD: mn $
  free_float?: number | null;
  rsi?: number | null;
  atr_pct?: number | null;
}

export interface Fundamentals {
  pe?: number | null;
  ev_ebitda?: number | null;
  ev_sales?: number | null;
  pb?: number | null;
  market_cap?: number | null;
  market_cap_usd?: number | null;
  cap_unit?: string;
  free_float?: number | null;
  period?: string | null;
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
}

export interface SectorRow {
  sector: string;
  count: number;
  ret_1m: number;
  ret_3m: number;
  rs: number | null;
  above200: number;
  score: number;
  leaders: string[];
  rank: number;
  of?: number;
}

export type EarningsStatus = 'expected' | 'estimated' | 'reported';

export interface EarningsEvent {
  date: string;
  status: EarningsStatus;
  source: string;
  time?: string | null;
  eps_forecast?: string | null;
  period?: string | null;
  last_year?: string;
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
  event?: EarningsEvent | null;
  fundamentals?: Fundamentals | null;
  fundamental_flags?: string[];
  sector_info?: SectorRow | null;
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
  sectors?: SectorRow[];
  chart: Bar[];
}

export type MarketOverview = Partial<Record<Market, MarketData>>;

export interface HorizonStat {
  n: number;
  avg_excess: number | null; // piyasa medyanına göre ortalama fazla getiri (%)
  hit: number | null; // isabet oranı (%): yükselişte medyanı geçen, düşüşte geride kalan
}

export interface ScorecardMarket {
  snapshots: number;
  first_date: string | null;
  last_date: string | null;
  up: Record<'h5' | 'h10' | 'h20', HorizonStat>;
  down: Record<'h5' | 'h10' | 'h20', HorizonStat>;
  recent: {
    date: string;
    days: number;
    up: { symbol: string; ret: number; excess: number }[];
    down: { symbol: string; ret: number; excess: number }[];
  }[];
}

export type Scorecard = Partial<Record<Market, ScorecardMarket>>;

export interface Meta {
  last_date: string;
  updated_at: string;
  counts: Record<Market, number>;
  reliability: Record<Market, Reliability>;
  disclaimer: string;
}

// ------------------------------------------------------------------ asistan

export type SetupKind = 'breakout' | 'pullback' | 'trend';

export interface AssistantCheck {
  label: string;
  ok: boolean;
  text: string;
}

/** Günün alım adayı ve işlem planı (backend/scanner/assistant.py). */
export interface Candidate {
  symbol: string;
  market: Market;
  name: string;
  sector: string | null;
  close: number;
  change_pct: number | null;
  combined_score: number;
  rs_rating: number;
  rsi: number;
  setup: SetupKind;
  setup_text: string;
  entry_low: number;
  entry_high: number;
  stop: number;
  target1: number;
  target2: number;
  rr: number;
  risk_pct: number;
  projected: boolean; // zirvede: hedefler stop mesafesinin katları
  quality: number;
  checks: AssistantCheck[];
  reasons: string[];
  news: { title: string; url: string; source: string; sentiment: number; date: string | null }[];
  earnings_date: string | null;
  earnings_status: EarningsStatus | null;
  commentary: string; // kural tabanlı yorum
  ai?: string; // yapay zekâ yorumu (bulut bekçisi ekler)
  model?: ModelPrediction | null;
}

/** Öğrenen modelin aday için tahmini (backend/scanner/learn.py). */
export interface ModelPrediction {
  p: number; // ilk hedefe stoptan önce ulaşma olasılığı (0-1)
  exp_r: number | null; // beklenen getiri (R; 1R = stop mesafesi); getiri modeli testi geçmediyse null
  similar: { market: Market; setup: SetupKind; breadth: string; n: number; win: number; avg_r: number } | null;
  reliable: boolean; // model ileriye dönük testi geçti mi
}

export type RadarItem = Pick<Candidate,
  'symbol' | 'market' | 'name' | 'close' | 'change_pct' | 'rs_rating' | 'setup' | 'setup_text' | 'entry_low' |
  'entry_high' | 'stop' | 'target1' | 'rr' | 'risk_pct' | 'quality' | 'model'>;

export interface AssistantMarket {
  date: string;
  regime: { label: MarketRegime['label']; score: number; summary: string };
  risk_scale: number; // önerilen pozisyon çarpanı (zayıf piyasada 0,5)
  stance: string;
  screened: number;
  passed_filter: number;
  with_plan: number;
  candidates: Candidate[];
  radar: RadarItem[];
  ranking?: 'model' | 'rules'; // sıralamayı öğrenen model mi, kurallar mı yaptı
  /** Strateji formu: asistanın planları son 8 haftada (geçmiş veride) ne kazandırdı; negatifse temkin modu */
  form?: { recent_r: number; recent_n: number; recent_win: number | null; long_r: number; long_n: number;
    effective?: boolean } | null;
}

export interface AssistantData {
  version: string;
  generated_at: string;
  markets: Partial<Record<Market, AssistantMarket>>;
  disclaimer: string;
  ai_model?: string | null;
}

export type TradeStatus = 'pending' | 'not_filled' | 'open' | 'target' | 'stop' | 'timeout';

export interface AssistantTrade {
  date: string;
  symbol: string;
  setup: SetupKind;
  regime: string | null;
  planned_rr: number | null;
  status: TradeStatus;
  days: number;
  r: number | null;
  fill: number | null;
  exit: number | null;
  exit_date: string | null;
}

export interface AssistantScoreMarket {
  snapshots: number;
  first_date: string | null;
  signals: number;
  filled: number;
  not_filled: number;
  open: number;
  closed: number;
  targets: number;
  stops: number;
  timeouts: number;
  win_rate: number | null;
  avg_r: number | null;
  total_r: number | null;
  trades: AssistantTrade[];
}

export type AssistantScore = Partial<Record<Market, AssistantScoreMarket>>;

/** Öğrenen modelin özeti (model.json): haftalık eğitim, ileriye dönük test sonuçları, öğrenilenler. */
export interface ModelMeta {
  trained_at: string;
  trained_until: string;
  n_samples: number;
  reliable: boolean; // getiri modeli testi geçti mi (geçtiyse adayları o sıralar)
  spec_text: string;
  metrics: {
    clf: { auc: number; brier: number; logloss: number; base_rate: number };
    reg: {
      ic: number;
      ic_t: number;
      edge?: number | null; // haftalık "ilk 5" farkı: model - kurallar (R)
      edge_t?: number | null; // farkın anlamlılığı (t)
      weeks?: number;
      wk_model_r?: number;
      wk_rule_r?: number;
      wk_all_r?: number;
      model_top_r: number | null;
      rule_top_r: number | null;
      all_r: number;
      n_test: number;
      test_from: string;
      test_to: string;
    };
  };
  period: { from: string; to: string };
  by_market: Partial<Record<Market, { n: number; win: number; avg_r: number }>>;
  calibration: { from: number; to: number; n: number; predicted: number; actual: number; avg_r: number }[];
  clf_offset: Partial<Record<Market, number>>;
  insights: { feature: string; name: string; importance: number; hi: number; lo: number; text: string }[];
  form: Partial<Record<Market, {
    recent_r: number | null;
    recent_n: number;
    recent_win: number | null;
    recent_from: string;
    recent_to: string;
    long_r: number;
    long_n: number;
    weekly: { w: string; r: number; n: number }[];
  }>>;
  yearly?: YearRow[];
  form_test?: Partial<Record<Market, { weeks: number; good_weeks: number; bad_weeks: number;
    good_next_r: number | null; bad_next_r: number | null }>>;
  oos_period?: { from: string; to: string; n: number; folds: number };
  history: { trained_at: string; n: number; auc: number; ic: number; model_top_r: number | null;
    rule_top_r: number | null; all_r: number; reliable: boolean; decision: string }[];
  last_decision: string;
}

// ------------------------------------------------------------------ zaman makinesi

/** Geçmişte bir haftada seçilen kurulum ve sonrasında olan (backend/scanner/learn.py timemachine). */
export interface TmPick {
  s: string; // hisse kodu
  setup: SetupKind;
  close: number;
  el: number; // giriş aralığı alt
  eh: number; // giriş aralığı üst
  stop: number;
  t1: number;
  rr: number;
  rs: number;
  p: number; // o günkü modelin hedefe ulaşma olasılığı (o tarihten önceki veriyle eğitilmiş)
  pred: number; // o günkü modelin beklenen getiri tahmini (R)
  status: TradeStatus;
  r: number;
  days: number;
  ret20: number | null; // 20 işlem günü sonraki fiyat değişimi (%)
}

export interface TmWeek {
  date: string;
  n: number; // o hafta plan çıkan kurulum sayısı
  all_r: number;
  win: number;
  rule: TmPick[]; // asistanın (kurallar) ilk 5'i
  model: TmPick[]; // modelin ilk 5'i
}

export type TmYear = Partial<Record<Market, TmWeek[]>>;

export interface YearRow {
  market: Market;
  year: number;
  n: number;
  weeks: number;
  win: number;
  all_r: number;
  rule_top_r: number | null;
  model_top_r: number | null;
  auc: number | null;
}
