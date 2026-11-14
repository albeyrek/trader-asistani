// Trader Asistanı bulut bekçisi (Cloudflare Worker)
//  - POST /api/devices : uygulama bildirim adresini ve izleme listesini kaydeder (KV)
//  - GET  /api/quotes  : izleme listesi için gün içi fiyatlar (?s=BIST:THYAO,US:AAPL)
//  - GET  /api/status  : son turların özeti
//  - her 5 dakikada (cron): KAP + izlenen hisselerin haberleri -> sınıflandır -> yenileri bildirim olarak gönder
//  - piyasa saatlerinde 5 dakikada (ayrı cron): izlenen hisselerin fiyatı -> seviye kırılımı/sert hareket bildirimi
//  - GET  /api/assistant : günün alım adayları + yapay zekâ yorumları
//  - 10 dakikada bir (ayrı cron): yeni aday listesi için Workers AI yorumu, ardından liste bildirimi
//  - GET  /api/agenda    : gündem (temalar, sektör etkisi, politik risk, yapay zekâ özeti, takvim)
//  - POST /api/chat      : sohbet asistanı (soruyu uygulamanın verisiyle cevaplar, rakamları doğrular; günlük sınır)
//  - POST /api/chat/feedback : sohbet cevabına 👍/👎 (son 200 değerlendirme KV'de)
//  - 15 dakikada bir (ayrı cron): gündem başlıkları, politik risk; risk yükselince bildirim
// Haber mantığı backend/scanner/watch.py ile aynıdır; kurallar ve eşikler GitHub Pages'teki watch_meta.json'dan gelir.

import { Classifier, trLower, type Rules } from './classify';
import {
  alertTriggered, customAlertText, detectEvents, eventText, fetchQuotes, isFresh, type CustomAlert, type Levels,
  type PriceEvent,
} from './prices';
import {
  AI_MODEL, candidateStatus, generate, listMessage, merge, openingMessage, pending, prune, quietHours, stoppedMessage,
  type AiState, type AssistantData, type AssistantMarket, type Candidate,
} from './assistant';
import {
  aiSummary, calendar, FALLBACK_FEEDS, FEED_MIN_HISTORY_H, fetchFallback, fetchTopic, headlineRate, POLITICAL_KEEP_MS, politicalRisk, riskMessage, summarize, TOPICS,
  type AgendaItem, type AiTheme, type PoliticalRisk,
} from './agenda';
import { answer, buildContext, referenceNumbers, verifyNumbers, type ChatRequest } from './chat';
import { healthAlert, trDay, type Health } from './health';
import { fetchQuote, yahooSymbol, type Market, type Quote } from './quotes';
import { fetchGoogleNewsTr, fetchKap, fetchYahooNews, type NewsItem } from './sources';

// wrangler.toml'daki ikinci cron ile aynı olmalı (UTC; BIST 07:00-15:10, ABD 13:30-21:00 arası)
const PRICE_CRON = '*/5 7-21 * * 1-5';
const MAX_QUOTES = 40; // ücretsiz planda tur başına 50 alt istek sınırı
// wrangler.toml'daki üçüncü cron ile aynı olmalı
const ASSISTANT_CRON = '2-59/10 * * * *';
const AI_PER_RUN = 4; // tur başına en fazla bu kadar yorum (her biri ~10 sn)
const MAX_LIST_AGE_DAYS = 5; // daha eski aday listesi için gün içi takip yapılmaz
// wrangler.toml'daki dördüncü cron ile aynı olmalı
const AGENDA_CRON = '7-59/15 * * * *';
const AGENDA_KEEP_MS = 48 * 3600_000; // başlıklar 48 saat tutulur
// Google "canlı": iki konu grubu da (her biri 30 dakikada bir çekilir) son 75 dakikada en az bir kez alındı.
// Değilse son 6 saatin sayımı eksik kalır; politik risk yayıncı akışlarının kendi olağan seviyesine göre ölçülür.
const SOURCE_LIVE_MS = 75 * 60_000;
const AGENDA_AI_EVERY_MS = 3 * 3600_000; // yapay zekâ özeti en sık 3 saatte bir
const AGENDA_PAUSE_MS = 300; // Google konu aramaları arasında kısa bekleme (art arda istek engellenmesin)
const RISK_NOTIFY_EVERY_MS = 12 * 3600_000; // yüksek risk bildirimi en sık 12 saatte bir

export interface Env {
  KV: KVNamespace;
  AI: Ai;
  DATA_URL: string; // https://albeyrek.github.io/trader-asistani/data
}

interface WatchMeta {
  bist: string[];
  names: Record<string, string>;
  yf: Record<string, string>;
  rules: Rules;
  thresholds: { high_severity: number; soft_categories: string[]; min_abs_sentiment: number; max_per_device: number };
}

interface Device {
  watchlist: { symbol: string; market: 'BIST' | 'US' }[];
  notify_all_severe: boolean;
  notify_price_alerts?: boolean; // eski kayıtlarda yok: açık kabul edilir
  custom_alerts?: CustomAlert[]; // kullanıcının kendi fiyat alarmları (her zaman etkin)
  notify_assistant?: boolean; // asistan listesi ve aday takibi bildirimleri (eski kayıtlarda yok: açık)
  platform: string;
  updated_at: string;
}

const MAX_CUSTOM_ALERTS = 50;
const ALERT_ID_RE = /^[a-z0-9-]{1,40}$/;

