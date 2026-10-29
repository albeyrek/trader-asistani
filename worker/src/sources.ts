// Haber kaynakları: backend/scanner/news_sources.py'nin bekçi için gereken kısmı.

export interface NewsItem {
  symbol: string;
  market: 'BIST' | 'US';
  source: string;
  published: string | null; // ISO
  title: string;
  url: string;
  kapSubject: string;
  kapId?: number;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const KAP_URL = 'https://www.kap.org.tr/tr/api/disclosure/members/byCriteria';
const KAP_LINK = 'https://www.kap.org.tr/tr/Bildirim/';
// Devre kesici bildirimlerinde hisse kodu özet metninde geçer: "YGGYO.E işlem sırasında ..."
const CIRCUIT_BREAKER_CODE = /^([A-Z0-9]{3,6})\.E\b/;

interface KapRow {
  publishDate: string;
  summary: string | null;
  subject: string | null;
  stockCodes: string | null;
  disclosureIndex: number;
}

function istanbulDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 3 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** "24.10.2026 17:08:16" (İstanbul saati) -> ISO UTC */
function kapDate(s: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy, h, mi, ss] = m;
  return new Date(`${yyyy}-${mm}-${dd}T${h}:${mi}:${ss}+03:00`).toISOString();
}

/** Bugünün ve dünün KAP bildirimleri (gece yarısında kaçırma olmasın diye iki gün). */
export async function fetchKap(bistSymbols: Set<string>): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  for (const day of [istanbulDate(0), istanbulDate(1)]) {
    const r = await fetch(KAP_URL, {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDate: day, toDate: day }),
    });
    if (!r.ok) throw new Error(`KAP HTTP ${r.status}`);
    const rows = (await r.json()) as KapRow[];
    for (const x of rows) {
      const summary = (x.summary ?? '').trim();
      let symbols: string[];
      if (x.stockCodes) {
        symbols = x.stockCodes.split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        const m = CIRCUIT_BREAKER_CODE.exec(summary);
        if (!m) continue; // şirkete özgü olmayan bildirim
        symbols = [m[1]];
      }
      const subject = (x.subject ?? '').trim();
      for (const s of symbols) {
        if (!bistSymbols.has(s)) continue;
        items.push({
          symbol: s, market: 'BIST', source: 'KAP', published: kapDate(x.publishDate),
          title: summary || subject, url: KAP_LINK + x.disclosureIndex, kapSubject: subject, kapId: x.disclosureIndex,
        });
      }
    }
  }
  return items;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .trim();
}

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? decode(m[1]) : '';
}

async function rss(url: string): Promise<{ title: string; url: string; published: string | null }[]> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`RSS HTTP ${r.status}`);
  const xml = await r.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pub = tag(m[1], 'pubDate');
    const d = pub ? new Date(pub) : null;
    out.push({ title: tag(m[1], 'title'), url: tag(m[1], 'link'), published: d && !isNaN(+d) ? d.toISOString() : null });
  }
  return out;
}

export async function fetchGoogleNewsTr(symbol: string, days = 2): Promise<NewsItem[]> {
  const q = encodeURIComponent(`"${symbol}" hisse when:${days}d`);
  const items = await rss(`https://news.google.com/rss/search?q=${q}&hl=tr&gl=TR&ceid=TR:tr`);
  return items.map((it) => {
    // Google başlıkları "Başlık - Kaynak" biçimindedir
    const i = it.title.lastIndexOf(' - ');
    const title = i > 0 ? it.title.slice(0, i) : it.title;
    const publisher = i > 0 ? it.title.slice(i + 3) : '?';
    return { symbol, market: 'BIST', source: `Google Haberler (${publisher})`, published: it.published, title, url: it.url, kapSubject: '' };
  });
}

export async function fetchYahooNews(symbol: string, yfSymbol: string): Promise<NewsItem[]> {
  const items = await rss(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yfSymbol)}&region=US&lang=en-US`);
  return items.map((it) => ({ symbol, market: 'US', source: 'Yahoo Finance', published: it.published, title: it.title, url: it.url, kapSubject: '' }));
}
