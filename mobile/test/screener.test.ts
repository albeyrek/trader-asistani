// Filtre testleri: npx tsx test/screener.test.ts
import { applyFilter, PRESETS, type ScreenFilter } from '../src/lib/screener';
import type { StockSummary } from '../src/lib/types';

const base: StockSummary = {
  symbol: 'X', market: 'BIST', name: 'X', sector: '', close: 10, change_pct: 0, combined_score: 0, daily_score: 0,
  weekly_score: 0, outlook: 'Nötr', overall_risk: 'Orta', volatility: 'Orta', news_score: 0, news_risk: 'Düşük',
  at_new_high: false, at_new_low: false, alerts: [],
};
const s = (o: Partial<StockSummary>): StockSummary => ({ ...base, ...o });
const iso = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const items = [
  s({ symbol: 'LEAD', rs_rating: 92, outlook: 'Güçlü Yükseliş', overall_risk: 'Düşük', combined_score: 60, at_new_high: true }),
  s({ symbol: 'RISKY', rs_rating: 95, outlook: 'Yükseliş', overall_risk: 'Yüksek', combined_score: 30 }),
  s({ symbol: 'WEAK', rs_rating: 10, outlook: 'Güçlü Düşüş', combined_score: -70 }),
  s({ symbol: 'VALUE', pe: 6, combined_score: 20, outlook: 'Yükseliş' }),
  s({ symbol: 'LOSS', pe: -3, combined_score: 25 }),
  s({ symbol: 'EARN', earnings_date: iso(3), earnings_status: 'estimated' }),
  s({ symbol: 'DONE', earnings_date: iso(-2), earnings_status: 'reported' }),
  s({ symbol: 'NORS' }), // RS yok -> RS filtresine takılmamalı (eksik veri elenir)
];
const byId = (id: string) => PRESETS.find((p) => p.id === id) as ScreenFilter;
const names = (fl: ScreenFilter) => applyFilter(items, fl).map((x) => x.symbol);

let fail = 0;
const check = (name: string, got: string[], want: string[]) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (beklenen ${JSON.stringify(want)})`}`);
};
check('Piyasa liderleri (yüksek risk elenir)', names(byId('leaders')), ['LEAD']);
check('Zirve kırılımı', names(byId('breakout')), ['LEAD']);
check('Değer + momentum (zararlı elenir)', names(byId('value')), ['VALUE']);
check('Bilançosu yaklaşanlar (açıklanan elenir)', names(byId('earnings')), ['EARN']);
check('En zayıflar', names(byId('weak')), ['WEAK']);
check('Sıralama (RS azalan)', names({ id: 'x', name: 'x', ranges: { rs_rating: { min: 1 } }, sort: 'rs_rating', desc: true }), ['RISKY', 'LEAD', 'WEAK']);
check('Bilançoya 7 günden az kalanlar hariç',
  names({ id: 'y', name: 'y', ranges: {}, excludeEarningsDays: 7, sort: 'combined_score', desc: true }).includes('EARN') ? ['EARN'] : [], []);
console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
