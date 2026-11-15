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
  /** Sunucu doldurur (istemciden alınmaz): cihazın takipteki planları ve bulutta hesaplanan son durumları */
  plans?: ChatPlan[];
}

export interface ChatPlan {
  symbol: string;
  market: 'BIST' | 'US';
  opened: string;
  entry: number;
  stop: number;
  target: number | null;
  trail: number | null;
  hold: number;
  status?: { status: string; stop: number; last: number | null; r: number | null; days: number; exit?: number; exit_date?: string };
}

export interface ChatSource {
  kind: 'stock' | 'agenda' | 'market' | 'assistant' | 'paper' | 'model' | 'portfolio' | 'strategy' | 'plans';
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
  plans: /(planım|planlarım|takipteki|ne zaman sat|satayım mı|satmalı|satsam|kâr al|kar al|çıkayım)/,
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

const PLAN_STATUS: Record<string, string> = {
  open: 'açık', stop: 'stop görüldü: plana göre çıkış', target: 'hedef görüldü: plana göre kâr al', time: 'süre doldu: plana göre çık',
};

export function plansContext(plans: ChatPlan[]): string {
  return ['## Kullanıcının takipteki planları ("bu planla aldım" dediği hisseler; durum her taramadan sonra bulutta hesaplanır)',
    ...plans.slice(0, 15).map((p) => {
      const rule = p.trail ? `iz süren stop ${n(p.trail, 0)} ATR (yalnızca yükselir), en çok ${p.hold} işlem günü`
        : `sabit hedef ${n(p.target)}, en çok ${p.hold} işlem günü`;
      const s = p.status;
      const st = !s ? 'durum henüz hesaplanmadı'
        : `durum ${PLAN_STATUS[s.status] ?? s.status}; ${s.status === 'open' ? `güncel stop ${n(s.stop)}` : `çıkış ${n(s.exit)} (${s.exit_date})`}`
          + `, son kapanış ${n(s.last)}, ${s.r != null ? `${s.r >= 0 ? '+' : ''}${n(s.r)}R` : ''}, ${s.days}. işlem günü`;
      return `- ${p.symbol} (${p.market}): ${p.opened} alış ${n(p.entry)}, ilk stop ${n(p.stop)}, kural: ${rule}; ${st}`;
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
  // Takipteki planlar: plan/stop/çıkış sorulduysa ya da sorulan hisse takipteyse
  const planHits = (req.plans ?? []).filter((p) => found.some((f) => f.symbol === p.symbol && f.market === p.market));
  if (req.plans?.length && (intents.includes('plans') || intents.includes('portfolio') || planHits.length)) {
    parts.push(plansContext(intents.includes('plans') || intents.includes('portfolio') ? req.plans : planHits));
    sources.push({ kind: 'plans', label: 'Takipteki planların' });
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

// ------------------------------------------------------------------ rakam doğrulama
// Yapay zekânın cevabındaki her sayı, ona verilen bağlamda (ve kullanıcının sorularında) aranır. Bulunamayan sayı
// "doğrulanamadı" olarak işaretlenir: uydurma ya da yapay zekânın kendi hesabı olabilir.

export interface NumberToken { raw: string; values: number[]; tol: number; small: boolean }

const SCALE: Record<string, number> = { bin: 1e3, milyon: 1e6, milyar: 1e9, trilyon: 1e12 };
// Endeks ve kod adlarındaki sayılar rakam değildir (BIST 100, S&P 500, XU100, A1CAP)
const NAME_NUMBERS = /\b(?:bist|xu|xbank|s&p|nasdaq|dow|russell|msci)\s?-?\d+|[a-zçğıöşü]\d+[a-z0-9]*/giu;
const DATES = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g;
const NUMBER = /(%\s*)?[-+−]?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s*%)?(\s*(?:bin(?![a-zçğıöşü])|milyon|milyar|trilyon))?/giu;

/** "1.234,56" / "1,234.56" / "12,5" / "%3" / "1,2 milyar" -> olası değerler (biçim belirsizse ikisi de) ve yuvarlama payı. */
export function parseNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const cleaned = text.replace(NAME_NUMBERS, ' ').replace(DATES, (_, y, m, d, d2, m2, y2) =>
    y ? ` ${y} ${m} ${d} ` : ` ${y2} ${m2} ${d2} `)
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ') // saatler
    .replace(/^\s*\d+[.)]\s/gm, ' '); // madde numaraları
  for (const m of cleaned.matchAll(NUMBER)) {
    const body = m[2];
    const pct = !!(m[1] || m[3]);
    const scale = m[4] ? SCALE[m[4].trim().toLocaleLowerCase('tr')] ?? 1 : 1;
    const dot = body.lastIndexOf('.');
    const comma = body.lastIndexOf(',');
    const cands: [number, number][] = []; // [değer, ondalık hane]
    const decimalAt = (sep: number) => [Number(body.slice(0, sep).replace(/[.,]/g, '') + '.' + body.slice(sep + 1)), body.length - sep - 1] as [number, number];
    const thousands = () => [Number(body.replace(/[.,]/g, '')), 0] as [number, number];
    if (dot >= 0 && comma >= 0) cands.push(decimalAt(Math.max(dot, comma)));
    else if (dot >= 0 || comma >= 0) {
      const sep = Math.max(dot, comma);
      if (/^\d{1,3}([.,]\d{3})+$/.test(body)) cands.push(thousands(), decimalAt(sep)); // 1.234: bin ya da 1,234
      else cands.push(decimalAt(sep));
    } else cands.push([Number(body), 0]);
    const tol = Math.max(...cands.map(([, d]) => 0.5 * 10 ** -d)) * scale + 1e-9;
    const v0 = cands[0][0];
    out.push({
      raw: m[0].trim(), values: cands.map(([v]) => v * scale), tol,
      // küçük tam sayılar (adet, R katı) ve yıllar her cevapta doğal: kontrol edilmez
      small: !pct && scale === 1 && cands.length === 1 && cands[0][1] === 0 && (v0 <= 10 || (v0 >= 1990 && v0 <= 2100)),
    });
  }
  return out;
}

/** Bağlamdaki tüm sayılar (yüzde/oran dönüşümü dahil). */
export function referenceNumbers(...texts: string[]): number[] {
  const ref: number[] = [];
  for (const t of texts) for (const n of parseNumbers(t)) for (const v of n.values) ref.push(Math.abs(v), Math.abs(v) * 100);
  return ref;
}

/** Cevaptaki bağlamda bulunmayan sayılar (ham yazımlarıyla). */
export function verifyNumbers(answerText: string, ref: number[]): { checked: number; unverified: string[] } {
  const unverified: string[] = [];
  let checked = 0;
  for (const n of parseNumbers(answerText)) {
    if (n.small) continue;
    checked++;
    const ok = n.values.some((v) => ref.some((r) => Math.abs(Math.abs(v) - r) <= n.tol));
    if (!ok && !unverified.includes(n.raw)) unverified.push(n.raw);
  }
  return { checked, unverified };
}

type AiResult = { response?: unknown; choices?: { message?: { content?: unknown } }[] };

/** strict: önceki denemede bağlamda bulunmayan sayılar (ikinci denemede yapay zekâya hatırlatılır). */
export async function answer(ai: Ai, req: ChatRequest, context: string, strict?: string[]): Promise<string | null> {
  const messages = chatPrompt(req, context);
  if (strict?.length) {
    messages[0] = { role: 'system', content: `${messages[0].content}\n\nUYARI: Önceki cevabında bağlamda olmayan şu sayılar vardı: `
      + `${strict.slice(0, 8).join(', ')}. Bu kez YALNIZCA bağlamda yazan rakamları aynen kullan; kendin hesaplama, `
      + 'tahmin ya da yuvarlama yapma. Gerekli rakam bağlamda yoksa rakamsız anlat.' };
  }
  const res = (await ai.run(AI_MODEL as Parameters<Ai['run']>[0], {
    messages, max_tokens: 700, temperature: strict?.length ? 0.1 : 0.3, ...MODEL_OPTIONS[AI_MODEL],
  } as never)) as AiResult;
  const raw = typeof res.response === 'string' ? res.response : res.choices?.[0]?.message?.content;
  return typeof raw === 'string' && raw.trim() ? cleanAnswer(raw) : null;
}
