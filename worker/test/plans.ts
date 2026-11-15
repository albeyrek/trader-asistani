// Plan takibi testi: npx tsx test/plans.ts
import { dailyMessage, intradayEvent, parsePlans, planStatus, type Bar, type TrackedPlan } from '../src/plans';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}

const day = (i: number) => new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
const bars = (rows: [number, number, number, number][]): Bar[] =>
  rows.map(([open, high, low, close], i) => ({ d: day(i), open, high, low, close }));

const trail: TrackedPlan = {
  id: 'p1', symbol: 'THYAO', market: 'BIST', opened: day(0), entry: 100, stop: 95, target: null, atr: 2, trail: 3, hold: 60,
};
// 100'den 120'ye: en yüksek kapanış 120, iz süren stop 120 - 6 = 114
const up = bars([[100, 101, 99, 100], ...Array.from({ length: 10 }, (_, i): [number, number, number, number] =>
  [100 + 2 * (i + 1), 101 + 2 * (i + 1), 99 + 2 * (i + 1), 100 + 2 * (i + 1)])]);
const open = planStatus(trail, up);
check('açık plan: iz süren stop', open.status === 'open' && open.stop === 114 && open.peak === 120 && open.days === 11, JSON.stringify(open));
check('açık plan: R', open.r === 4, String(open.r));
const hit = planStatus(trail, [...up, { d: day(11), open: 118, high: 118, low: 110, close: 111 }]);
check('iz süren stop kârla kapanır', hit.status === 'stop' && hit.exit === 114 && hit.r === 2.8, JSON.stringify(hit));
const gap = planStatus(trail, [...up, { d: day(11), open: 108, high: 109, low: 105, close: 106 }]);
check('stopun altında açılış: açılıştan çıkış', gap.status === 'stop' && gap.exit === 108, JSON.stringify(gap));
check('alıştan önceki mumlar sayılmaz', planStatus({ ...trail, opened: day(5) }, up).days === 6);

const base: TrackedPlan = { ...trail, id: 'p2', target: 110, trail: null, hold: 20 };
const tgt = planStatus(base, bars([[100, 101, 99, 100], [101, 106, 100, 105], [105, 111, 104, 110]]));
check('hedef', tgt.status === 'target' && tgt.exit === 110 && tgt.r === 2, JSON.stringify(tgt));
const both = planStatus(base, bars([[100, 101, 99, 100], [100, 112, 94, 105]]));
check('aynı gün stop ve hedef: stop', both.status === 'stop', both.status);
const flat = planStatus({ ...base, hold: 3 }, bars([[100, 101, 99, 100], [100, 101, 99, 100], [100, 102, 99, 101], [101, 102, 100, 101]]));
check('süre doldu', flat.status === 'time' && flat.days === 3 && flat.exit === 101, JSON.stringify(flat));

// Bildirimler
const prev = planStatus(trail, up.slice(0, 8));
const msg = dailyMessage(trail, prev, open);
check('stop yükseldi mesajı', !!msg && msg.title.includes('iz süren stop yükseldi') && msg.body.includes('114'), JSON.stringify(msg));
check('aynı durumda mesaj yok', dailyMessage(trail, open, open) === null);
const closed = dailyMessage(trail, open, hit);
check('kapanış mesajı', !!closed && closed.title.includes('THYAO') && closed.body.includes('+2,8R'), JSON.stringify(closed));
check('kapalı plan tekrar mesaj vermez', dailyMessage(trail, hit, hit) === null);
check('gün içi stop', intradayEvent(trail, open, 113.5) === 'stop' && intradayEvent(trail, open, 115) === null);
check('gün içi hedef', intradayEvent(base, planStatus(base, bars([[100, 101, 99, 100]])), 110.2) === 'target');

// Doğrulama
const parsed = parsePlans([trail, { ...trail, id: 'BAD ID' }, { ...trail, id: 'x2', stop: 120 }, { ...base, id: 'x3', market: 'US', symbol: 'brk.b' }, 'çöp']);
check('bozuk planlar atılır', parsed.length === 2 && parsed[1].symbol === 'BRK.B', JSON.stringify(parsed.map((p) => p.id)));

if (fail) {
  console.error(`${fail} test başarısız`);
  process.exit(1);
}
console.log('Tüm testler geçti');
