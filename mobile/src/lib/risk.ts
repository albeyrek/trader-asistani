// Pozisyon büyüklüğü (sabit kesirli risk yöntemi): işlem başına sermayenin belli bir yüzdesinden fazlası riske edilmez.
//   lot = (sermaye × risk%) / (giriş − stop)
// Stop'a kadar düşüşte kayıp ≈ sermaye × risk%. Pozisyon değeri sermayeyi aşamaz (kaldıraçsız).

export interface SizingInput {
  capital: number;
  riskPct: number; // örn. 1 = %1
  entry: number;
  stop: number;
  target?: number | null;
}

export interface SizingResult {
  qty: number; // tam adet (lot)
  value: number; // pozisyon tutarı
  capitalPct: number; // sermayenin yüzde kaçı
  riskPerShare: number;
  lossAtStop: number;
  gainAtTarget: number | null;
  rr: number | null; // risk/getiri: hedefe kazanç ÷ stop'ta kayıp
  stopPct: number; // girişe göre stop uzaklığı (%)
  cappedByCapital: boolean; // risk kuralı sermayeden fazlasını istediyse sermayeyle sınırlandı
  warnings: string[];
}

export const MAX_POSITION_PCT = 25; // tek pozisyon sermayenin %25'ini aşarsa uyarı

export function sizePosition(i: SizingInput): SizingResult | { error: string } {
  if (!(i.capital > 0)) return { error: 'Sermaye girilmeli.' };
  if (!(i.riskPct > 0 && i.riskPct <= 10)) return { error: 'Risk yüzdesi 0 ile 10 arasında olmalı.' };
  if (!(i.entry > 0)) return { error: 'Giriş fiyatı girilmeli.' };
  if (!(i.stop > 0) || i.stop >= i.entry) return { error: 'Stop, giriş fiyatının altında olmalı (alım pozisyonu).' };

  const riskPerShare = i.entry - i.stop;
  let qty = Math.floor((i.capital * i.riskPct) / 100 / riskPerShare);
  const maxByCapital = Math.floor(i.capital / i.entry);
  const cappedByCapital = qty > maxByCapital;
  if (cappedByCapital) qty = maxByCapital;

  const value = qty * i.entry;
  const capitalPct = (value / i.capital) * 100;
  const lossAtStop = qty * riskPerShare;
  const gainAtTarget = i.target && i.target > i.entry ? qty * (i.target - i.entry) : null;
  const rr = gainAtTarget != null && lossAtStop > 0 ? gainAtTarget / lossAtStop : null;
  const stopPct = (riskPerShare / i.entry) * 100;

  const warnings: string[] = [];
  if (qty === 0) warnings.push('Bu risk ve stop ile 1 lot bile alınamıyor; stop çok uzak ya da sermaye küçük.');
  if (cappedByCapital) warnings.push('Stop çok yakın: risk kuralı sermayeden büyük pozisyon gerektiriyor, sermayeyle sınırlandı.');
  if (capitalPct > MAX_POSITION_PCT) {
    warnings.push(`Pozisyon sermayenin %${capitalPct.toFixed(0)}'i: tek hisseye yoğunlaşma riski.`);
  }
  if (rr != null && rr < 1.5) warnings.push('Risk/getiri 1,5’in altında: kazanç potansiyeli riske göre düşük.');
  if (stopPct > 15) warnings.push(`Stop girişten %${stopPct.toFixed(0)} uzakta: geniş stop, küçük pozisyon.`);
  return { qty, value, capitalPct, riskPerShare, lossAtStop, gainAtTarget, rr, stopPct, cappedByCapital, warnings };
}

/** "1.234,5" / "1234.5" / "1 234,5" -> 1234.5 */
export function parseNumber(s: string): number {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return NaN;
  // Hem nokta hem virgül varsa: sonuncusu ondalık ayırıcıdır
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let norm = t;
  if (lastComma > -1 && lastDot > -1) {
    norm = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma > -1) {
    norm = t.replace(',', '.');
  }
  return Number(norm);
}