interface State {
  seen: Record<string, number>; // anahtar -> görüldüğü zaman (ms)
  /** En az bir tur başarıyla bitti mi? Değilse tur "ilk tur" sayılır ve bildirim gönderilmez.
   *  (Hata kaydı da State yazar; sadece varlığına bakmak bir hatadan sonra bildirim seline yol açar.) */
  ready?: boolean;
  last?: { at: string; devices: number; watched: number; items: number; fresh: number; sent: number; error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SEEN_KEEP_MS = 3 * 86400_000; // KAP ve haberler son 2 günden çekiliyor; 3 gün yeterli
const MAX_WATCHED_FEEDS = 40; // Worker ücretsiz planda tur başına 50 alt istek sınırı var
const TOKEN_RE = /^Expo(nent)?PushToken\[.+\]$/;
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

// ------------------------------------------------------------------ yardımcılar

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

/** Görülen haber anahtarı: KAP için bildirim numarası, diğerleri için normalleştirilmiş başlığın kısa özeti. */
function seenKey(it: NewsItem): string {
  if (it.kapId) return `k${it.kapId}`;
  const norm = it.title.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
  let h = 2166136261; // FNV-1a
  for (const ch of `${it.market}|${it.symbol}|${norm}`) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return `n${(h >>> 0).toString(36)}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** news.py filter_relevant: KAP dışı haberlerde başlıkta hisse kodu ya da şirket adı geçmeli. */
function relevant(it: NewsItem, names: Record<string, string>): boolean {
  if (it.source === 'KAP') return true;
  const w = '[\\p{L}\\p{N}_]';
  if (new RegExp(`(?<!${w})${escapeRe(it.symbol)}(?!${w})`, 'iu').test(it.title)) return true;
  const token = names[`${it.market}:${it.symbol}`];
  return !!token && trLower(it.title).includes(token);
}

// ------------------------------------------------------------------ cihazlar

async function listDevices(env: Env): Promise<Record<string, Device>> {
  const out: Record<string, Device> = {};
  const list = await env.KV.list({ prefix: 'device:' });
  for (const k of list.keys) {
    const d = await env.KV.get<Device>(k.name, 'json');
    if (d) out[k.name.slice('device:'.length)] = d;
  }
  return out;
}

async function registerDevice(req: Request, env: Env): Promise<Response> {
  let body: {
    token?: unknown; watchlist?: unknown; notify_all_severe?: unknown; notify_price_alerts?: unknown;
    custom_alerts?: unknown; notify_assistant?: unknown; platform?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ detail: 'Geçersiz JSON' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!TOKEN_RE.test(token) || token.length > 200) return json({ detail: 'Geçersiz bildirim adresi' }, 422);
  const raw = Array.isArray(body.watchlist) ? body.watchlist.slice(0, 200) : [];
  const watchlist = raw
    .filter((w): w is { symbol: string; market: string } => !!w && typeof w.symbol === 'string' && typeof w.market === 'string')
    .map((w) => ({ symbol: w.symbol.toUpperCase(), market: w.market as 'BIST' | 'US' }))
    .filter((w) => SYMBOL_RE.test(w.symbol) && (w.market === 'BIST' || w.market === 'US'));
  const rawAlerts = Array.isArray(body.custom_alerts) ? body.custom_alerts.slice(0, MAX_CUSTOM_ALERTS) : [];
  const customAlerts: CustomAlert[] = rawAlerts
    .filter((a): a is CustomAlert => !!a && typeof a === 'object')
    .map((a) => ({ id: String(a.id), symbol: String(a.symbol).toUpperCase(), market: a.market, op: a.op, price: Number(a.price) }))
    .filter((a) => ALERT_ID_RE.test(a.id) && SYMBOL_RE.test(a.symbol) && (a.market === 'BIST' || a.market === 'US')
      && (a.op === 'above' || a.op === 'below') && Number.isFinite(a.price) && a.price > 0);
  const device: Omit<Device, 'updated_at'> = {
    watchlist,
    notify_all_severe: body.notify_all_severe !== false,
    notify_price_alerts: body.notify_price_alerts !== false,
    custom_alerts: customAlerts,
    notify_assistant: body.notify_assistant !== false,
    platform: typeof body.platform === 'string' ? body.platform.slice(0, 20) : 'android',
  };
  // KV ücretsiz planda günde 1000 yazma: değişmediyse yazma
  const key = `device:${token}`;
  const prev = await env.KV.get<Device>(key, 'json');
  if (!prev || JSON.stringify({ ...prev, updated_at: undefined }) !== JSON.stringify({ ...device, updated_at: undefined })) {
    await env.KV.put(key, JSON.stringify({ ...device, updated_at: new Date().toISOString() }));
  }
  return json({ ok: true, watching: watchlist.length });
}

// ------------------------------------------------------------------ bildirim

interface Classified extends NewsItem {
  sentiment: number;
  categories: string[];
  routine: boolean;
}

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound: 'default';
  priority?: 'high';
  channelId: 'default';
}

function hardCategories(it: Classified, meta: WatchMeta): string[] {
  return it.categories.filter((c) => !meta.thresholds.soft_categories.includes(c));
}

function isSevere(it: Classified, meta: WatchMeta): boolean {
  return it.sentiment <= meta.thresholds.high_severity && hardCategories(it, meta).length > 0;
}

function message(token: string, it: Classified, severe: boolean, meta: WatchMeta): PushMessage {
  let title: string;
  if (severe) {
    title = `⚠️ ${it.symbol}: Ciddi risk (${hardCategories(it, meta).join(', ')})`;
  } else {
    const tone = it.sentiment > 0.05 ? 'Olumlu' : it.sentiment < -0.05 ? 'Olumsuz' : 'Bilgi';
    title = `${it.symbol} · ${tone}${it.source === 'KAP' ? ' · KAP' : ''}`;
  }
  return {
    to: token, title, body: it.title.slice(0, 178), data: { symbol: it.symbol, market: it.market, url: it.url },
    sound: 'default', priority: 'high', channelId: 'default',
  };
}

function planMessages(fresh: Classified[], devices: Record<string, Device>, meta: WatchMeta): PushMessage[] {
  const out: PushMessage[] = [];
  const max = meta.thresholds.max_per_device;
  for (const [token, dev] of Object.entries(devices)) {
    const watch = new Set(dev.watchlist.map((w) => `${w.market}:${w.symbol}`));
    const picked: [Classified, boolean][] = [];
    for (const it of fresh) {
      if (it.routine) continue;
      const severe = isSevere(it, meta);
      if (watch.has(`${it.market}:${it.symbol}`)) {
        if (it.source === 'KAP' || Math.abs(it.sentiment) >= meta.thresholds.min_abs_sentiment || severe) picked.push([it, severe]);
      } else if (dev.notify_all_severe && severe) {
        picked.push([it, true]);
      }
    }
    for (const [it, severe] of picked.slice(0, max)) out.push(message(token, it, severe, meta));
    if (picked.length > max) {
      const rest = picked.slice(max);
      const symbols = [...new Set(rest.map(([it]) => it.symbol))].sort().slice(0, 6).join(', ');
      out.push({ to: token, title: `${rest.length} yeni haber daha`, body: `${symbols} için yeni haberler var.`, sound: 'default', channelId: 'default' });
    }
  }
  return out;
}

/** Expo'ya gönderir; uygulamayı silmiş cihazları KV'den çıkarır. Başarılı gönderim sayısını döndürür. */
async function send(messages: PushMessage[], env: Env): Promise<number> {
  let ok = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const r = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    const tickets = ((await r.json()) as { data?: { status: string; details?: { error?: string } }[] }).data ?? [];
    for (let j = 0; j < tickets.length; j++) {
      if (tickets[j].status === 'ok') ok++;
      else if (tickets[j].details?.error === 'DeviceNotRegistered') await env.KV.delete(`device:${batch[j].to}`);
    }
  }
  return ok;
}

// ------------------------------------------------------------------ tur

async function runOnce(env: Env): Promise<State['last']> {
  const devices = await listDevices(env);
  const meta = (await (await fetch(`${env.DATA_URL}/watch_meta.json`)).json()) as WatchMeta;
  const classifier = new Classifier(meta.rules);

  const watched = new Map<string, { symbol: string; market: 'BIST' | 'US' }>();
  for (const d of Object.values(devices)) for (const w of d.watchlist) watched.set(`${w.market}:${w.symbol}`, w);

  let items: NewsItem[] = await fetchKap(new Set(meta.bist));
  for (const w of [...watched.values()].slice(0, MAX_WATCHED_FEEDS)) {
    try {
      items = items.concat(
        w.market === 'BIST' ? await fetchGoogleNewsTr(w.symbol) : await fetchYahooNews(w.symbol, meta.yf[w.symbol] ?? w.symbol),
      );
    } catch {
      // tek hissenin kaynağı çalışmazsa tur devam etsin
    }
  }
  items = items.filter((it) => relevant(it, meta.names));

  const state = (await env.KV.get<State>('state', 'json')) ?? null;
  const bootstrap = !state?.ready;
  const seen = state?.seen ?? {};
  const now = Date.now();
  const fresh: NewsItem[] = [];
  for (const it of items) {
    const k = seenKey(it);
    if (!(k in seen)) fresh.push(it);
    seen[k] = seen[k] ?? now;
  }
  for (const [k, t] of Object.entries(seen)) if (now - t > SEEN_KEEP_MS) delete seen[k];

  // İlk turda mevcut haberler sadece "görüldü" işaretlenir (bildirim seli olmasın)
  let sent = 0;
  let planned = 0;
  if (!bootstrap && fresh.length) {
    const classified: Classified[] = fresh.map((it) => {
      const c = classifier.classify(it.title, it.market === 'BIST' ? 'tr' : 'en', it.kapSubject);
      return { ...it, sentiment: c.sentiment, categories: c.categories, routine: c.routine };
    });
    const messages = planMessages(classified, devices, meta);
    planned = messages.length;
    if (messages.length) sent = await send(messages, env);
  }
  const last = {
    at: new Date().toISOString(), devices: Object.keys(devices).length, watched: watched.size,
    items: items.length, fresh: bootstrap ? 0 : fresh.length, sent, ...(planned > sent ? { error: `${planned - sent} bildirim gönderilemedi` } : {}),
  };
  await env.KV.put('state', JSON.stringify({ seen, last, ready: true } satisfies State));
  return last;
}

// ------------------------------------------------------------------ gün içi fiyatlar

interface PriceState {
  alerted: Record<string, string>; // "gün|PİYASA:KOD|olay" -> gönderildiği zaman (aynı olay günde bir kez)
  last?: { at: string; watched: number; quotes: number; fresh: number; events: number; sent: number; error?: string };
}

/** GET /api/quotes?s=BIST:THYAO,US:AAPL -> { quotes: { "BIST:THYAO": Quote, ... } } */
async function quotesEndpoint(url: URL): Promise<Response> {
  const keys = (url.searchParams.get('s') ?? '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter((k) => /^(BIST|US):[A-Z0-9.\-]{1,12}$/.test(k))
    .slice(0, MAX_QUOTES);
  const items = keys.map((key) => {
    const [market, symbol] = key.split(':') as [Market, string];
    return { key, market, yf: yahooSymbol(symbol, market) };
  });
  const quotes = await fetchQuotes(items);
  return new Response(JSON.stringify({ quotes }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' },
  });
}

async function runPrices(env: Env): Promise<PriceState['last']> {
  const allDevices = Object.entries(await listDevices(env));
  // Otomatik seviye alarmları tercihe bağlı; kişisel alarmlar her zaman etkin
  const devices = allDevices.filter(([, d]) => d.notify_price_alerts !== false);
  // Asistan adayları: liste yeni ise ve asistan bildirimi açık cihaz varsa takip edilir
  const asstDevices = allDevices.filter(([, d]) => d.notify_assistant !== false);
  const asst = asstDevices.length ? await fetchAssistant(env) : null;
  const lists = (asst ? (Object.entries(asst.markets) as [Market, AssistantMarket][]) : [])
    .filter(([, mk]) => mk.candidates.length && ageDays(mk.date) <= MAX_LIST_AGE_DAYS);
  const watched = new Set([
    ...devices.flatMap(([, d]) => d.watchlist.map((w) => `${w.market}:${w.symbol}`)),
    ...allDevices.flatMap(([, d]) => (d.custom_alerts ?? []).map((a) => `${a.market}:${a.symbol}`)),
    ...lists.flatMap(([m, mk]) => mk.candidates.map((c) => `${m}:${c.symbol}`)),
  ]);
  if (!watched.size) return { at: new Date().toISOString(), watched: 0, quotes: 0, fresh: 0, events: 0, sent: 0 };

  const levels = (await (await fetch(`${env.DATA_URL}/levels.json`)).json()) as Levels;
  const items = [...watched]
    .filter((k) => levels[k])
    .slice(0, MAX_QUOTES)
    .map((key) => ({ key, market: key.split(':')[0] as Market, yf: levels[key][0] }));
  const quotes = await fetchQuotes(items);

  const now = Date.now();
  const fresh = Object.entries(quotes).filter(([, q]) => isFresh(q, now)); // piyasa kapalıysa eski fiyat: alarm yok
  const events: PriceEvent[] = fresh.flatMap(([key, q]) => detectEvents(key, q, levels[key]));

  const state = (await env.KV.get<PriceState>('price_state', 'json')) ?? { alerted: {} };
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10); // İstanbul günü
  for (const k of Object.keys(state.alerted)) if (!k.startsWith(today)) delete state.alerted[k];
  const newEvents = events.filter((e) => !(`${today}|${e.key}|${e.kind}` in state.alerted));

  const messages: PushMessage[] = [];
  for (const [token, dev] of devices) {
    const watch = new Set(dev.watchlist.map((w) => `${w.market}:${w.symbol}`));
    for (const e of newEvents) {
      if (!watch.has(e.key)) continue;
      const { title, body } = eventText(e);
      messages.push({
        to: token, title, body, data: { symbol: e.symbol, market: e.market },
        sound: 'default', priority: 'high', channelId: 'default',
      });
    }
  }
  // Kişisel alarmlar: koşul sağlandığında alarm başına günde bir kez
  const freshQuotes = Object.fromEntries(fresh);
  const firedAlerts: string[] = [];
  for (const [token, dev] of allDevices) {
    for (const a of dev.custom_alerts ?? []) {
      const q = freshQuotes[`${a.market}:${a.symbol}`];
      const k = `${today}|alert|${a.id}`;
      if (!q || k in state.alerted || !alertTriggered(a, q)) continue;
      const { title, body } = customAlertText(a, q);
      messages.push({
        to: token, title, body, data: { symbol: a.symbol, market: a.market },
        sound: 'default', priority: 'high', channelId: 'default',
      });
      firedAlerts.push(k);
    }
  }

  // Asistan adayları: piyasa açılınca tek bir durum özeti; fiyat stopun altına inerse "plan geçersiz"
  for (const [m, mk] of lists) {
    const rows: { c: Candidate; q: Quote }[] = [];
    for (const c of mk.candidates) {
      const q = freshQuotes[`${m}:${c.symbol}`];
      if (q) rows.push({ c, q });
    }
    const push = (title: string, body: string, data: Record<string, string>) => {
      for (const [token] of asstDevices) messages.push({ to: token, title, body, data, sound: 'default', channelId: 'default' });
    };
    const openKey = `${today}|open|${m}`;
    if (mk.date < today && rows.length * 2 >= mk.candidates.length && !(openKey in state.alerted)) {
      const { title, body } = openingMessage(m, rows);
      push(title, body, { screen: 'assistant', market: m });
      firedAlerts.push(openKey);
    }
    for (const { c, q } of rows) {
      const k = `${today}|cstop|${m}:${c.symbol}`;
      if (candidateStatus(c, q) !== 'stopped' || k in state.alerted) continue;
      const { title, body } = stoppedMessage(c, q);
      push(title, body, { symbol: c.symbol, market: m });
      firedAlerts.push(k);
    }
  }

  const sent = messages.length ? await send(messages, env) : 0;
  const last = {
    at: new Date().toISOString(), watched: watched.size, quotes: Object.keys(quotes).length, fresh: fresh.length,
    events: newEvents.length + firedAlerts.length, sent,
    ...(messages.length > sent ? { error: `${messages.length - sent} bildirim gönderilemedi` } : {}),
  };
  for (const e of newEvents) state.alerted[`${today}|${e.key}|${e.kind}`] = last.at;
  for (const k of firedAlerts) state.alerted[k] = last.at;
  // KV ücretsiz planda günde 1000 yazma: sadece yeni olay olduğunda ya da saatte bir (durum özeti için) yaz
  const prevAt = state.last ? Date.parse(state.last.at) : 0;
  if (newEvents.length || firedAlerts.length || now - prevAt > 3600_000) {
    state.last = last;
    await env.KV.put('price_state', JSON.stringify(state));
  }
  return last;
}

// ------------------------------------------------------------------ gündem

interface AgendaState {
  items: (AgendaItem & { seen: string })[]; // son 48 saat
  political: Record<string, number>; // Google: siyasi gerilim başlığı id -> yayın zamanı (ms), 7 gün
  politicalFeed?: Record<string, number>; // yayıncı akışları: aynı sayaç, ayrı olağan seviye
  feedSince?: number; // yayıncı akışı sayımının başladığı an (ms)
  googleOkAt?: (string | null)[]; // konu grubu başına Google'dan son başarılı çekim
  feedOkAt?: string; // yayıncı akışlarından son başarılı çekim
  cursor: number; // konular iki gruba ayrılır, turlar sırayla birini çeker (alt istek sınırı)
  risk?: PoliticalRisk & { at: string };
  riskNotifiedAt?: string;
  ai?: { at: string; n: number; themes: AiTheme[] };
  last?: { at: string; fetched: number; fresh: number; failed: number; sent: number; fallback?: number; error?: string; fail_reason?: string };
}

const EMPTY_AGENDA: AgendaState = { items: [], political: {}, cursor: 0 };

async function changePct(yf: string, market: Market): Promise<number | null> {
  try {
    const q = await fetchQuote(yf, market);
    // Sadece bugünün (son 20 saatin) işlemi: hafta sonu ve gece eski hareket risk sayılmasın
    return q && Date.now() - Date.parse(q.time) < 20 * 3600_000 ? q.change_pct : null;
  } catch {
    return null;
  }
}

async function runAgenda(env: Env): Promise<AgendaState['last']> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const st: AgendaState = (await env.KV.get<AgendaState>('agenda', 'json')) ?? structuredClone(EMPTY_AGENDA);

  // 1) Konuların yarısı (sırayla): her konu 30 dakikada bir yenilenir
  const groupNo = st.cursor % 2;
  const group = TOPICS.filter((_, i) => i % 2 === groupNo);
  st.cursor = (st.cursor + 1) % 2;
  const known = new Set(st.items.map((it) => it.id));
  let fetched = 0;
  let fresh = 0;
  let failed = 0;
  let failReason: string | undefined;
  let streak = 0; // art arda başarısız konu: Google bu turda engelliyorsa kalan konular denenmez (yükü artırmasın)
  const add = (items: AgendaItem[]) => {
    fetched += items.length;
    for (const it of items) {
      if (known.has(it.id)) continue;
      known.add(it.id);
      st.items.push({ ...it, seen: at });
      fresh++;
      // Google sayacı yalnızca Google başlıklarıyla beslenir (yayıncı akışlarının sayacı ayrı: aşağıda)
      if (!it.fallback && it.themes.some((t) => t.theme === 'gerilim')) st.political[it.id] = Date.parse(it.published ?? at) || now;
    }
  };
  for (const [i, topic] of group.entries()) {
    if (streak >= 2) {
      failed++;
      continue;
    }
    if (i) await new Promise((res) => setTimeout(res, AGENDA_PAUSE_MS));
    try {
      add(await fetchTopic(topic));
      streak = 0;
    } catch (e) {
      failed++;
      streak++;
      failReason ??= String(e).slice(0, 120);
    }
  }
  const googleOk = failed * 2 <= group.length;
  st.googleOkAt = [st.googleOkAt?.[0] ?? null, st.googleOkAt?.[1] ?? null];
  if (googleOk) st.googleOkAt[groupNo] = at;

  // Yayıncıların kendi akışları her turda çekilir: siyasi gerilim başlıkları ayrı bir sayaca yazılır (Google'a
  // ulaşılamadığında politik risk bununla ölçülsün diye olağan seviyesi sürekli güncel kalır). Başlıklar gündem
  // listesine yalnızca Google'ın yarısından fazlası alınamadığında eklenir (gündemin kaynak karışımı değişmesin).
  st.politicalFeed ??= {};
  st.feedSince ??= now;
  let fallback = 0;
  let feedsOk = 0;
  const feeds = await Promise.allSettled(FALLBACK_FEEDS.map((f) => fetchFallback(f)));
  for (const res of feeds) {
    if (res.status !== 'fulfilled') continue; // tek bir yayıncıya ulaşılamaması önemli değil
    feedsOk++;
    for (const it of res.value) {
      if (it.themes.some((t) => t.theme === 'gerilim') && !(it.id in st.politicalFeed)) {
        st.politicalFeed[it.id] = Date.parse(it.published ?? at) || now;
      }
    }
    if (!googleOk) {
      const before = fresh;
      add(res.value);
      fallback += fresh - before;
    }
  }
  if (feedsOk * 2 >= FALLBACK_FEEDS.length) st.feedOkAt = at;
  st.items = st.items.filter((it) => now - Date.parse(it.published ?? it.seen) <= AGENDA_KEEP_MS);
  for (const reg of [st.political, st.politicalFeed]) {
    for (const [id, t] of Object.entries(reg)) if (now - t > POLITICAL_KEEP_MS) delete reg[id];
  }

  // 2) Politik risk: son 6 saatin siyasi gerilim başlıkları (olağan seviyeye göre) + kur ve borsanın bugünkü hareketi.
  // Google canlıysa asıl ölçü o; değilse yayıncı akışları (kendi olağan seviyeleri en az 24 saatlikse); ikisi de
  // yoksa haber bileşeni ölçülemedi sayılır (eksik sayımla risk olduğundan düşük gösterilmesin).
  const googleLive = st.googleOkAt.every((t) => t != null && now - Date.parse(t) <= SOURCE_LIVE_MS);
  const g = headlineRate(Object.values(st.political), now);
  const fr = headlineRate(Object.values(st.politicalFeed), now, st.feedSince);
  const feedLive = !!st.feedOkAt && now - Date.parse(st.feedOkAt) <= SOURCE_LIVE_MS && fr.spanH >= FEED_MIN_HISTORY_H;
  const source = googleLive ? 'google' : feedLive ? 'feeds' : 'none';
  const rate = source === 'feeds' ? fr : g;
  const risk = politicalRisk({
    headlines6h: rate.recent6h, baseline6h: rate.baseline6h, source,
    usdtry: await changePct('USDTRY=X', 'US'), xu100: await changePct('XU100.IS', 'BIST'), xbank: await changePct('XBANK.IS', 'BIST'),
  });
  const prevLevel = st.risk?.level;
  st.risk = { ...risk, at };

  // 3) Risk "Yüksek"e çıkınca bildirim (12 saatte en fazla bir kez, gece saatleri hariç)
  let sent = 0;
  const notifiedAgo = st.riskNotifiedAt ? now - Date.parse(st.riskNotifiedAt) : Infinity;
  if (risk.level === 'Yüksek' && prevLevel !== 'Yüksek' && notifiedAgo > RISK_NOTIFY_EVERY_MS && !quietHours(now)) {
    const top = st.items.filter((it) => it.themes.some((t) => t.theme === 'gerilim'))
      .sort((a, b) => Date.parse(b.published ?? b.seen) - Date.parse(a.published ?? a.seen))[0];
    const { title, body } = riskMessage(risk, top);
    const devices = Object.entries(await listDevices(env)).filter(([, d]) => d.notify_assistant !== false);
    const messages: PushMessage[] = devices.map(([token]) => ({
      to: token, title, body, data: { screen: 'agenda' }, sound: 'default', priority: 'high', channelId: 'default',
    }));
    if (messages.length) sent = await send(messages, env);
    st.riskNotifiedAt = at;
  }

  // 4) Yapay zekâ özeti: en sık 3 saatte bir, gece hariç, yeterince başlık varsa
  const last24 = st.items.filter((it) => now - Date.parse(it.published ?? it.seen) <= 24 * 3600_000);
  const aiAge = st.ai ? now - Date.parse(st.ai.at) : Infinity;
  if (aiAge > AGENDA_AI_EVERY_MS && !quietHours(now) && last24.length >= 20) {
    try {
      // Etiketli (piyasaya dokunan) başlıklar önce, sonra en yeniler
      const ordered = [...last24].sort((a, b) => (b.themes.length ? 1 : 0) - (a.themes.length ? 1 : 0)
        || Date.parse(b.published ?? b.seen) - Date.parse(a.published ?? a.seen));
      const themes = await aiSummary(env.AI, ordered);
      if (themes) st.ai = { at, n: last24.length, themes };
    } catch {
      // kota ya da model hatası: kural tabanlı özet gösterilmeye devam eder
    }
  }

  const last = { at, fetched, fresh, failed, sent, fallback, ...(failReason ? { fail_reason: failReason } : {}) };
  st.last = last;
  await env.KV.put('agenda', JSON.stringify(st));
  return last;
}

function agendaResponse(st: AgendaState | null): unknown {
  const items = st?.items ?? [];
  const { themes, sectors } = summarize(items);
  const istanbulToday = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const headlines = [...items]
    .sort((a, b) => Date.parse(b.published ?? b.seen) - Date.parse(a.published ?? a.seen))
    .slice(0, 80)
    .map(({ seen: _seen, ...it }) => it);
  return {
    updated_at: st?.last?.at ?? null,
    risk: st?.risk ?? null,
    themes, sectors,
    ai: st?.ai ?? null,
    calendar: calendar(istanbulToday),
    headlines,
    disclaimer: 'Gündem başlıkları otomatik toplanır; sektör etkileri genel eğilimlerdir, yatırım tavsiyesi değildir.',
  };
}

// ------------------------------------------------------------------ sohbet

const CHAT_DAILY_LIMIT = 40; // istemci (bildirim adresi ya da IP) başına günlük mesaj
const CHAT_MAX_MESSAGES = 20;
const CHAT_MAX_CHARS = 2000;

/** Günlük sayaç Cloudflare önbelleğinde tutulur (KV'nin günlük 1000 yazma sınırı harcanmasın). Kesin değil ama
 *  ücretsiz yapay zekâ kotasını kötüye kullanıma karşı korumaya yeter. */
async function chatQuota(client: string, kind = 'chat', limit = CHAT_DAILY_LIMIT): Promise<boolean> {
  const day = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const key = new Request(`https://quota.local/${kind}/${day}/${encodeURIComponent(client)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  const used = hit ? Number(await hit.text()) || 0 : 0;
  if (used >= limit) return false;
  await cache.put(key, new Response(String(used + 1), { headers: { 'Cache-Control': 'max-age=90000' } }));
  return true;
}

async function chatEndpoint(req: Request, env: Env): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return json({ detail: 'Geçersiz JSON' }, 400);
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const clean = msgs.slice(-CHAT_MAX_MESSAGES)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_MAX_CHARS) }));
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json({ detail: 'Soru bulunamadı' }, 422);
  const token = typeof body.token === 'string' && TOKEN_RE.test(body.token) ? body.token : null;
  const client = token ?? req.headers.get('CF-Connecting-IP') ?? 'bilinmiyor';
  if (!(await chatQuota(client))) {
    return json({ detail: `Günlük ${CHAT_DAILY_LIMIT} soru sınırına ulaşıldı; yarın tekrar deneyin.` }, 429);
  }
  const request: ChatRequest = {
    messages: clean,
    symbol: typeof body.symbol === 'string' && SYMBOL_RE.test(body.symbol) ? body.symbol : undefined,
    market: body.market === 'BIST' || body.market === 'US' ? body.market : undefined,
    portfolio: Array.isArray(body.portfolio) ? body.portfolio.slice(0, 30).filter((p) => p && SYMBOL_RE.test(String(p.symbol))
      && (p.market === 'BIST' || p.market === 'US') && Number.isFinite(Number(p.qty)) && Number.isFinite(Number(p.cost)))
      .map((p) => ({ symbol: String(p.symbol), market: p.market, qty: Number(p.qty), cost: Number(p.cost) })) : undefined,
  };
  const agendaState = await env.KV.get<AgendaState>('agenda', 'json');
  const agenda = agendaState ? (agendaResponse(agendaState) as Record<string, unknown>) : null;
  const { context, sources } = await buildContext(request, env.DATA_URL, agenda);
  let text: string | null = null;
  try {
    text = await answer(env.AI, request, context);
  } catch (e) {
    return json({ detail: `Yapay zekâ şu an cevap veremedi (${String(e).slice(0, 80)}). Biraz sonra tekrar deneyin.` }, 503);
  }
  if (!text) return json({ detail: 'Yapay zekâ boş cevap döndü; soruyu farklı sormayı deneyin.' }, 503);
  // Rakam doğrulama: cevaptaki sayılar bağlamda ya da kullanıcının sorularında yoksa bir kez daha, daha sıkı
  // talimatla sorulur; daha az doğrulanamayan sayı içeren cevap kullanılır.
  const ref = referenceNumbers(context, ...clean.filter((m) => m.role === 'user').map((m) => m.content));
  let check = verifyNumbers(text, ref);
  let retried = false;
  if (check.unverified.length) {
    retried = true;
    const second = await answer(env.AI, request, context, check.unverified).catch(() => null);
    const c2 = second ? verifyNumbers(second, ref) : null;
    if (second && c2 && c2.unverified.length < check.unverified.length) {
      text = second;
      check = c2;
    }
  }
  return json({
    answer: text, sources, model: AI_MODEL,
    verified: check.unverified.length === 0, checked: check.checked, unverified: check.unverified, retried,
  });
}

