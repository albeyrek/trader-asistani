// Sabah özeti: hafta içi BIST açılmadan önce (09:30) tek bildirim. Günün listesi ve giriş bölgesindekiler, politik risk,
// bugünkü takvim (PPK, TÜİK, Fed), takipteki planlardan stopa yaklaşanlar ve sistem sorunu varsa o.

import type { AssistantMarket } from './assistant';
import type { CalendarEvent } from './agenda';
import type { PlanStatus, TrackedPlan } from './plans';

export const BRIEF_FROM_MIN = 6 * 60 + 30; // UTC 06:30 = İstanbul 09:30
export const BRIEF_TO_MIN = 7 * 60; // 10:00'dan (açılış) sonra gönderilmez

/** Bugün (İstanbul) hafta içi ve sabah özeti saatinde miyiz? */
export function briefTime(now = Date.now()): boolean {
  const d = new Date(now);
  const wd = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= BRIEF_FROM_MIN && m < BRIEF_TO_MIN;
}

const fmt = (v: number) => v.toLocaleString('tr-TR', { maximumFractionDigits: v >= 100 ? 2 : 4 });

export interface BriefInput {
  today: string; // İstanbul günü YYYY-MM-DD
  bist: AssistantMarket | null;
  risk: { level: string; score: number } | null;
  events: CalendarEvent[];
  plans: { p: TrackedPlan; s: PlanStatus | undefined }[];
  healthIssue: string | null;
}

export function morningBrief(x: BriefInput): { title: string; body: string } | null {
  const parts: string[] = [];
  const mk = x.bist;
  // Liste en fazla 4 gün eskiyse (hafta sonu + bayram arifesi); daha eskiyse tatil olabilir
  const listFresh = mk && (Date.parse(x.today) - Date.parse(mk.date)) / 86400_000 <= 4;
  if (mk && listFresh) {
    const n = mk.candidates.length;
    if (n) {
      const inZone = mk.candidates.filter((c) => c.close >= c.entry_low && c.close <= c.entry_high).map((c) => c.symbol);
      parts.push(`Liste: ${mk.candidates.map((c) => c.symbol).join(', ')}`
        + (inZone.length ? ` (giriş bölgesinde: ${inZone.join(', ')})` : ' (hiçbiri giriş bölgesinde değil, bekle)'));
    } else {
      parts.push('Bugün aday yok');
    }
  }
  if (x.risk) parts.push(`Politik risk ${x.risk.level.toLocaleLowerCase('tr')} (${x.risk.score}/100)`);
  const today = x.events.filter((e) => e.date === x.today);
  if (today.length) parts.push(`Bugün: ${today.map((e) => `${e.time} ${e.title}`).join('; ')}`);
  // Takipteki planlar: kapandıysa ya da son kapanış güncel stopa 1 ATR'den yakınsa
  const watch = x.plans.flatMap(({ p, s }) => {
    if (!s) return [];
    if (s.status !== 'open') return [`${p.symbol} plana göre çıkışta`];
    if (s.last != null && s.last - s.stop <= p.atr) return [`${p.symbol} stopa yakın (${fmt(s.stop)})`];
    return [];
  });
  if (watch.length) parts.push(`Planların: ${watch.join(', ')}`);
  else if (x.plans.length) parts.push(`${x.plans.length} plan takipte, hepsi güvende`);
  if (x.healthIssue) parts.push(`Uyarı: ${x.healthIssue}`);
  if (!parts.length) return null;
  return { title: 'Günaydın: borsa açılmadan önce', body: `${parts.join('. ')}.`.slice(0, 400) };
}
