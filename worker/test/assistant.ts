// Asistan yardımcılarının testi: npx tsx test/assistant.ts
import {
  candidateKey, candidateStatus, cleanText, listMessage, merge, openingMessage, pending, prune, quietHours,
  type AiState, type AssistantData, type AssistantMarket, type Candidate,
} from '../src/assistant';
import type { Quote } from '../src/quotes';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}

const cand = (symbol: string): Candidate => ({
  symbol, market: 'BIST', name: symbol, sector: null, close: 100, change_pct: 1, combined_score: 50, rs_rating: 90, rsi: 60,
  setup: 'pullback', setup_text: 'Geri çekilmede alım', entry_low: 97, entry_high: 101, stop: 92, target1: 115, target2: 120,
  rr: 2.3, risk_pct: 7, projected: false, checks: [], reasons: [], news: [], earnings_date: null, earnings_status: null,
  commentary: 'kural',
});
const mk = (date: string, syms: string[], label = 'Nötr'): AssistantMarket => ({
  date, regime: { label, score: 0, summary: '' }, risk_scale: 0.75, stance: 'Piyasada yön yok.', candidates: syms.map(cand),
});
const data: AssistantData = { version: 'v2', generated_at: '', markets: { BIST: mk('2026-10-30', ['AAA', 'BBB']) }, disclaimer: '' };
const q = (price: number): Quote => ({ price, prev_close: 100, change_pct: price - 100, time: new Date().toISOString(), delayed: true });

// pending / prune / merge
const st: AiState = {
  version: 'v1', model: 'm', notified: {},
  texts: { [candidateKey('BIST', '2026-10-30', 'AAA')]: 'yorum A', 'BIST:2026-10-29:OLD': 'eski' },
  tries: { [candidateKey('BIST', '2026-10-30', 'BBB')]: 2 },
};
check('bekleyen: yorumsuz ve hakkı kalan', JSON.stringify(pending(data, st).map((p) => p.c.symbol)) === '["BBB"]');
st.tries[candidateKey('BIST', '2026-10-30', 'BBB')] = 3;
check('3 denemeden sonra bekleyen yok', pending(data, st).length === 0);
prune(data, st);
check('eski liste yorumu silinir', !('BIST:2026-10-29:OLD' in st.texts) && 'BIST:2026-10-30:AAA' in st.texts);
const merged = merge(data, st);
check('merge: yorum adaya eklenir', merged.markets.BIST!.candidates[0].ai === 'yorum A' && merged.markets.BIST!.candidates[1].ai === undefined);

// metin temizliği
const good = 'AAA hissesi yükseliş trendi içinde desteğe geri çekildi ve göreli gücü yüksek. Haber akışı nötr, piyasa yönsüz. '
  + 'Plan 97–101 aralığında alım, 92 altında çıkış ve 115 hedefi olarak düşünülebilir.';
check('temiz metin kabul', cleanText(good, 'AAA') === good);
check('markdown temizlenir', cleanText(`**${good}**\n\n- ek`, 'AAA')?.startsWith('AAA') === true);
check('"kesinlikle" reddedilir', cleanText(good + ' Kesinlikle alınmalı.', 'AAA') === null);
check('kod geçmiyorsa reddedilir', cleanText(good.replace(/AAA/g, 'Şirket'), 'AAA') === null);
check('kısa metin reddedilir', cleanText('AAA iyi.', 'AAA') === null);
check('düşünme etiketi atılır', cleanText(`<think>plan</think>${good}`, 'AAA') === good);

// durum ve bildirim metinleri
const c = cand('AAA');
check('durum: bölgede', candidateStatus(c, q(99)) === 'in_zone');
check('durum: üstünde', candidateStatus(c, q(103)) === 'above');
check('durum: altında', candidateStatus(c, q(95)) === 'below');
check('durum: stop', candidateStatus(c, q(91.5)) === 'stopped');
const lm = listMessage('BIST', data.markets.BIST!);
check('liste bildirimi', lm.title.includes('2 alım adayı') && lm.body.includes('AAA, BBB') && lm.body.includes('biraz küçült'), lm.title + ' | ' + lm.body);
const empty = listMessage('US', mk('2026-10-30', [], 'Ayı'));
check('boş liste bildirimi', empty.title.includes('ABD: bugün aday yok'), empty.title);
const om = openingMessage('BIST', [{ c, q: q(99) }, { c: cand('BBB'), q: q(104) }]);
check('açılış özeti', om.title.includes('1/2') && om.body.includes('kovalamayın'), om.title + ' | ' + om.body);

// sessiz saatler (İstanbul = UTC+3)
check('01:30 TR sessiz', quietHours(Date.parse('2026-10-30T22:30:00Z')));
check('07:10 TR açık', !quietHours(Date.parse('2026-10-31T04:10:00Z')));
check('22:50 TR açık', !quietHours(Date.parse('2026-10-30T19:50:00Z')));

console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
