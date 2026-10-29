// Trader Asistanı bulut bekçisi (Cloudflare Worker)
//  - POST /api/devices : uygulama bildirim adresini ve izleme listesini kaydeder (KV)
//  - GET  /api/status  : son turun özeti
//  - her 5 dakikada (cron): KAP + izlenen hisselerin haberleri -> sınıflandır -> yenileri bildirim olarak gönder
// Mantık backend/scanner/watch.py ile aynıdır; kurallar ve eşikler GitHub Pages'teki watch_meta.json'dan gelir.

import { Classifier, trLower, type Rules } from './classify';
import { fetchGoogleNewsTr, fetchKap, fetchYahooNews, type NewsItem } from './sources';

export interface Env {
  KV: KVNamespace;
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
  platform: string;
  updated_at: string;
}

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
  let body: { token?: unknown; watchlist?: unknown; notify_all_severe?: unknown; platform?: unknown };
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
  const device: Omit<Device, 'updated_at'> = {
    watchlist,
    notify_all_severe: body.notify_all_severe !== false,
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }
    if (url.pathname === '/api/devices' && req.method === 'POST') return registerDevice(req, env);
    if (url.pathname === '/api/status') {
      const state = await env.KV.get<State>('state', 'json');
      return json({ last: state?.last ?? null, seen: state ? Object.keys(state.seen).length : 0 });
    }
    return json({ detail: 'Bulunamadı' }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOnce(env).catch(async (e: unknown) => {
        const state = (await env.KV.get<State>('state', 'json')) ?? { seen: {} };
        state.last = { ...(state.last ?? { devices: 0, watched: 0, items: 0, fresh: 0, sent: 0 }), at: new Date().toISOString(), error: String(e) };
        await env.KV.put('state', JSON.stringify(state));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
