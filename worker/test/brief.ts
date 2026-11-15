// Sabah özeti testi: npx tsx test/brief.ts
import type { AssistantMarket, Candidate } from '../src/assistant';
import { briefTime, morningBrief } from '../src/brief';
import type { TrackedPlan } from '../src/plans';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}

const cand = (symbol: string, close: number) => ({ symbol, close, entry_low: 10, entry_high: 11 }) as unknown as Candidate;
const mk = { date: '2026-11-13', candidates: [cand('ENERY', 10.5), cand('AKFIS', 12), cand('DOCO', 10.2)] } as unknown as AssistantMarket;
const plan: TrackedPlan = { id: 'a', symbol: 'THYAO', market: 'BIST', opened: '2026-11-03', entry: 100, stop: 95, target: null, atr: 2, trail: 3, hold: 60 };

const b = morningBrief({
  today: '2026-11-16', bist: mk, risk: { level: 'Düşük', score: 8 },
  events: [{ date: '2026-11-16', time: '10:00', title: 'TÜİK enflasyon', country: 'TR', note: '' },
    { date: '2026-11-20', time: '14:00', title: 'PPK', country: 'TR', note: '' }],
  plans: [{ p: plan, s: { id: 'a', status: 'open', stop: 108, peak: 114, days: 9, last: 109.5, as_of: '2026-11-13', r: 1.9 } }],
  healthIssue: null,
});
check('liste ve giriş bölgesi', !!b && b.body.includes('ENERY, AKFIS, DOCO') && b.body.includes('giriş bölgesinde: ENERY, DOCO'), b?.body);
check('risk ve bugünkü takvim', !!b && b.body.includes('Politik risk düşük (8/100)') && b.body.includes('10:00 TÜİK') && !b.body.includes('PPK'), b?.body);
check('stopa yakın plan', !!b && b.body.includes('THYAO stopa yakın (108)'), b?.body);
const old = morningBrief({ today: '2026-11-25', bist: mk, risk: null, events: [], plans: [], healthIssue: null });
check('eski liste (tatil) gösterilmez', old === null, JSON.stringify(old));
const safe = morningBrief({ today: '2026-11-16', bist: null, risk: null, events: [],
  plans: [{ p: plan, s: { id: 'a', status: 'open', stop: 100, peak: 110, days: 5, last: 110, as_of: '2026-11-13', r: 2 } }], healthIssue: 'veri eksik' });
check('güvende plan ve uyarı', !!safe && safe.body.includes('1 plan takipte, hepsi güvende') && safe.body.includes('Uyarı: veri eksik'), safe?.body);
check('saat: pazartesi 09:35 TR', briefTime(Date.parse('2026-11-16T06:35:00Z')));
check('saat: 10:05 TR değil', !briefTime(Date.parse('2026-11-16T07:05:00Z')));
check('saat: cumartesi değil', !briefTime(Date.parse('2026-11-14T06:35:00Z')));

if (fail) {
  console.error(`${fail} test başarısız`);
  process.exit(1);
}
console.log('Tüm testler geçti');
