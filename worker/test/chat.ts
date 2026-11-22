// Sohbet: hisse ve konu tespiti testi — npx tsx test/chat.ts
import { detectIntents, detectSymbols, parsePlan, plansContext, referenceNumbers, resolvePlanSymbols, verifyNumbers } from '../src/chat';

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
// Rakam doğrulama: cevaptaki sayılar bağlamda var mı?
const ctx = [
  'THYAO: kapanış 312.75 TL, günlük değişim -2.4%, RSI 58.3, 52 hafta zirvesi 1234.5, piyasa değeri 431000000000',
  'Plan: giriş 305.2-310.0, stop 296.4, ilk hedef 336.8, ortalama +0.42R, tarih 2026-11-13',
].join('\n');
const ref = referenceNumbers(ctx, 'THYAO alayım mı? 300 TL civarı mantıklı mı');
const unv = (t: string) => verifyNumbers(t, ref).unverified;
const okText = (name: string, t: string) => check(name, unv(t).length === 0, unv(t).join(','));
okText('Türkçe ondalık', 'Kapanış 312,75 TL, RSI 58,3.');
okText('yuvarlama kabul', 'Fiyat yaklaşık 313 TL, stop 296 civarında.');
okText('binlik ayırıcı', '52 haftalık zirve 1.234,5 TL.');
okText('yüzde ve eksi', 'Bugün %2,4 düştü; ortalama +0,42R.');
okText('ölçek kelimesi', 'Piyasa değeri 431 milyar TL.');
okText('tarih ve endeks adı', '13.11.2026 itibarıyla BIST 100 içinde, XU100 zayıf.');
okText('sorudaki sayı', '300 TL seviyesi giriş bölgesinin altında.');
okText('küçük sayılar ve madde no', '1. 3 nedenle temkinli ol\n2. 2R hedef');
const fake = unv('Hedef fiyat 355,40 TL ve stop 288 TL.').join(',');
check('uydurma fiyat yakalanır', fake === '355,40,288', fake);
const fakePct = unv('Son ayda %17,3 yükseldi.').join(',');
check('uydurma yüzde yakalanır', fakePct === '%17,3', fakePct);

// Takipteki planlar
check('plan niyeti', detectIntents('THYAO\'yu ne zaman satmalıyım?').includes('plans') && detectIntents('Planlarım nasıl gidiyor?').includes('plans'));
const pc = plansContext([{ symbol: 'THYAO', market: 'BIST', opened: '2026-11-03', entry: 300, stop: 285, target: null, trail: 3, hold: 60,
  status: { status: 'open', stop: 304.5, last: 318.25, r: 1.22, days: 9 } }]);
check('plan bağlamı', pc.includes('THYAO (BIST): 2026-11-03 alış 300,00') && pc.includes('güncel stop 304,50') && pc.includes('+1,22R'), pc);
const pref = referenceNumbers(pc);
check('plan rakamları doğrulanır', verifyNumbers('THYAO için güncel iz süren stop 304,50; son kapanış 318,25 ve +1,22R kârdasın.', pref).unverified.length === 0);

// Sorgu planı: yapay zekânın JSON'u doğrulanır, bilinmeyen kod ve konu atılır
const pl = parsePlan('Tamam: {"symbols": ["thyao", "Aselsan", "ASELS", "KCHOL.IS"], "topics": ["market", "uydurma"], "market": "BIST"}');
check('plan JSON okunur', ['THYAO', 'ASELS', 'KCHOL'].every((x) => pl?.symbols.includes(x)) && pl?.topics.join(',') === 'market' && pl?.market === 'BIST',
  JSON.stringify(pl));
check('bozuk plan yok sayılır', parsePlan('bilmiyorum') === null && parsePlan('{symbols: [THYAO]}') === null);
check('düşünme bloğu atlanır', parsePlan('<think>{"x":1} belki</think>{"symbols":["GARAN"],"topics":[]}')?.symbols[0] === 'GARAN');
const rs = (p: Parameters<typeof resolvePlanSymbols>[0]) => resolvePlanSymbols(p, bist, us).map((x) => `${x.market}:${x.symbol}`).join(',');
check('plan kodları çözülür', rs({ symbols: ['THYAO', 'NVDA', 'XYZW'], topics: [] }) === 'BIST:THYAO,US:NVDA', rs({ symbols: ['THYAO', 'NVDA', 'XYZW'], topics: [] }));
check('sıradan kelime plan kodu değil', rs({ symbols: ['ON', 'IT'], topics: [], market: 'US' }) === '');

console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
