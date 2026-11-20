// Sistem sağlığı uyarısının testi: npx tsx test/health.ts
import { expectedScanAt, healthAlert, trDay, type Health } from '../src/health';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}

const now = Date.parse('2026-11-17T09:00:00Z');
const base: Health = {
  generated_at: '2026-11-16T22:20:00Z', overall: 'ok', blocked_markets: [],
  checks: [{ id: 'fresh_BIST', name: 'Veri tazeliği (BIST)', status: 'ok', detail: '%100', market: 'BIST' }],
};
check('sorun yoksa uyarı yok', healthAlert(base, now) === null);
check('dosya yoksa uyarı yok', healthAlert(null, now) === null);
check('uyarı (warn) bildirim göndermez', healthAlert({ ...base, overall: 'warn' }, now) === null);
const err = healthAlert({
  ...base, overall: 'error', blocked_markets: ['BIST'],
  checks: [{ id: 'fresh_BIST', name: 'Veri tazeliği (BIST)', status: 'error', detail: 'Hisselerin %62\'sinde fiyat var', market: 'BIST' }],
}, now);
check('hata bildirimi', !!err && err.body.includes('%62') && err.body.includes('BIST için bugün aday verilmiyor'), err?.body);
// Hafta sonu: cuma 22:15 -> pazartesi akşamı normal, uyarı yok
check('hafta sonu boşluğu normal', healthAlert({ ...base, generated_at: '2026-11-13T22:20:00Z' },
  Date.parse('2026-11-16T21:00:00Z')) === null);
// Kasım 2026: pazartesi akşamı tarama çöktü (son yayın pazartesi 07:41). Uyarı ertesi sabah gelmeli, 3 gün sonra değil
const monday = { ...base, generated_at: '2026-11-16T07:41:00Z' };
const tueMorning = healthAlert(monday, Date.parse('2026-11-17T09:00:00Z'));
check('kaçan tarama: ertesi sabah uyarı', !!tueMorning && tueMorning.title.includes('yayınlanmadı') && tueMorning.body.includes('25 saat'),
  tueMorning?.body);
check('pazartesi gece henüz erken (gecikme payı)', healthAlert(monday, Date.parse('2026-11-16T23:00:00Z')) === null);
const late = healthAlert({ ...base, generated_at: '2026-11-16T23:50:00Z' }, Date.parse('2026-11-17T03:00:00Z'));
check('saatlerce gecikmiş ama yayınlanmış tarama normal', late === null, late?.body);
const week = healthAlert(monday, Date.parse('2026-11-20T16:00:00Z'));
check('günlerce yayın yok: gün olarak', !!week && week.body.includes('4 gün'), week?.body);
check('cumartesi sabahı beklenen: cuma 22:15', expectedScanAt(Date.parse('2026-11-21T09:00:00Z')) === Date.parse('2026-11-20T22:15:00Z'));
check('pazartesi öğlen beklenen: cuma 22:15', expectedScanAt(Date.parse('2026-11-23T12:00:00Z')) === Date.parse('2026-11-20T22:15:00Z'));
check('Türkiye günü (UTC+3)', trDay(Date.parse('2026-11-16T22:30:00Z')) === '2026-11-17');

if (fail) {
  console.error(`${fail} test başarısız`);
  process.exit(1);
}
console.log('Tüm testler geçti');
