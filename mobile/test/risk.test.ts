// Pozisyon hesaplayıcı testleri: npx tsx test/risk.test.ts
import { parseNumber, sizePosition, type SizingResult } from '../src/lib/risk';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? ` (${detail})` : ''}`);
}

// 100.000 ₺ sermaye, %1 risk, giriş 258, stop 241,64 -> risk/lot 16,36 -> 1000/16,36 = 61 lot
const a = sizePosition({ capital: 100_000, riskPct: 1, entry: 258, stop: 241.64, target: 278.5 }) as SizingResult;
check('lot sayısı', a.qty === 61, `${a.qty}`);
check('stop’ta kayıp ≤ %1', a.lossAtStop <= 1000 && a.lossAtStop > 990, a.lossAtStop.toFixed(2));
check('pozisyon tutarı', Math.abs(a.value - 61 * 258) < 1e-6, a.value.toFixed(2));
check('R/R', Math.abs((a.rr ?? 0) - (20.5 / 16.36)) < 1e-6, a.rr?.toFixed(3));
check('R/R < 1,5 uyarısı', a.warnings.some((w) => w.includes('Risk/getiri')));

// Stop çok yakın: risk kuralı 1000/0,5 = 2000 lot × 258 = 516.000 ₺ ister -> sermayeyle sınırlanır (387 lot)
const b = sizePosition({ capital: 100_000, riskPct: 1, entry: 258, stop: 257.5 }) as SizingResult;
check('sermaye sınırı', b.cappedByCapital && b.qty === 387, `${b.qty}`);
check('yoğunlaşma uyarısı', b.warnings.some((w) => w.includes('yoğunlaşma')));

// Hatalı girişler
check('stop girişin üstünde', 'error' in sizePosition({ capital: 1000, riskPct: 1, entry: 10, stop: 11 }));
check('sermaye yok', 'error' in sizePosition({ capital: 0, riskPct: 1, entry: 10, stop: 9 }));
check('risk %50', 'error' in sizePosition({ capital: 1000, riskPct: 50, entry: 10, stop: 9 }));

// Küçük sermaye: 1 lot bile alınamaz
const c = sizePosition({ capital: 1000, riskPct: 1, entry: 11732, stop: 11000 }) as SizingResult;
check('0 lot uyarısı', c.qty === 0 && c.warnings.some((w) => w.includes('1 lot')));

// Sayı ayrıştırma
check('1.234,5', parseNumber('1.234,5') === 1234.5);
check('1,234.5', parseNumber('1,234.5') === 1234.5);
check('258,75', parseNumber('258,75') === 258.75);
check('1 000', parseNumber('1 000') === 1000);
check('boş', Number.isNaN(parseNumber('')));

console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
