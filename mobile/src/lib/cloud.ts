// Bulut veri kaynağı: günlük tarama sonuçları GitHub Pages'te statik JSON olarak durur
// (bkz. backend/scanner/export.py). Yerel API'nin uç noktaları buradaki dosyalara eşlenir,
// arama ve izleme listesi süzmesi telefonda yapılır.

import type { Market, StockSummary } from './types';

export const DATA_URL = 'https://albeyrek.github.io/trader-asistani/data';
export const WORKER_URL = 'https://trader-asistani.trader-asistani-worker.workers.dev';

const INDEX_TTL_MS = 10 * 60_000;
const indexCache: Partial<Record<Market, { at: number; items: StockSummary[] }>> = {};

type ListResponse = { total: number; items: StockSummary[] };

async function get<T>(file: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${DATA_URL}/${file}`, { signal });
  if (res.status === 404) throw new Error('Bu hisse için veri bulunamadı.');
  if (!res.ok) throw new Error(`Veri alınamadı (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/** Bir piyasadaki tüm hisselerin özet satırları (~1 MB, sıkıştırılmış ~130 KB); 10 dakika bellekte tutulur. */
async function index(market: Market, signal?: AbortSignal): Promise<StockSummary[]> {
  const hit = indexCache[market];
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.items;
  const data = await get<ListResponse>(`${market}/index.json`, signal);
  indexCache[market] = { at: Date.now(), items: data.items };
  return data.items;
}

function trUpper(s: string): string {
  return s.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

function market(v: string | null): Market {
  return v === 'US' ? 'US' : 'BIST';
}

/** Yerel API yolunu (ör. /api/scan?market=BIST&list=up) bulut dosyalarıyla yanıtlar. */
export async function cloudGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, 'http://x');
  const p = url.searchParams;

  if (url.pathname === '/api/meta') return get<T>('meta.json', signal);

  if (url.pathname === '/api/scan') {
    const m = market(p.get('market'));
    const kind = p.get('list') ?? 'up';
    const limit = Number(p.get('limit') ?? 100);
    const q = trUpper((p.get('q') ?? '').trim());
    if (!q) {
      const data = await get<ListResponse>(`${m}/${kind}.json`, signal);
      return { total: data.total, items: data.items.slice(0, limit) } as T;
    }
    let items = (await index(m, signal)).filter(
      (s) => s.symbol.toUpperCase().includes(q) || trUpper(s.name).includes(q),
    );
    if (kind === 'alerts') items = items.filter((s) => s.alerts.length > 0);
    const dir = kind === 'up' ? -1 : 1;
    items = [...items].sort((a, b) => dir * (a.combined_score - b.combined_score));
    return { total: items.length, items: items.slice(0, limit) } as T;
  }

  if (url.pathname === '/api/stocks') {
    const wanted = (p.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const all = [...(await index('BIST', signal)), ...(await index('US', signal))];
    const items = wanted.flatMap((w) => all.filter((s) => s.symbol.toUpperCase() === w));
    return { items } as T;
  }

  const stock = /^\/api\/stock\/(.+)$/.exec(url.pathname);
  if (stock) {
    const symbol = decodeURIComponent(stock[1]).toUpperCase();
    return get<T>(`stock/${market(p.get('market'))}/${encodeURIComponent(symbol)}.json`, signal);
  }

  throw new Error(`Bilinmeyen istek: ${url.pathname}`);
}
