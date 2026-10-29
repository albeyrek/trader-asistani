// Gün içi fiyatlar (Yahoo Finance grafik servisi). BIST verisi ~15 dakika gecikmelidir, ABD neredeyse anlıktır.
// Aynı hisse için sık istek atmamak için yanıtlar Cloudflare önbelleğinde 60 saniye tutulur.

export type Market = 'BIST' | 'US';

export interface Quote {
  price: number;
  prev_close: number;
  change_pct: number;
  time: string; // son işlemin zamanı (ISO)
  delayed: boolean; // BIST: ücretsiz veri ~15 dk gecikmeli
}

const CACHE_SECONDS = 60;

/** Uygulamadaki kod -> Yahoo kodu (BIST: THYAO -> THYAO.IS, ABD: BRK.B -> BRK-B). */
export function yahooSymbol(symbol: string, market: Market): string {
  return market === 'BIST' ? `${symbol}.IS` : symbol.replace(/\./g, '-');
}

export async function fetchQuote(yf: string, market: Market): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?interval=1d&range=1d`;
  const cache = caches.default;
  const cacheKey = new Request(url);
  let res = await cache.match(cacheKey);
  if (!res) {
    const live = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    if (!live.ok) return null;
    res = new Response(live.body, live);
    res.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
    await cache.put(cacheKey, res.clone());
  }
  type Meta = { regularMarketPrice?: number; chartPreviousClose?: number; regularMarketTime?: number };
  const body = (await res.json()) as { chart?: { result?: { meta?: Meta }[] } };
  const m = body.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice || !m.chartPreviousClose || !m.regularMarketTime) return null;
  return {
    price: m.regularMarketPrice,
    prev_close: m.chartPreviousClose,
    change_pct: (m.regularMarketPrice / m.chartPreviousClose - 1) * 100,
    time: new Date(m.regularMarketTime * 1000).toISOString(),
    delayed: market === 'BIST',
  };
}