interface ChatFeedback {
  at: string;
  rating: 1 | -1;
  question: string;
  answer: string;
  unverified: string[];
  note?: string;
}
const FEEDBACK_KEEP = 200;
const FEEDBACK_DAILY_LIMIT = 30;

/** 👍/👎: son FEEDBACK_KEEP değerlendirme KV'de tutulur (hangi tür sorularda asistanın zayıf olduğunu görmek için). */
async function chatFeedback(req: Request, env: Env): Promise<Response> {
  let body: Partial<ChatFeedback> & { token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ detail: 'Geçersiz JSON' }, 400);
  }
  if (body.rating !== 1 && body.rating !== -1) return json({ detail: 'Değerlendirme 1 ya da -1 olmalı' }, 422);
  if (typeof body.answer !== 'string' || !body.answer.trim()) return json({ detail: 'Cevap bulunamadı' }, 422);
  const token = typeof body.token === 'string' && TOKEN_RE.test(body.token) ? body.token : null;
  if (!(await chatQuota(token ?? req.headers.get('CF-Connecting-IP') ?? 'bilinmiyor', 'feedback', FEEDBACK_DAILY_LIMIT))) {
    return json({ detail: 'Günlük değerlendirme sınırına ulaşıldı' }, 429);
  }
  const entry: ChatFeedback = {
    at: new Date().toISOString(), rating: body.rating,
    question: typeof body.question === 'string' ? body.question.slice(0, 500) : '',
    answer: body.answer.slice(0, 1500),
    unverified: Array.isArray(body.unverified) ? body.unverified.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 20)) : [],
    ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.slice(0, 300) } : {}),
  };
  const list = (await env.KV.get<ChatFeedback[]>('chat_feedback', 'json')) ?? [];
  list.push(entry);
  await env.KV.put('chat_feedback', JSON.stringify(list.slice(-FEEDBACK_KEEP)));
  return json({ ok: true });
}

