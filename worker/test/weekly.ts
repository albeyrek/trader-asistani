// Haftalık karne testi: npx tsx test/weekly.ts
import type { TrackedPlan } from '../src/plans';
import { weekChange, weeklyReport, weeklyTime } from '../src/weekly';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}

const curve: [string, number, number][] = [
  ['2026-11-02', 100000, 100000], ['2026-11-06', 101000, 103000], ['2026-11-09', 101500, 104000], ['2026-11-13', 102000, 110000],
];
const wc = weekChange(curve, '2026-11-13');
check('haftalık değişim 6 Kasım\'dan', !!wc && Math.abs(wc.eq - (102000 / 101000 - 1) * 100) < 1e-9 && Math.abs(wc.ix - (110000 / 103000 - 1) * 100) < 1e-9,
  JSON.stringify(wc));
check('tek nokta: yok', weekChange([curve[0]], '2026-11-13') === null);

const plan: TrackedPlan = { id: 'a', symbol: 'THYAO', market: 'BIST', opened: '2026-11-03', entry: 100, stop: 95, target: null, atr: 2, trail: 3, hold: 60 };
const r = weeklyReport({
  today: '2026-11-13',
  paper: { curve, return_pct: 2, index_return_pct: 10, start: '2026-11-02' },
  trades: [
    { symbol: 'A', status: 'stop', r: -1, exit_date: '2026-11-10' },
    { symbol: 'B', status: 'trail', r: 2.5, exit_date: '2026-11-12' },
    { symbol: 'C', status: 'stop', r: -1, exit_date: '2026-11-03' }, // geçen hafta
    { symbol: 'D', status: 'open', r: 0.4, exit_date: null },
  ],
  plans: [{ p: plan, s: { id: 'a', status: 'open', stop: 100, peak: 110, days: 9, last: 108, as_of: '2026-11-13', r: 1.6 } },
    { p: { ...plan, id: 'b', symbol: 'ASELS' }, s: { id: 'b', status: 'stop', stop: 95, peak: 101, days: 3, last: 94, as_of: '2026-11-12', r: -1 } }],
});
check('portföy ve endeks', !!r && r.body.includes('bu hafta +%1') && r.body.includes('BIST 100 +%6,8'), r?.body);
check('kapanan işlemler (sadece bu hafta)', !!r && r.body.includes('kapanan 2 işlem: 1 kâr, ortalama +0,75R'), r?.body);
check('planlar', !!r && r.body.includes('1 açık (toplam +1,6R), 1 plana göre çıkışta: ASELS'), r?.body);
const empty = weeklyReport({ today: '2026-11-13', paper: null, trades: [], plans: [] });
check('veri yoksa kısa', !!empty && empty.body === 'Bu hafta kapanan işlem yok.', empty?.body);
check('saat: cuma 20:30 TR', weeklyTime(Date.parse('2026-11-13T17:30:00Z')));
check('saat: perşembe değil', !weeklyTime(Date.parse('2026-11-12T17:30:00Z')));

if (fail) {
  console.error(`${fail} test başarısız`);
  process.exit(1);
}
console.log('Tüm testler geçti');
