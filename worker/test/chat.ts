// Sohbet: hisse ve konu tespiti testi — npx tsx test/chat.ts
import { detectIntents, detectSymbols } from '../src/chat';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
};
const bist = new Set(['THYAO', 'ASELS', 'GARAN', 'SISE', 'KCHOL']);
const us = new Set(['AAPL', 'NVDA', 'ON', 'A', 'IT', 'ALL', 'MU']);
const names = { 'BIST:ASELS': 'aselsan', 'BIST:THYAO': 'türk hava yolları', 'US:AAPL': 'apple' };
const syms = (t: string) => detectSymbols(t, bist, us, names).map((x) => `${x.market}:${x.symbol}`);

check('BIST kodu büyük harf', syms('THYAO hakkında ne düşünüyorsun?').includes('BIST:THYAO'));
check('BIST kodu küçük harf', syms('thyao alayım mı').includes('BIST:THYAO'));
check('şirket adı', syms('Aselsan son durum nedir').includes('BIST:ASELS'));
check('ABD kodu', syms('NVDA ve AAPL karşılaştır').join(',') === 'US:NVDA,US:AAPL', syms('NVDA ve AAPL karşılaştır').join(','));
check('sıradan kelime hisse değil', syms('ON IT ALL A').length === 0, syms('ON IT ALL A').join(','));
check('küçük harf ABD kodu sayılmaz', syms('mu acaba').length === 0, syms('mu acaba').join(','));
check('TCMB hisse değil', syms('TCMB faiz kararı ne olur').length === 0);
const names2 = { ...names, 'BIST:KLRHO': 'kiler' };
check('kelime içindeki ad eşleşmez', detectSymbols('borsayı nasıl etkiler', bist, us, names2).length === 0);
check('ek almış ad eşleşir', detectSymbols("aselsan'ı alayım mı", bist, us, names2).some((x) => x.symbol === 'ASELS'));
check('portföy niyeti', detectIntents('Portföyümdeki en riskli hisse hangisi?').includes('portfolio'));
check('gündem niyeti', detectIntents('Gündemde neler var, faiz kararı ne olur?').includes('agenda'));
check('aday niyeti', detectIntents('Bugün ne alayım?').includes('candidates'));
check('performans niyeti', detectIntents('Sanal portföy nasıl gidiyor?').includes('performance'));
console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
