// Gün içi seviye alarmları: izleme listesindeki hisselerin fiyatı günlük analizin seviyelerini geçince bildirim.
//  - stop seviyesinin altına iniş
//  - destek kırılımı (aşağı) / direnç kırılımı (yukarı)
//  - önceki kapanışa göre sert hareket (±%5)
// Her olay hisse başına günde bir kez gönderilir.

import { fetchQuote, type Market, type Quote } from './quotes';

/** "PİYASA:KOD" -> [yahoo kodu, son kapanış, destek, direnç, stop] (backend/scanner/export.py) */
export type Levels = Record<string, [string, number | null, number | null, number | null, number | null]>;

export type EventKind = 'stop' | 'support' | 'resistance' | 'move_up' | 'move_down';

export interface PriceEvent {
  key: string; // PİYASA:KOD
  symbol: string;
  market: Market;
  kind: EventKind;
  quote: Quote;
  level: number | null;
}

export const MOVE_ALERT_PCT = 5;
const MAX_QUOTE_AGE_MS = 40 * 60_000; // BIST 15 dk gecikmeli; daha eski fiyat = piyasa kapalı, alarm yok

/** Fiyatı, günlük taramadaki kapanışa göre seviyelerin öbür tarafına geçmiş mi? */
export function detectEvents(key: string, quote: Quote, lv: Levels[string]): PriceEvent[] {
  const [market, symbol] = key.split(':') as [Market, string];
  const [, close, support, resistance, stop] = lv;
  const p = quote.price;
  const out: PriceEvent[] = [];
  const ev = (kind: EventKind, level: number | null) => out.push({ key, symbol, market, kind, quote, level });

  if (close != null) {
    if (stop != null && close > stop && p < stop) ev('stop', stop);
    else if (support != null && close > support && p < support) ev('support', support);
    if (resistance != null && close < resistance && p > resistance) ev('resistance', resistance);
  }
  if (quote.change_pct >= MOVE_ALERT_PCT) ev('move_up', null);
  else if (quote.change_pct <= -MOVE_ALERT_PCT) ev('move_down', null);
  return out;
}

export function isFresh(q: Quote, now = Date.now()): boolean {
  return now - Date.parse(q.time) <= MAX_QUOTE_AGE_MS;
}

function fmt(v: number): string {
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 3;
  return v.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function eventText(e: PriceEvent): { title: string; body: string } {
  const cur = e.market === 'BIST' ? '₺' : '$';
  const chg = `${e.quote.change_pct >= 0 ? '+' : ''}${e.quote.change_pct.toFixed(1).replace('.', ',')}%`;
  const price = `${fmt(e.quote.price)} ${cur}`;
  const lvl = e.level != null ? `${fmt(e.level)} ${cur}` : '';
  const delay = e.quote.delayed ? ' · 15 dk gecikmeli' : '';
  switch (e.kind) {
    case 'stop':
      return { title: `🔻 ${e.symbol}: stop seviyesinin altında`, body: `${price} (stop ${lvl}) · bugün ${chg}${delay}` };
    case 'support':
      return { title: `↘️ ${e.symbol}: destek kırıldı`, body: `${price} (destek ${lvl}) · bugün ${chg}${delay}` };
    case 'resistance':
      return { title: `↗️ ${e.symbol}: direnç yukarı kırıldı`, body: `${price} (direnç ${lvl}) · bugün ${chg}${delay}` };
    case 'move_up':
      return { title: `📈 ${e.symbol}: sert yükseliş ${chg}`, body: `${price}${delay}` };
    case 'move_down':
      return { title: `📉 ${e.symbol}: sert düşüş ${chg}`, body: `${price}${delay}` };
  }
}

/** Birden çok hissenin fiyatı (sırayla; her biri Cloudflare önbelleğinde 60 sn). */
export async function fetchQuotes(items: { key: string; yf: string; market: Market }[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  for (const it of items) {
    try {
      const q = await fetchQuote(it.yf, it.market);
      if (q) out[it.key] = q;
    } catch {
      // tek hissenin fiyatı gelmezse diğerleri devam etsin
    }
  }
  return out;
}
