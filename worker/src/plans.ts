// Plan takibi: kullanıcının "bu planla aldım" dediği hisseler. Çıkış kuralı asistanın planındakiyle aynıdır
// (backend/scanner/assistant_track.run_exit): iz süren stop = en yüksek kapanış - trail x ATR (yalnızca yükselir),
// sabit hedef (varsa) ve en uzun tutma süresi. Günlük mumlar GitHub Pages'teki hisse dosyasından gelir (her taramada).
// Sunucuya yalnızca plan gider (kod, giriş, stop, ATR, kural, tarih); adet ve maliyet telefonda kalır.

import type { Market } from './quotes';

export interface TrackedPlan {
  id: string;
  symbol: string;
  market: Market;
  opened: string; // alış günü (YYYY-MM-DD)
  entry: number; // alış fiyatı
  stop: number; // ilk stop
  target: number | null; // sabit hedef (iz süren stop kuralında yok)
  atr: number;
  trail: number | null; // iz süren stop çarpanı (ATR)
  hold: number; // en uzun tutma (işlem günü)
}

export interface Bar { d: string; open: number; high: number; low: number; close: number }

export interface PlanStatus {
  id: string;
  status: 'open' | 'stop' | 'target' | 'time';
  stop: number; // açıksa: bir sonraki gün için geçerli stop; kapandıysa çıkış anındaki stop
  peak: number; // girişten beri en yüksek kapanış
  days: number; // tutulan işlem günü
  last: number | null; // son kapanış
  as_of: string | null; // son mumun tarihi
  exit?: number; // kapandıysa plana göre çıkış fiyatı
  exit_date?: string;
  r: number | null; // (son ya da çıkış - giriş) / ilk risk
}

const MAX_PLANS = 20;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Uygulamadan gelen planları doğrular (bozuk olanlar atılır). */
export function parsePlans(raw: unknown): TrackedPlan[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  return raw.slice(0, MAX_PLANS).flatMap((x): TrackedPlan[] => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const p: TrackedPlan = {
      id: String(o.id), symbol: String(o.symbol).toUpperCase(), market: o.market === 'US' ? 'US' : 'BIST',
      opened: String(o.opened), entry: num(o.entry), stop: num(o.stop),
      target: o.target == null ? null : num(o.target), atr: num(o.atr),
      trail: o.trail == null ? null : num(o.trail), hold: Math.round(num(o.hold)),
    };
    const ok = ID_RE.test(p.id) && SYMBOL_RE.test(p.symbol) && (o.market === 'BIST' || o.market === 'US')
      && DATE_RE.test(p.opened) && p.entry > 0 && p.stop > 0 && p.stop < p.entry && p.atr > 0
      && (p.target === null || p.target > p.entry) && (p.trail === null || (p.trail > 0 && p.trail <= 10))
      && p.hold >= 1 && p.hold <= 250;
    return ok ? [p] : [];
  });
}

