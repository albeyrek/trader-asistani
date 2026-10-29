// Tarama filtreleri: hazır stratejiler ve kullanıcının kaydettiği özel filtreler (telefonda süzülür).

import type { Level, Outlook, StockSummary } from './types';

export type NumField =
  | 'combined_score' | 'daily_score' | 'weekly_score' | 'rs_rating' | 'rsi' | 'pe' | 'pb'
  | 'free_float' | 'atr_pct' | 'change_pct' | 'news_score';

export const NUM_FIELDS: { key: NumField; label: string; hint?: string }[] = [
  { key: 'combined_score', label: 'Birleşik skor', hint: '-100…100' },
  { key: 'daily_score', label: 'Kısa vade skoru', hint: '-100…100' },
  { key: 'weekly_score', label: 'Orta vade skoru', hint: '-100…100' },
  { key: 'rs_rating', label: 'Göreli güç (RS)', hint: '1…99' },
  { key: 'rsi', label: 'RSI (günlük)', hint: '0…100' },
  { key: 'news_score', label: 'Haber skoru', hint: '-100…100' },
  { key: 'atr_pct', label: 'Günlük oynaklık %', hint: 'ATR' },
  { key: 'change_pct', label: 'Günlük değişim %' },
  { key: 'pe', label: 'F/K (BIST)' },
  { key: 'pb', label: 'PD/DD (BIST)' },
  { key: 'free_float', label: 'Halka açıklık % (BIST)' },
];

export interface Range {
  min?: number;
  max?: number;
}

export interface ScreenFilter {
  id: string;
  name: string;
  description?: string;
  ranges: Partial<Record<NumField, Range>>;
  risk?: Level[]; // izin verilen genel risk seviyeleri
  outlook?: Outlook[];
  newHigh?: boolean; // yalnız yeni zirve bölgesindekiler
  earningsWithinDays?: number; // bilançosu bu kadar gün içinde olanlar
  excludeEarningsDays?: number; // bilançosuna bu kadar günden az kalanları çıkar
  sort: NumField;
  desc: boolean;
  preset?: boolean;
}

const UP: Outlook[] = ['Yükseliş', 'Güçlü Yükseliş'];

export const PRESETS: ScreenFilter[] = [
  {
    id: 'leaders', name: 'Piyasa liderleri', preset: true,
    description: 'Göreli gücü yüksek (RS ≥ 80), teknik görünümü yükselişte ve riski yüksek olmayan hisseler.',
    ranges: { rs_rating: { min: 80 } }, outlook: UP, risk: ['Düşük', 'Orta'], sort: 'rs_rating', desc: true,
  },
  {
    id: 'pullback', name: 'Yükseliş trendinde geri çekilme', preset: true,
    description: 'Orta vade (haftalık) yukarıyken kısa vadede RSI 45 altına çekilmiş hisseler: trend içinde dinlenme.',
    ranges: { weekly_score: { min: 15 }, rsi: { max: 45 } }, sort: 'weekly_score', desc: true,
  },
  {
    id: 'breakout', name: 'Zirve kırılımı', preset: true,
    description: '1 yıllık zirve bölgesinde ve göreli gücü 70 üstü: yeni zirve yapan güçlü hisseler.',
    ranges: { rs_rating: { min: 70 } }, newHigh: true, sort: 'rs_rating', desc: true,
  },
  {
    id: 'value', name: 'Değer + momentum (BIST)', preset: true,
    description: 'F/K 0-10 arası (kârlı ve ucuz) ve birleşik skoru pozitif hisseler.',
    ranges: { pe: { min: 0.01, max: 10 }, combined_score: { min: 15 } }, sort: 'combined_score', desc: true,
  },
  {
    id: 'lowrisk', name: 'Düşük riskli yükseliş', preset: true,
    description: 'Genel riski düşük, oynaklığı %3 altı ve teknik görünümü yükselişte hisseler.',
    ranges: { atr_pct: { max: 3 }, combined_score: { min: 15 } }, risk: ['Düşük'], sort: 'combined_score', desc: true,
  },
  {
    id: 'earnings', name: 'Bilançosu yaklaşanlar', preset: true,
    description: 'Önümüzdeki 7 gün içinde bilanço açıklayacak hisseler (oynaklık artabilir).',
    ranges: {}, earningsWithinDays: 7, sort: 'combined_score', desc: true,
  },
  {
    id: 'weak', name: 'En zayıflar (kaçınılacaklar)', preset: true,
    description: 'Göreli gücü 20 altı ve birleşik skoru güçlü düşüşte: portföyde tutuyorsan gözden geçir.',
    ranges: { rs_rating: { max: 20 }, combined_score: { max: -40 } }, sort: 'combined_score', desc: false,
  },
];

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${iso}T00:00:00`).getTime() - today.getTime()) / 86400000);
}

export function applyFilter(items: StockSummary[], fl: ScreenFilter): StockSummary[] {
  const out = items.filter((s) => {
    for (const [k, r] of Object.entries(fl.ranges) as [NumField, Range][]) {
      if (!r || (r.min == null && r.max == null)) continue;
      const v = s[k];
      if (v == null || !Number.isFinite(v)) return false;
      if (r.min != null && v < r.min) return false;
      if (r.max != null && v > r.max) return false;
    }
    if (fl.risk?.length && !fl.risk.includes(s.overall_risk)) return false;
    if (fl.outlook?.length && !fl.outlook.includes(s.outlook)) return false;
    if (fl.newHigh && !s.at_new_high) return false;
    const d = s.earnings_status === 'reported' ? null : daysUntil(s.earnings_date);
    if (fl.earningsWithinDays != null && (d == null || d < 0 || d > fl.earningsWithinDays)) return false;
    if (fl.excludeEarningsDays != null && d != null && d >= 0 && d <= fl.excludeEarningsDays) return false;
    return true;
  });
  const dir = fl.desc ? -1 : 1;
  return out.sort((a, b) => dir * ((a[fl.sort] ?? -Infinity) - (b[fl.sort] ?? -Infinity)));
}

export function describe(fl: ScreenFilter): string {
  const parts: string[] = [];
  for (const f of NUM_FIELDS) {
    const r = fl.ranges[f.key];
    if (!r || (r.min == null && r.max == null)) continue;
    parts.push(r.min != null && r.max != null ? `${f.label} ${r.min}–${r.max}` : r.min != null ? `${f.label} ≥ ${r.min}` : `${f.label} ≤ ${r.max}`);
  }
  if (fl.risk?.length) parts.push(`risk: ${fl.risk.join('/')}`);
  if (fl.outlook?.length) parts.push(`görünüm: ${fl.outlook.join('/')}`);
  if (fl.newHigh) parts.push('yeni zirve bölgesi');
  if (fl.earningsWithinDays != null) parts.push(`bilanço ≤ ${fl.earningsWithinDays} gün`);
  if (fl.excludeEarningsDays != null) parts.push(`bilançosu ${fl.excludeEarningsDays} günden yakın olanlar hariç`);
  return parts.join(' · ') || 'Filtre yok';
}
