import type { Market } from './types';

export function currency(market: Market): string {
  return market === 'BIST' ? '₺' : '$';
}

export function price(v: number | null | undefined, market?: Market): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 3;
  const s = v.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return market ? `${s} ${currency(market)}` : s;
}

/** Para tutarı (kâr/zarar, kayıp): her zaman 2 ondalık, binlik ayraçlı. */
export function money(v: number | null | undefined, market?: Market): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return market ? `${s} ${currency(market)}` : s;
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function score(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${Math.round(v)}`;
}

export function num(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

/** Gün içi fiyatın zamanı: bugünse saat, değilse tarih; BIST için gecikme notu. "14:30 · 15 dk gecikmeli" */
export function quoteTime(q: { time: string; delayed: boolean }): string {
  const d = new Date(q.time);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  const when = today
    ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  return q.delayed ? `${when} · 15 dk gecikmeli` : `${when} · anlık`;
}

export function marketLabel(m: Market): string {
  return m === 'US' ? 'ABD' : 'BIST';
}
