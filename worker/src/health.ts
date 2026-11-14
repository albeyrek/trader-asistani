// Sistem sağlığı uyarısı: günlük tarama data/health.json yazar (scanner/health.py). Durum "error" ise (ör. Yahoo
// verinin çoğunu göndermedi, asistan o piyasada aday vermiyor) ya da günlük tarama günlerdir çalışmadıysa kullanıcıya
// günde en fazla bir bildirim gider.

export interface HealthCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  market: string | null;
}

export interface Health {
  generated_at: string;
  overall: 'ok' | 'warn' | 'error';
  checks: HealthCheck[];
  blocked_markets: string[];
}

/** Hafta sonu dahil en uzun normal boşluk: cuma 22:15 -> pazartesi 22:15 = 72 saat (+ GitHub gecikmesi). */
export const STALE_MS = 76 * 3600_000;

/** Türkiye saatine göre gün (uyarılar günde bir kez). */
export function trDay(now = Date.now()): string {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
}

/** Bildirim metni; uyarı gerekmiyorsa null. */
export function healthAlert(h: Health | null, now = Date.now()): { title: string; body: string } | null {
  if (!h) return null;
  const age = now - Date.parse(h.generated_at);
  if (age > STALE_MS) {
    return {
      title: 'Trader Asistanı: günlük tarama çalışmadı',
      body: `Son tarama ${Math.floor(age / 86400_000)} gün önce. Asistanın listeleri ve planları güncel değil.`,
    };
  }
  if (h.overall !== 'error') return null;
  const errs = h.checks.filter((c) => c.status === 'error');
  const blocked = h.blocked_markets.length ? ` ${h.blocked_markets.join(' ve ')} için bugün aday verilmiyor.` : '';
  return {
    title: 'Trader Asistanı: sistem uyarısı',
    body: `${errs.slice(0, 2).map((c) => `${c.name}: ${c.detail}`).join(' · ')}.${blocked}`.slice(0, 300),
  };
}
