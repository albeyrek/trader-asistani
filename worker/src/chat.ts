// Sohbet asistanı: kullanıcının sorusunu uygulamanın kendi verisiyle (GitHub Pages JSON + gündem) cevaplar.
//  1) Sorudaki hisseler (kod ya da şirket adı) ve konular (portföy, gündem, piyasa, adaylar, karne, strateji) bulunur
//  2) İlgili veriler kısa bir "BAĞLAM" metnine dönüştürülür (grafik, plan, haberler, gündem, model, sanal portföy...)
//  3) Workers AI (Gemma) yalnızca bu bağlamla cevap verir; veri yoksa "verim yok" der
// Yatırım tavsiyesi değildir: model kesin al/sat demez, planı ve riskleri anlatır.

import { AI_MODEL, MODEL_OPTIONS } from './assistant';
import { trLower } from './classify';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  token?: string; // cihazın bildirim adresi (kota için)
  symbol?: string; // hisse sayfasından açıldıysa
  market?: 'BIST' | 'US';
  portfolio?: { symbol: string; market: 'BIST' | 'US'; qty: number; cost: number }[];
  watchlist?: { symbol: string; market: 'BIST' | 'US' }[];
}

export interface ChatSource {
  kind: 'stock' | 'agenda' | 'market' | 'assistant' | 'paper' | 'model' | 'portfolio' | 'strategy';
  label: string;
  symbol?: string;
  market?: 'BIST' | 'US';
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------ veri (Worker belleğinde 10 dk önbellek)

const CACHE_MS = 10 * 60_000;
const memo = new Map<string, { at: number; data: Json | null }>();

async function getJson(url: string): Promise<Json | null> {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data: Json | null = null;
  try {
    const r = await fetch(url, { cf: { cacheTtl: 300 } });
    data = r.ok ? ((await r.json()) as Json) : null;
  } catch {
    data = null;
  }
  memo.set(url, { at: Date.now(), data });
  return data;
}

// ------------------------------------------------------------------ hisse ve konu tespiti

// ABD kodlarıyla karışabilecek sıradan kelimeler (büyük harfle yazılsalar da hisse sayılmaz)
const COMMON = new Set(['A', 'I', 'AI', 'IT', 'ON', 'OR', 'ALL', 'ARE', 'FOR', 'BE', 'SO', 'GO', 'NOW', 'BIST', 'ABD', 'TL', 'USD',
  'EUR', 'TCMB', 'FED', 'KAP', 'SPK', 'PPK', 'TÜFE', 'RSI', 'ATR', 'EMA', 'MACD', 'GDP', 'CEO', 'ETF', 'ADX', 'OK', 'VE', 'DE', 'DA']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** token metinde bir kelimenin başında geçiyor mu (sonuna ek gelebilir: "aselsan'ı", "aselsanın")? */
function startsWord(text: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${escapeRe(token)}`, 'u').test(text);
}

export function detectSymbols(text: string, bist: Set<string>, us: Set<string>, names: Record<string, string>):
  { symbol: string; market: 'BIST' | 'US' }[] {
  const out = new Map<string, { symbol: string; market: 'BIST' | 'US' }>();
  for (const m of text.matchAll(/\b[A-Za-zÇĞİÖŞÜçğıöşü][A-Za-z0-9.]{1,6}\b/g)) {
    const raw = m[0];
    const up = raw.toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');
    if (COMMON.has(up)) continue;
    // BIST kodları küçük harfle de yazılabilir (thyao); ABD kodları sadece büyük harfle (kelimelerle karışmasın)
    if (bist.has(up) && up.length >= 4) out.set(`BIST:${up}`, { symbol: up, market: 'BIST' });
    else if (raw === raw.toUpperCase() && us.has(raw) && raw.length >= 2) out.set(`US:${raw}`, { symbol: raw, market: 'US' });
  }
  // Şirket adı ("aselsan", "türk hava yolları"): watch_meta.json'daki ad anahtarları
  const low = trLower(text);
  for (const [key, token] of Object.entries(names)) {
    if (!token || token.length < 5) continue;
    // Tam kelime olarak (ek alabilir: "aselsan'ı"): "etkiler" içindeki "kiler" Kiler Holding sayılmasın
    if (low.includes(token) && startsWord(low, token)) {
      const [market, symbol] = key.split(':') as ['BIST' | 'US', string];
      if (market === 'BIST') out.set(key, { symbol, market });
    }
  }
  return [...out.values()].slice(0, 3);
}

export const INTENTS: Record<string, RegExp> = {
  portfolio: /(portföy|pozisyon|elimde|elimdeki|aldığım|hisselerim)/,
  agenda: /(gündem|siyaset|seçim|politik|haber|savaş|jeopolitik|faiz|enflasyon|merkez bankası|tcmb|fed|dolar|kur)/,
  market: /(piyasa|borsa|endeks|bist 100|bist100|s&p|nasdaq|rejim|genel durum|sektör)/,
  candidates: /(ne alay|ne al|aday|öneri|fırsat|hangi hisse|liste|bugün)/,
  performance: /(sanal portföy|performans|karne|başarı|kazandır|kaybettir|test|geçmiş)/,
  strategy: /(strateji|momentum|endeks fonu|abd için|iz süren|çıkış kural|stop)/,
};

export function detectIntents(text: string): string[] {
  const low = trLower(text);
  return Object.entries(INTENTS).filter(([, re]) => re.test(low)).map(([k]) => k);
}

// ------------------------------------------------------------------ bağlam metinleri

const n = (v: unknown, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '—');

function stockContext(s: Json, cand: Json | null): string {
  const lines = [
    `## ${s.symbol} (${s.name}, ${s.market === 'BIST' ? 'Borsa İstanbul' : 'ABD'}${s.sector ? `, ${s.sector}` : ''}) — ${s.date} kapanışı`,
    `Fiyat ${n(s.close)}; günlük ${n(s.change_pct, 1)}%; teknik görünüm: ${s.outlook} (birleşik skor ${n(s.combined_score, 0)}; günlük ${s.daily_outlook}, haftalık ${s.weekly_outlook ?? '—'})`,
    `RSI ${n(s.rsi, 0)}, ADX ${n(s.adx, 0)}, oynaklık (ATR) %${n(s.atr_pct, 1)}; göreli güç ${s.rs_rating ?? '—'}/99; 52 hafta aralığı ${n(s.low_52w)} – ${n(s.high_52w)}`,
    `Destek ${n(s.support)}, direnç ${n(s.resistance)}, uzun pozisyon için teknik stop seviyesi ${n(s.stop)}; risk: ${s.overall_risk} (haber riski ${s.news_risk})`,
    `Grafik gerekçeleri: ${(s.daily_reasons ?? []).slice(0, 6).join('; ')}`,
    s.insights?.length ? `Asistan notları: ${s.insights.slice(0, 5).join(' | ')}` : '',
    s.performance ? `Getiriler: 1 hafta %${n(s.performance['1H'], 1)}, 1 ay %${n(s.performance['1A'], 1)}, 3 ay %${n(s.performance['3A'], 1)}, 1 yıl %${n(s.performance['1Y'], 1)}` : '',
    s.fundamentals ? `Temel: F/K ${n(s.fundamentals.pe, 1)}, PD/DD ${n(s.fundamentals.pb, 1)}, piyasa değeri ${n(s.fundamentals.market_cap, 0)} mn` : '',
    s.event ? `Bilanço: ${s.event.date} (${s.event.status === 'reported' ? 'açıklandı' : s.event.status === 'estimated' ? 'tahmini' : 'bekleniyor'})` : '',
    (s.risk_flags ?? []).length ? `Risk işaretleri: ${(s.risk_flags as Json[]).slice(0, 3).map((f) => `${f.category}${f.severe ? ' (ciddi)' : ''}`).join(', ')}` : '',
    (s.news ?? []).length ? `Son haberler: ${(s.news as Json[]).slice(0, 5).map((x) => `[${x.sentiment > 0 ? '+' : x.sentiment < 0 ? '−' : '•'}] ${x.title} (${(x.date ?? '').slice(0, 10)})`).join(' | ')}` : 'Son haber yok',
  ];
  if (cand) {
    const rule = cand.exit_rule?.trail ? `çıkış: iz süren stop (${cand.exit_rule.trail} ATR), sabit hedef yok` : `ilk hedef ${n(cand.target1)}, ikinci ${n(cand.target2)}`;
    lines.push(`BUGÜNKÜ ASİSTAN LİSTESİNDE: ${cand.setup_text}; giriş ${n(cand.entry_low)}–${n(cand.entry_high)}, stop ${n(cand.stop)} (risk %${n(cand.risk_pct, 1)}), ${rule}`);
    if (cand.model) lines.push(`Model: ilk dirence stoptan önce ulaşma olasılığı %${Math.round(cand.model.p * 100)}`);
    if (cand.ai) lines.push(`Asistan yorumu: ${cand.ai}`);
  } else {
    lines.push('Bu hisse bugünkü asistan aday listesinde değil.');
  }
  return lines.filter(Boolean).join('\n');
}

function candidatesContext(asst: Json, market: 'BIST' | 'US'): string {
  const mk = asst.markets?.[market];
  if (!mk) return '';
  const rows = (mk.candidates as Json[]).map((c) =>
    `- ${c.symbol} (${c.setup_text}): giriş ${n(c.entry_low)}–${n(c.entry_high)}, stop ${n(c.stop)}, göreli güç ${c.rs_rating}` +
    (c.exit_rule?.trail ? ', çıkış iz süren stop' : `, hedef ${n(c.target1)}`));
  return [`## Bugünkü asistan listesi (${market === 'BIST' ? 'BIST' : 'ABD'}, ${mk.date}) — piyasa rejimi: ${mk.regime.label}`,
    mk.stance, ...(rows.length ? rows : ['Bugün aday yok.'])].join('\n');
}

function marketContext(m: Json, market: 'BIST' | 'US'): string {
  const x = m?.[market];
  if (!x) return '';
  const rot = (x.sector_rotation as Json[] | undefined)?.slice(0, 4).map((r) => `${r.name} (1 ayda BIST'e göre ${n(r.rel_1m, 1)} puan)`).join(', ');
  return [`## Piyasa (${market === 'BIST' ? 'BIST' : 'ABD'})`,
    `Rejim: ${x.regime.label} (${x.regime.score}/5). ${x.regime.summary}`,
    `Genişlik: hisselerin %${n(x.breadth.pct_above_50, 0)}'i 50 günlük, %${n(x.breadth.pct_above_200, 0)}'i 200 günlük ortalamanın üstünde`,
    ...(x.indices as Json[]).slice(0, 3).map((i) => `${i.name}: ${n(i.close)} (1 gün %${n(i.chg_1d, 1)}, 1 ay %${n(i.chg_1m, 1)}, 1 yıl %${n(i.chg_1y, 1)})`),
    rot ? `Öndeki sektörler: ${rot}` : ''].filter(Boolean).join('\n');
}

function agendaContext(a: Json): string {
  if (!a) return '';
  const risk = a.risk ? `Politik risk: ${a.risk.level} (${a.risk.score}/100)${a.risk.notes?.length ? ` — ${a.risk.notes.join('; ')}` : ''}` : '';
  const ai = (a.ai?.themes as Json[] | undefined)?.map((t) => `- ${t.title} (${t.tone}): ${t.summary}`) ?? [];
  const rules = (a.themes as Json[]).slice(0, 5).map((t) => `${t.name} ×${t.count}`).join(', ');
  const sectors = (a.sectors as Json[]).slice(0, 8).map((s) => `${s.name} ${s.score > 0 ? '+' : ''}${s.score}`).join(', ');
  const cal = (a.calendar as Json[]).slice(0, 3).map((e) => `${e.date} ${e.title}`).join('; ');
  return ['## Gündem (son 24 saat)', risk, ...ai, `Öne çıkan temalar: ${rules}`, `Gündemin sektör etkisi: ${sectors}`,
    cal ? `Takvim: ${cal}` : ''].filter(Boolean).join('\n');
}

function paperContext(p: Json, market: 'BIST' | 'US'): string {
  const live = p?.live?.[market];
  const bt = p?.backtest?.markets?.[market];
  const lines = [`## Sanal portföy (${market === 'BIST' ? 'BIST' : 'ABD'})`];
  if (live) lines.push(`Canlı (${live.start}'den beri): portföy %${n(live.return_pct, 1)}, endeks %${n(live.index_return_pct, 1)}; ${live.open_count} açık, ${live.trades} kapanan işlem`);
  if (bt) lines.push(`2018'den beri test: yıllık %${n(bt.cagr_pct, 1)} (endeks %${n(bt.index_cagr_pct, 1)}), en büyük düşüş %${n(bt.max_dd_pct, 1)}. Test iyimser olabilir (bugünkü hisse evreni).`);
  return lines.length > 1 ? lines.join('\n') : '';
}

function strategyContext(us: Json | null, exits: Json | null, model: Json | null): string {
  const lines = ['## Strateji ve öğrenme'];
  const sel = exits?.selected?.BIST;
  if (sel) lines.push(`BIST çıkış kuralı: ${sel.desc} — 10 yıllık testte ortalama ${n(sel.avg_r)}R (sabit hedef ${n(sel.base_avg_r)}R)`);
  if (us?.report) {
    const i = us.report[us.recommended];
    const e = us.report[us.experiment];
    if (i && e) lines.push(`ABD: risk/getiri en iyisi S&P 500'ü tutmak (yıllık %${n(i.cagr, 1)}, Sharpe ${n(i.sharpe)}); deneysel düzeltilmiş momentum yıllık %${n(e.cagr, 1)} ama düşüş %${n(e.max_dd, 0)}, canlı test ediliyor. Asistanın kısa vadeli planı ABD'de endeksin gerisinde kaldı.`);
  }
  if (model) lines.push(`Öğrenen model: ${model.reliable ? 'sıralamayı yapıyor' : 'henüz kurallardan iyi değil, sıralamayı kurallar yapıyor'}; olasılık isabeti AUC ${n(model.metrics?.clf?.auc)}`);
  return lines.length > 1 ? lines.join('\n') : '';
}

function portfolioContext(pos: NonNullable<ChatRequest['portfolio']>, stocks: Map<string, Json>): string {
  if (!pos.length) return '## Kullanıcının portföyü\nPortföy boş.';
  return ['## Kullanıcının portföyü (uygulamada girdiği pozisyonlar)', ...pos.slice(0, 15).map((p) => {
    const s = stocks.get(`${p.market}:${p.symbol}`);
    const pnl = s ? ((s.close / p.cost - 1) * 100) : null;
    return `- ${p.symbol} (${p.market}): ${p.qty} adet, maliyet ${n(p.cost)}${s ? `, son ${n(s.close)} (${pnl != null ? `%${n(pnl, 1)}` : ''}), görünüm ${s.outlook}, stop ${n(s.stop)}, risk ${s.overall_risk}` : ''}`;
  })].join('\n');
}

// ------------------------------------------------------------------ istem

const SYSTEM = [
  'Sen "Trader Asistanı" uygulamasının asistanısın; Türkçe, sade ve kısa (en fazla ~180 kelime) cevap ver.',
  'SADECE aşağıdaki BAĞLAM bölümündeki verileri kullan. Bağlamda olmayan fiyat, rakam, tarih ya da haber uydurma;',
  'veri yoksa "bu konuda verim yok" de. Rakamları bağlamdaki gibi yaz.',
  'Kesin "al" ya da "sat" deme ve getiri vaat etme. "Alayım mı" gibi sorularda: görünümü, varsa asistanın planını',
  '(giriş, stop, çıkış), lehte ve aleyhte noktaları ve en önemli riski anlat; kararın kullanıcıya ait olduğunu tek cümleyle belirt.',
  'Teknik terimleri (RSI, göreli güç, R, iz süren stop) gerekirse bir cümleyle açıkla. Gerekirse kısa madde işaretleri kullan.',
  'Asistan listesindeki hisseler ile kullanıcının portföyünü karıştırma. Uygulamanın test sonuçlarını dürüstçe aktar',
  '(ör. ABD stratejisinin endeksin gerisinde kaldığı).',
].join(' ');

export async function buildContext(req: ChatRequest, dataUrl: string, agenda: Json | null):
  Promise<{ context: string; sources: ChatSource[] }> {
  const question = req.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '';
  const meta = await getJson(`${dataUrl}/watch_meta.json`);
  const bist = new Set<string>(meta?.bist ?? []);
  const us = new Set<string>(Object.keys(meta?.yf ?? {}));
  const found = detectSymbols(question, bist, us, meta?.names ?? {});
  if (req.symbol && req.market && !found.some((f) => f.symbol === req.symbol)) found.unshift({ symbol: req.symbol, market: req.market });
  const intents = detectIntents(question);
  const market: 'BIST' | 'US' = found[0]?.market ?? req.market ?? (/\b(abd|amerika|s&p|nasdaq)\b/.test(trLower(question)) ? 'US' : 'BIST');
  const sources: ChatSource[] = [];
  const parts: string[] = [];

  const asst = await getJson(`${dataUrl}/assistant.json`);
  const stocks = new Map<string, Json>();
  for (const f of found.slice(0, 3)) {
    const s = await getJson(`${dataUrl}/stock/${f.market}/${encodeURIComponent(f.symbol)}.json`);
    if (!s) continue;
    stocks.set(`${f.market}:${f.symbol}`, s);
    const cand = (asst?.markets?.[f.market]?.candidates as Json[] | undefined)?.find((c) => c.symbol === f.symbol) ?? null;
    parts.push(stockContext(s, cand));
    sources.push({ kind: 'stock', label: f.symbol, symbol: f.symbol, market: f.market });
  }
  if (intents.includes('portfolio') && req.portfolio) {
    for (const p of req.portfolio.slice(0, 10)) {
      if (stocks.has(`${p.market}:${p.symbol}`)) continue;
      const s = await getJson(`${dataUrl}/stock/${p.market}/${encodeURIComponent(p.symbol)}.json`);
      if (s) stocks.set(`${p.market}:${p.symbol}`, s);
    }
    parts.push(portfolioContext(req.portfolio, stocks));
    sources.push({ kind: 'portfolio', label: 'Portföyün' });
  }
  if (intents.includes('candidates') || (!found.length && !intents.length)) {
    const c = asst ? candidatesContext(asst, market) : '';
    if (c) {
      parts.push(c);
      sources.push({ kind: 'assistant', label: `Bugünkü liste (${market === 'BIST' ? 'BIST' : 'ABD'})`, market });
    }
  }
  if (intents.includes('market') || intents.includes('candidates') || (!found.length && !intents.length)) {
    const m = await getJson(`${dataUrl}/market.json`);
    const c = m ? marketContext(m, market) : '';
    if (c) {
      parts.push(c);
      sources.push({ kind: 'market', label: 'Piyasa', market });
    }
  }
  if ((intents.includes('agenda') || market === 'BIST') && agenda) {
    parts.push(agendaContext(agenda));
    sources.push({ kind: 'agenda', label: 'Gündem' });
  }
  if (intents.includes('performance')) {
    const p = await getJson(`${dataUrl}/paper.json`);
    const c = p ? paperContext(p, market) : '';
    if (c) {
      parts.push(c);
      sources.push({ kind: 'paper', label: 'Sanal portföy', market });
    }
  }
  if (intents.includes('strategy') || intents.includes('performance') || market === 'US') {
    const [usS, ex, model] = await Promise.all([getJson(`${dataUrl}/us_strategy.json`), getJson(`${dataUrl}/exits.json`),
      getJson(`${dataUrl}/model.json`)]);
    const c = strategyContext(usS, ex, model);
    if (c) {
      parts.push(c);
      sources.push({ kind: 'strategy', label: 'Strateji ve testler' });
    }
  }
  return { context: parts.join('\n\n').slice(0, 14000), sources };
}

export function chatPrompt(req: ChatRequest, context: string): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const history = req.messages.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const last = history.pop();
  return [
    { role: 'system', content: `${SYSTEM}\n\nBAĞLAM (uygulamanın verileri; bugün ${new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10)}):\n${context || 'Bu soru için uygun veri bulunamadı.'}` },
    ...history,
    { role: 'user', content: last?.content ?? '' },
  ];
}

export function cleanAnswer(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 3000);
}

type AiResult = { response?: unknown; choices?: { message?: { content?: unknown } }[] };

export async function answer(ai: Ai, req: ChatRequest, context: string): Promise<string | null> {
  const res = (await ai.run(AI_MODEL as Parameters<Ai['run']>[0], {
    messages: chatPrompt(req, context), max_tokens: 700, temperature: 0.3, ...MODEL_OPTIONS[AI_MODEL],
  } as never)) as AiResult;
  const raw = typeof res.response === 'string' ? res.response : res.choices?.[0]?.message?.content;
  return typeof raw === 'string' && raw.trim() ? cleanAnswer(raw) : null;
}
