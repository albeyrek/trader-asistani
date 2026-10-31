// Asistan: günün alım adayları (GitHub Pages'teki assistant.json, backend/scanner/assistant.py) için
//  - Cloudflare Workers AI ile Türkçe yorum paragrafı (ücretsiz kota: günde 10.000 "neuron"; aday başına ~100)
//  - liste bildirimi ("Asistan · BIST: 3 alım adayı") ve gün içi aday takibi (açılış özeti, stop altı uyarısı)
// Yapay zekâ yorumu gelmezse uygulama kural tabanlı yorumu (commentary) gösterir.

import type { Market, Quote } from './quotes';

export const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MAX_TRIES = 3;

export interface Check {
  label: string;
  ok: boolean;
  text: string;
}

export interface Candidate {
  symbol: string;
  market: Market;
  name: string;
  sector: string | null;
  close: number;
  change_pct: number | null;
  combined_score: number;
  rs_rating: number;
  rsi: number;
  setup: 'breakout' | 'pullback' | 'trend';
  setup_text: string;
  entry_low: number;
  entry_high: number;
  stop: number;
  target1: number;
  target2: number;
  rr: number;
  risk_pct: number;
  projected: boolean;
  checks: Check[];
  reasons: string[];
  news: { title: string; sentiment: number; date: string | null; source: string }[];
  earnings_date: string | null;
  earnings_status: string | null;
  commentary: string;
  ai?: string; // bu Worker ekler
}

export interface AssistantMarket {
  date: string;
  regime: { label: string; score: number; summary: string };
  risk_scale: number;
  stance: string;
  candidates: Candidate[];
}

export interface AssistantData {
  version: string;
  generated_at: string;
  markets: Partial<Record<Market, AssistantMarket>>;
  disclaimer: string;
}

export interface AiState {
  version: string;
  texts: Record<string, string>; // "PİYASA:tarih:KOD" -> yorum
  tries: Record<string, number>;
  notified: Partial<Record<Market, string>>; // piyasa -> bildirimi gönderilen liste tarihi
  model: string;
  last?: { at: string; generated: number; failed: number; pending: number; sent: number; error?: string };
}

export function candidateKey(market: string, date: string, symbol: string): string {
  return `${market}:${date}:${symbol}`;
}

export function fmt(v: number): string {
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 3;
  return v.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v: number, digits = 1): string {
  return `%${Math.abs(v).toFixed(digits).replace('.', ',')}`;
}

// ------------------------------------------------------------------ yapay zekâ yorumu

const SYSTEM = [
  'Sen deneyimli ve temkinli bir borsa analistisin. Sana bir hissenin grafik, haber ve piyasa verileri ile',
  'otomatik hazırlanmış bir işlem planı verilecek. Bunları Türkçe, 4-5 cümlelik TEK bir paragrafta yorumla:',
  'grafikte ne olduğunu, haberlerin ve piyasa ortamının ne anlama geldiğini, işlem planını (giriş aralığı, stop,',
  'hedef) ve en önemli riski anlat.',
  'Kurallar: Sadece verilen verileri kullan, yeni sayı, tarih ya da olay uydurma; sayıları verildiği gibi yaz.',
  '"Kesin", "garanti", "mutlaka" gibi kelimeler kullanma; "aday", "düşünülebilir", "izlenebilir" gibi temkinli',
  'ifadeler kullan. Yatırım tavsiyesi uyarısı ekleme (uygulama zaten gösteriyor). Başlık, madde işareti,',
  'markdown ya da emoji kullanma. Hisseye kod adıyla değin.',
].join(' ');

function currency(m: Market): string {
  return m === 'BIST' ? '₺' : '$';
}