// ------------------------------------------------------------------ asistan

function ageDays(isoDate: string, now = Date.now()): number {
  return (now - Date.parse(isoDate)) / 86400_000;
}

async function fetchAssistant(env: Env): Promise<AssistantData | null> {
  const r = await fetch(`${env.DATA_URL}/assistant.json`, { cf: { cacheTtl: 60 } });
  return r.ok ? ((await r.json()) as AssistantData) : null; // ilk yayından önce dosya yok
}

/** Yeni aday listesi için yapay zekâ yorumlarını yazar; liste tamamlanınca bildirim gönderir. */
async function runAssistant(env: Env): Promise<AiState['last']> {
  const at = new Date().toISOString();
  const data = await fetchAssistant(env);
  const st: AiState = (await env.KV.get<AiState>('assistant', 'json'))
    ?? { version: '', texts: {}, tries: {}, notified: {}, model: AI_MODEL };
  if (!data) return { at, generated: 0, failed: 0, pending: 0, sent: 0 };
  const before = JSON.stringify(st);
  if (st.model !== AI_MODEL) Object.assign(st, { texts: {}, tries: {}, model: AI_MODEL });
  if (st.version !== data.version) {
    prune(data, st);
    st.version = data.version;
  }

  let generated = 0;
  let failed = 0;
  for (const { key, c, mk } of pending(data, st).slice(0, AI_PER_RUN)) {
    let text: string | null = null;
    try {
      text = await generate(env.AI, c, mk);
    } catch {
      // kota dolduysa ya da model hata verdiyse sonraki turda yeniden denenir (en fazla 3 kez)
    }
    if (text) {
      st.texts[key] = text;
      generated++;
    } else {
      st.tries[key] = (st.tries[key] ?? 0) + 1;
      failed++;
    }
  }
  const left = pending(data, st);

  // Liste bildirimi: piyasanın bütün adayları yorumlandıktan sonra, liste başına bir kez, gece saatleri dışında
  let sent = 0;
  if (!quietHours()) {
    const devices = Object.entries(await listDevices(env)).filter(([, d]) => d.notify_assistant !== false);
    const messages: PushMessage[] = [];
    for (const [m, mk] of Object.entries(data.markets) as [Market, AssistantMarket][]) {
      if (st.notified[m] === mk.date || ageDays(mk.date) > 3 || left.some((p) => p.c.market === m)) continue;
      const { title, body } = listMessage(m, mk);
      for (const [token] of devices) {
        messages.push({ to: token, title, body, data: { screen: 'assistant', market: m }, sound: 'default', channelId: 'default' });
      }
      st.notified[m] = mk.date;
    }
    if (messages.length) sent = await send(messages, env);
  }
  const last = { at, generated, failed, pending: left.length, sent };
  // KV ücretsiz planda günde 1000 yazma: sadece değişiklik varsa yaz
  if (JSON.stringify(st) !== before) {
    st.last = last;
    await env.KV.put('assistant', JSON.stringify(st));
  }
  return last;
}

