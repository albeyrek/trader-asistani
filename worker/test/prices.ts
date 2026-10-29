// Gün içi alarm kurallarının testi: npx tsx test/prices.ts
import { alertTriggered, customAlertText, detectEvents, eventText, isFresh, type CustomAlert, type Levels } from '../src/prices';
import type { Quote } from '../src/quotes';

const now = Date.now();
const q = (price: number, prev: number, ageMin = 1, delayed = true): Quote => ({
  price, prev_close: prev, change_pct: (price / prev - 1) * 100, time: new Date(now - ageMin * 60_000).toISOString(), delayed,
});
// [yahoo, kapanış, destek, direnç, stop]
const thyao: Levels[string] = ['THYAO.IS', 258, 250, 278.5, 241.64];
const noLevels: Levels[string] = ['AAPL', 347.73, null, null, null];

const cases: [string, ReturnType<typeof detectEvents>, string[]][] = [
  ['seviyeler arasında, küçük hareket', detectEvents('BIST:THYAO', q(255, 258), thyao), []],
  ['destek kırıldı (stop üstünde)', detectEvents('BIST:THYAO', q(248, 258), thyao), ['support']],
  ['stop altına indi (destek de kırık ama sadece stop)', detectEvents('BIST:THYAO', q(240, 258), thyao), ['stop', 'move_down']],
  ['direnç kırıldı ve sert yükseliş', detectEvents('BIST:THYAO', q(280, 258), thyao), ['resistance', 'move_up']],
  ['seviye yok, %5,5 yükseliş', detectEvents('US:AAPL', q(366.9, 347.73, 1, false), noLevels), ['move_up']],
  ['seviye yok, %4,9 düşüş (eşik altı)', detectEvents('US:AAPL', q(330.7, 347.73, 1, false), noLevels), []],
  // Kapanış zaten seviyenin altındaysa (dün kırılmış) bugün tekrar alarm yok
  ['dün zaten stop altında kapanmış', detectEvents('BIST:X', q(230, 235), ['X.IS', 235, 250, 278, 241]), []],
];

let fail = 0;
for (const [name, got, want] of cases) {
  const kinds = got.map((e) => e.kind);
  const ok = JSON.stringify(kinds) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}: ${JSON.stringify(kinds)}${ok ? '' : ` (beklenen ${JSON.stringify(want)})`}`);
}
const fresh = [isFresh(q(1, 1, 10)), isFresh(q(1, 1, 39)), isFresh(q(1, 1, 60 * 20))];
console.log(`${JSON.stringify(fresh) === '[true,true,false]' ? 'OK ' : 'XX '} tazelik (10 dk, 39 dk, 20 saat): ${JSON.stringify(fresh)}`);
if (JSON.stringify(fresh) !== '[true,true,false]') fail++;

// Kişisel alarmlar
const below: CustomAlert = { id: 'a1', symbol: 'THYAO', market: 'BIST', op: 'below', price: 245 };
const above: CustomAlert = { id: 'a2', symbol: 'AAPL', market: 'US', op: 'above', price: 350 };
const ca = [
  alertTriggered(below, q(244.9, 258)), alertTriggered(below, q(245, 258)), alertTriggered(below, q(245.1, 258)),
  alertTriggered(above, q(350.2, 347, 1, false)), alertTriggered(above, q(349.9, 347, 1, false)),
];
const caOk = JSON.stringify(ca) === '[true,true,false,true,false]';
if (!caOk) fail++;
console.log(`${caOk ? 'OK ' : 'XX '} kişisel alarm koşulları: ${JSON.stringify(ca)}`);
const ct = customAlertText(below, q(244.1, 258));
console.log(`  ${ct.title}\n     ${ct.body}`);

console.log('\nÖrnek bildirim metinleri:');
for (const e of [...cases[2][1], ...cases[3][1], ...cases[4][1]]) {
  const t = eventText(e);
  console.log(`  ${t.title}\n     ${t.body}`);
}
process.exit(fail ? 1 : 0);