export function buildPrompt(c: Candidate, mk: AssistantMarket): { role: 'system' | 'user'; content: string }[] {
  const cur = currency(c.market);
  const p = (v: number) => `${fmt(v)} ${cur}`;
  const lines = [
    `Hisse: ${c.symbol} (${c.name}), ${c.market === 'BIST' ? 'Borsa İstanbul' : 'ABD borsası'}${c.sector ? `, sektör: ${c.sector}` : ''}`,
    `Son kapanış: ${p(c.close)}${c.change_pct != null ? ` (günlük ${c.change_pct >= 0 ? '+' : '-'}${pct(c.change_pct)})` : ''}`,
    `Kurulum tipi: ${c.setup_text}`,
    `Teknik skor: ${Math.round(c.combined_score)} (-100 ile +100 arası); göreli güç: ${c.rs_rating}/99; RSI: ${Math.round(c.rsi)}`,
    `Grafik gerekçeleri: ${c.reasons.join('; ') || 'yok'}`,
    `Lehte ve aleyhte maddeler: ${c.checks.map((x) => `${x.ok ? '[+]' : '[-]'} ${x.label}: ${x.text}`).join('; ')}`,
    `Son haber başlıkları: ${
      c.news.length
        ? c.news.map((n) => `[${n.sentiment > 0 ? 'olumlu' : n.sentiment < 0 ? 'olumsuz' : 'nötr'}] ${n.title}${n.date ? ` (${n.date})` : ''}`).join(' | ')
        : 'kayda değer haber yok'
    }`,
    `Piyasa rejimi: ${mk.regime.label}. ${mk.regime.summary}`,
    `İşlem planı: giriş aralığı ${fmt(c.entry_low)}–${p(c.entry_high)}; stop ${p(c.stop)} (girişe göre risk ${pct(c.risk_pct)}); ` +
      `1. hedef ${p(c.target1)}; 2. hedef ${p(c.target2)}; ödül/risk ${c.rr.toFixed(1).replace('.', ',')}` +
      (c.projected ? ' (fiyat zirvede, üstte direnç yok; hedefler stop mesafesinin katları)' : ''),
    c.earnings_date ? `Bilanço tarihi: ${c.earnings_date}${c.earnings_status === 'estimated' ? ' (tahmini)' : ''}` : '',
  ].filter(Boolean);
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

const BANNED = /\b(kesinlikle|garanti(li)?|mutlaka)\b/i;

/** Model çıktısını temizler; uygunsuzsa null (kural tabanlı yorum gösterilir). */
export function cleanText(raw: string, symbol: string): string | null {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  t = t.replace(/[*_#`>]+/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s*\n+\s*/g, ' ').trim();
  if (t.length < 120 || t.length > 1400) return null;
  if (BANNED.test(t)) return null;
  if (!t.includes(symbol)) return null;
  if (/[一-龥]|[Ѐ-ӿ]/.test(t)) return null; // başka dile kaymış
  return t;
}

type AiResult = { response?: unknown; choices?: { message?: { content?: unknown } }[] };

/** Modele göre ek ayar: akıl yürüten modellerde düşünmeyi kıs (yoksa token sınırı düşünmeye harcanıyor). */
export const MODEL_OPTIONS: Record<string, Record<string, unknown>> = {
  '@cf/google/gemma-4-26b-a4b-it': { chat_template_kwargs: { enable_thinking: false } },
  '@cf/openai/gpt-oss-120b': { reasoning_effort: 'low' },
  '@cf/qwen/qwen3.8-27b': { chat_template_kwargs: { enable_thinking: false } },
};

export async function generate(ai: Ai, c: Candidate, mk: AssistantMarket, model = AI_MODEL): Promise<string | null> {
  const res = (await ai.run(model as Parameters<Ai['run']>[0], {
    messages: buildPrompt(c, mk), max_tokens: 1200, temperature: 0.4, ...MODEL_OPTIONS[model],
  } as never)) as AiResult;
  const raw = typeof res.response === 'string' ? res.response : res.choices?.[0]?.message?.content;
  return typeof raw === 'string' ? cleanText(raw, c.symbol) : null;
}

/** Sırada bekleyen (yorumu olmayan, deneme hakkı bitmemiş) adaylar. */
export function pending(data: AssistantData, st: AiState): { key: string; c: Candidate; mk: AssistantMarket }[] {
  const out = [];
  for (const mk of Object.values(data.markets)) {
    if (!mk) continue;
    for (const c of mk.candidates) {
      const key = candidateKey(c.market, mk.date, c.symbol);
      if (!st.texts[key] && (st.tries[key] ?? 0) < MAX_TRIES) out.push({ key, c, mk });
    }
  }
  return out;
}

/** Yorumu bitmiş liste için hâlâ geçerli olan anahtarlar dışındakileri at (KV kaydı küçük kalsın). */
export function prune(data: AssistantData, st: AiState): void {
  const live = new Set<string>();
  for (const mk of Object.values(data.markets)) for (const c of mk?.candidates ?? []) live.add(candidateKey(c.market, mk!.date, c.symbol));
  for (const k of Object.keys(st.texts)) if (!live.has(k)) delete st.texts[k];
  for (const k of Object.keys(st.tries)) if (!live.has(k)) delete st.tries[k];
}

export function merge(data: AssistantData, st: AiState | null): AssistantData & { ai_model: string | null } {
  const markets: AssistantData['markets'] = {};
  for (const [m, mk] of Object.entries(data.markets) as [Market, AssistantMarket][]) {
    markets[m] = {
      ...mk,
      candidates: mk.candidates.map((c) => {
        const ai = st?.texts[candidateKey(c.market, mk.date, c.symbol)];
        return ai ? { ...c, ai } : c;
      }),
    };
  }
  return { ...data, markets, ai_model: st?.model ?? null };
}

// ------------------------------------------------------------------ bildirimler

/** İstanbul saatiyle 07:00-22:59 dışında liste bildirimi bekletilir (ABD listesi gece 01:30'da değil sabah gelir). */
export function quietHours(now = Date.now()): boolean {
  const h = new Date(now + 3 * 3600_000).getUTCHours();
  return h < 7 || h >= 23;
}

export function listMessage(market: Market, mk: AssistantMarket): { title: string; body: string } {
  const name = market === 'BIST' ? 'BIST' : 'ABD';
  const n = mk.candidates.length;
  if (!n) {
    return { title: `🤖 Asistan · ${name}: bugün aday yok`, body: `Piyasa: ${mk.regime.label}. ${mk.stance}`.slice(0, 178) };
  }
  const syms = mk.candidates.map((c) => c.symbol).join(', ');
  const scale = mk.risk_scale < 1 ? ` · pozisyonu ${mk.risk_scale === 0.5 ? 'yarıya' : 'biraz'} küçült` : '';
  return { title: `🤖 Asistan · ${name}: ${n} alım adayı`, body: `${syms} · Piyasa: ${mk.regime.label}${scale}`.slice(0, 178) };
}

export type CandidateStatus = 'in_zone' | 'above' | 'below' | 'stopped';

export function candidateStatus(c: Candidate, q: Quote): CandidateStatus {
  if (q.price <= c.stop) return 'stopped';
  if (q.price > c.entry_high) return 'above';
  if (q.price < c.entry_low) return 'below';
  return 'in_zone';
}

const STATUS_TEXT: Record<CandidateStatus, string> = {
  in_zone: 'giriş bölgesinde',
  above: 'bölgenin üstünde (kovalamayın)',
  below: 'bölgenin altında',
  stopped: 'stop altında, plan geçersiz',
};

/** Açılış özeti: "🤖 BIST açılış · ENERY giriş bölgesinde, USHOL bölgenin üstünde (kovalamayın)". */
export function openingMessage(market: Market, rows: { c: Candidate; q: Quote }[]): { title: string; body: string } {
  const name = market === 'BIST' ? 'BIST' : 'ABD';
  const inZone = rows.filter((r) => candidateStatus(r.c, r.q) === 'in_zone').length;
  const body = rows
    .map((r) => `${r.c.symbol} ${fmt(r.q.price)}: ${STATUS_TEXT[candidateStatus(r.c, r.q)]}`)
    .join(' · ');
  return { title: `🤖 ${name} açılış · ${inZone}/${rows.length} aday giriş bölgesinde`, body: body.slice(0, 178) };
}

export function stoppedMessage(c: Candidate, q: Quote): { title: string; body: string } {
  const cur = currency(c.market);
  return {
    title: `❌ ${c.symbol}: asistan planı geçersiz`,
    body: `Fiyat ${fmt(q.price)} ${cur}, plandaki stop ${fmt(c.stop)} ${cur} altında. Pozisyon açtıysanız planı gözden geçirin.`,
  };
}