/** Sistem sağlığı "hata" ya da günlük tarama günlerdir çalışmadıysa günde bir bildirim (bkz. health.ts). */
async function runHealthAlert(env: Env): Promise<void> {
  if (quietHours()) return;
  const r = await fetch(`${env.DATA_URL}/health.json`, { cf: { cacheTtl: 300 } });
  if (!r.ok) return;
  const msg = healthAlert((await r.json()) as Health);
  if (!msg) return;
  const day = trDay();
  if ((await env.KV.get('health_alert')) === day) return;
  const devices = Object.entries(await listDevices(env)).filter(([, d]) => d.notify_assistant !== false);
  const messages: PushMessage[] = devices.map(([token]) => ({
    to: token, title: msg.title, body: msg.body, data: { screen: 'health' }, sound: 'default', channelId: 'default',
  }));
  if (messages.length) await send(messages, env);
  await env.KV.put('health_alert', day);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }
    if (url.pathname === '/api/devices' && req.method === 'POST') return registerDevice(req, env);
    if (url.pathname === '/api/quotes') return quotesEndpoint(url);
    if (url.pathname === '/api/assistant') {
      const data = await fetchAssistant(env);
      if (!data) return json({ detail: 'Asistan verisi henüz yayınlanmadı' }, 404);
      const st = await env.KV.get<AiState>('assistant', 'json');
      return new Response(JSON.stringify(merge(data, st)), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' },
      });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') return chatEndpoint(req, env);
    if (url.pathname === '/api/chat/feedback' && req.method === 'POST') return chatFeedback(req, env);
    if (url.pathname === '/api/agenda') {
      const st = await env.KV.get<AgendaState>('agenda', 'json');
      return new Response(JSON.stringify(agendaResponse(st)), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=120' },
      });
    }
    if (url.pathname === '/api/status') {
      const state = await env.KV.get<State>('state', 'json');
      const prices = await env.KV.get<PriceState>('price_state', 'json');
      const asst = await env.KV.get<AiState>('assistant', 'json');
      const agenda = await env.KV.get<AgendaState>('agenda', 'json');
      const fb = (await env.KV.get<ChatFeedback[]>('chat_feedback', 'json')) ?? [];
      return json({
        chat_feedback: { up: fb.filter((f) => f.rating === 1).length, down: fb.filter((f) => f.rating === -1).length,
          with_unverified: fb.filter((f) => f.unverified.length).length, last_at: fb.at(-1)?.at ?? null },
        last: state?.last ?? null,
        seen: state ? Object.keys(state.seen).length : 0,
        prices: prices?.last ?? null,
        alerts_today: prices ? Object.keys(prices.alerted).length : 0,
        agenda: agenda ? { ...agenda.last, items: agenda.items.length, risk: agenda.risk?.level, risk_score: agenda.risk?.score,
          risk_source: agenda.risk?.components.source ?? 'google', google_ok_at: agenda.googleOkAt ?? null,
          feed_ok_at: agenda.feedOkAt ?? null, feed_since: agenda.feedSince ? new Date(agenda.feedSince).toISOString() : null,
          political: Object.keys(agenda.political).length, political_feed: Object.keys(agenda.politicalFeed ?? {}).length,
          ai_at: agenda.ai?.at ?? null } : null,
        assistant: asst ? { ...asst.last, version: asst.version, texts: Object.keys(asst.texts).length, notified: asst.notified } : null,
      });
    }
    return json({ detail: 'Bulunamadı' }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === AGENDA_CRON) {
      ctx.waitUntil(
        runAgenda(env).catch(async (e: unknown) => {
          const st = await env.KV.get<AgendaState>('agenda', 'json');
          if (!st) return;
          st.last = { ...(st.last ?? { fetched: 0, fresh: 0, failed: 0, sent: 0 }), at: new Date().toISOString(), error: String(e) };
          await env.KV.put('agenda', JSON.stringify(st));
        }),
      );
      return;
    }
    if (event.cron === ASSISTANT_CRON) {
      ctx.waitUntil(runHealthAlert(env).catch(() => {})); // uyarı gönderilemezse sonraki turda yeniden denenir
      ctx.waitUntil(
        runAssistant(env).catch(async (e: unknown) => {
          const st = await env.KV.get<AiState>('assistant', 'json');
          if (!st) return;
          st.last = { ...(st.last ?? { generated: 0, failed: 0, pending: 0, sent: 0 }), at: new Date().toISOString(), error: String(e) };
          await env.KV.put('assistant', JSON.stringify(st));
        }),
      );
      return;
    }
    if (event.cron === PRICE_CRON) {
      ctx.waitUntil(
        runPrices(env).catch(async (e: unknown) => {
          const state = (await env.KV.get<PriceState>('price_state', 'json')) ?? { alerted: {} };
          state.last = { ...(state.last ?? { watched: 0, quotes: 0, fresh: 0, events: 0, sent: 0 }), at: new Date().toISOString(), error: String(e) };
          await env.KV.put('price_state', JSON.stringify(state));
        }),
      );
      return;
    }
    ctx.waitUntil(
      runOnce(env).catch(async (e: unknown) => {
        const state = (await env.KV.get<State>('state', 'json')) ?? { seen: {} };
        state.last = { ...(state.last ?? { devices: 0, watched: 0, items: 0, fresh: 0, sent: 0 }), at: new Date().toISOString(), error: String(e) };
        await env.KV.put('state', JSON.stringify(state));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
