// Sistem sağlığı uyarısının testi: npx tsx test/health.ts
import { healthAlert, STALE_MS, trDay, type Health } from '../src/health';

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
const stale = healthAlert({ ...base, generated_at: new Date(now - STALE_MS - 3600_000).toISOString() }, now);
check('tarama günlerdir çalışmadı', !!stale && stale.title.includes('çalışmadı'), stale?.body);
check('Türkiye günü (UTC+3)', trDay(Date.parse('2026-11-16T22:30:00Z')) === '2026-11-17');

if (fail) {
  console.error(`${fail} test başarısız`);
  process.exit(1);
}
console.log('Tüm testler geçti');