/** Planın günlük mumlara göre durumu (alış günü dahil; aynı gün hem stop hem hedef: temkinli olarak stop). */
export function planStatus(p: TrackedPlan, bars: Bar[]): PlanStatus {
  const risk = p.entry - p.stop;
  let cur = p.stop;
  let peak = p.entry;
  let days = 0;
  const after = bars.filter((b) => b.d >= p.opened).sort((a, b) => (a.d < b.d ? -1 : 1));
  const done = (status: PlanStatus['status'], exit: number, b: Bar): PlanStatus => ({
    id: p.id, status, stop: round(cur), peak: round(peak), days, last: b.close, as_of: b.d, exit: round(exit), exit_date: b.d,
    r: round((exit - p.entry) / risk, 2),
  });
  for (const b of after) {
    days++;
    const first = days === 1;
    if (p.trail) cur = Math.max(cur, peak - p.trail * p.atr);
    if (b.low <= cur) return done('stop', !first && b.open < cur ? b.open : cur, b);
    if (p.target != null && b.high >= p.target) return done('target', !first && b.open > p.target ? b.open : p.target, b);
    peak = Math.max(peak, b.close);
    if (days >= p.hold) return done('time', b.close, b);
  }
  const lastBar = after.at(-1);
  const next = p.trail ? Math.max(cur, peak - p.trail * p.atr) : cur;
  return {
    id: p.id, status: 'open', stop: round(next), peak: round(peak), days, last: lastBar?.close ?? null,
    as_of: lastBar?.d ?? null, r: lastBar ? round((lastBar.close - p.entry) / risk, 2) : null,
  };
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function fmt(v: number): string {
  return v.toLocaleString('tr-TR', { maximumFractionDigits: v >= 100 ? 2 : 4 });
}

/** Günlük güncellemeden sonra gönderilecek mesaj (yoksa null): stop yükseldi, plan kapandı ya da süre doldu. */
export function dailyMessage(p: TrackedPlan, prev: PlanStatus | undefined, cur: PlanStatus):
  { title: string; body: string } | null {
  if (cur.status !== 'open' && prev?.status !== cur.status) {
    const r = cur.r != null ? ` (${cur.r >= 0 ? '+' : ''}${cur.r.toLocaleString('tr-TR')}R)` : '';
    if (cur.status === 'stop') {
      return { title: `${p.symbol}: ${cur.r != null && cur.r > 0 ? 'iz süren stop — kârla çıkış' : 'plana göre çıkış (stop)'}`, body: `${cur.exit_date} günü fiyat stopa (${fmt(cur.exit!)}) indi${r}. Plan kapandı; satmadıysan pozisyonu gözden geçir.` };
    }
    if (cur.status === 'target') {
      return { title: `${p.symbol}: hedefe ulaştı`, body: `${cur.exit_date} günü hedef (${fmt(cur.exit!)}) görüldü${r}. Plana göre kâr alma zamanı.` };
    }
    return { title: `${p.symbol}: planın süresi doldu`, body: `${cur.days} işlem günü tutuldu; plana göre son kapanıştan (${fmt(cur.exit!)}) çıkış${r}.` };
  }
  // İz süren stop en az 0,25 ATR yükseldiyse: kâr korunuyor
  if (cur.status === 'open' && p.trail && prev && prev.status === 'open' && cur.stop - prev.stop >= 0.25 * p.atr) {
    const locked = cur.stop > p.entry ? ` Artık en kötü ihtimalle ${fmt((cur.stop - p.entry) / (p.entry - p.stop))}R kârla çıkılır.` : '';
    return { title: `${p.symbol}: iz süren stop yükseldi`, body: `Yeni stop ${fmt(cur.stop)} (önce ${fmt(prev.stop)}).${locked}` };
  }
  return null;
}

/** Gün içi: fiyat güncel stopun altına indi ya da hedefe ulaştı mı? */
export function intradayEvent(p: TrackedPlan, st: PlanStatus, price: number): 'stop' | 'target' | null {
  if (st.status !== 'open') return null;
  if (price <= st.stop) return 'stop';
  if (p.target != null && price >= p.target) return 'target';
  return null;
}

export function intradayMessage(p: TrackedPlan, st: PlanStatus, kind: 'stop' | 'target', price: number):
  { title: string; body: string } {
  const r = (price - p.entry) / (p.entry - p.stop);
  const rs = `${r >= 0 ? '+' : ''}${r.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}R`;
  return kind === 'stop'
    ? { title: `${p.symbol}: STOP — plana göre çıkış`, body: `Fiyat ${fmt(price)}, stop ${fmt(st.stop)} kırıldı (${rs}). Plan kuralı: pozisyondan çık.` }
    : { title: `${p.symbol}: HEDEF`, body: `Fiyat ${fmt(price)} hedefe (${fmt(p.target!)}) ulaştı (${rs}). Plana göre kâr al.` };
}
