// Haftalık karne: cuma akşamı (BIST taraması yayınlandıktan sonra) tek bildirim. Sanal portföyün bu haftaki getirisi
// endekse karşı, bu hafta kapanan asistan işlemleri ve takipteki planlar. Sonuçlar iyi de kötü de olsa aynen yazılır.

import type { PlanStatus, TrackedPlan } from './plans';

export const WEEKLY_FROM_MIN = 17 * 60; // UTC 17:00 = İstanbul 20:00 (BIST taraması ~19:00'da yayınlanır)
export const WEEKLY_TO_MIN = 20 * 60; // 23:00'dan sonra gece saatleri

export function weeklyTime(now = Date.now()): boolean {
  const d = new Date(now);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return d.getUTCDay() === 5 && m >= WEEKLY_FROM_MIN && m < WEEKLY_TO_MIN;
}

export interface PaperLive { curve: [string, number, number][]; return_pct: number; index_return_pct: number; start: string }
export interface ScoreTrade { symbol: string; status: string; r: number | null; exit_date: string | null }

const pct = (v: number) => `${v >= 0 ? '+' : '−'}%${Math.abs(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
const rs = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}R`;

/** Son 7 gündeki değişim: portföy ve endeks (eğrideki son nokta ile 7 gün önceki ya da önceki son nokta). */
export function weekChange(curve: [string, number, number][], today: string): { eq: number; ix: number } | null {
  if (curve.length < 2) return null;
  const from = new Date(Date.parse(today) - 7 * 86400_000).toISOString().slice(0, 10);
  const last = curve[curve.length - 1];
  const base = [...curve].reverse().find(([d]) => d <= from) ?? curve[0];
  if (base === last) return null;
  return { eq: (last[1] / base[1] - 1) * 100, ix: (last[2] / base[2] - 1) * 100 };
}

export function weeklyReport(x: {
  today: string;
  paper: PaperLive | null;
  trades: ScoreTrade[];
  plans: { p: TrackedPlan; s: PlanStatus | undefined }[];
}): { title: string; body: string } | null {
  const parts: string[] = [];
  const wk = x.paper ? weekChange(x.paper.curve, x.today) : null;
  if (x.paper && wk) {
    parts.push(`Sanal portföy (BIST) bu hafta ${pct(wk.eq)} (BIST 100 ${pct(wk.ix)}); ${x.paper.start}'den beri ${pct(x.paper.return_pct)}`
      + ` (endeks ${pct(x.paper.index_return_pct)})`);
  }
  const from = new Date(Date.parse(x.today) - 7 * 86400_000).toISOString().slice(0, 10);
  const closed = x.trades.filter((t) => t.exit_date && t.exit_date > from && t.r != null && t.status !== 'open');
  if (closed.length) {
    const avg = closed.reduce((a, t) => a + t.r!, 0) / closed.length;
    const wins = closed.filter((t) => t.r! > 0).length;
    parts.push(`Bu hafta kapanan ${closed.length} işlem: ${wins} kâr, ortalama ${rs(avg)}`);
  } else {
    parts.push('Bu hafta kapanan işlem yok');
  }
  const open = x.plans.filter(({ s }) => s?.status === 'open');
  const exits = x.plans.filter(({ s }) => s && s.status !== 'open');
  if (x.plans.length) {
    const tot = open.reduce((a, { s }) => a + (s?.r ?? 0), 0);
    parts.push(`Planların: ${open.length} açık${open.length ? ` (toplam ${rs(tot)})` : ''}`
      + (exits.length ? `, ${exits.length} plana göre çıkışta: ${exits.map(({ p }) => p.symbol).join(', ')}` : ''));
  }
  if (!parts.length) return null;
  return { title: 'Haftalık karne', body: `${parts.join('. ')}.`.slice(0, 400) };
}
