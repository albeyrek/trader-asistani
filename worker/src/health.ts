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

/** Günlük taramanın zamanlanmış saatleri (UTC, hafta içi; .github/workflows/daily.yml ile aynı). */
const SCAN_SLOTS_UTC: [number, number][] = [[15, 45], [22, 15]];
/** GitHub zamanlanmış işleri saatlerce geciktirebiliyor (Kasım 2026'da 8 saate kadar görüldü). */
export const SCAN_GRACE_MS = 10 * 3600_000;

/** Şu ana kadar yayınlanmış olması gereken en son taramanın zamanlanmış saati: hafta içi tarama saatlerinden
 *  (now - SCAN_GRACE_MS) anından önceki en sonuncusu. Hafta sonu boşluğu böylece doğal olarak normal sayılır. */
export function expectedScanAt(now = Date.now()): number {
  const limit = now - SCAN_GRACE_MS;
  const day = new Date(limit);
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - back));
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const [h, m] of [...SCAN_SLOTS_UTC].reverse()) {
      const t = d.getTime() + (h * 60 + m) * 60_000;
      if (t <= limit) return t;
    }
  }
  return limit;
}

/** Türkiye saatine göre gün (uyarılar günde bir kez). */
export function trDay(now = Date.now()): string {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
}

/** Bildirim metni; uyarı gerekmiyorsa null. */
export function healthAlert(h: Health | null, now = Date.now()): { title: string; body: string } | null {
  if (!h) return null;
  const at = Date.parse(h.generated_at);
  // Yayınlanmış olması gereken son tarama (gecikme payıyla) yayınlanmadıysa: tarama çöktü ya da hiç çalışmadı
  if (at < expectedScanAt(now) - 15 * 60_000) {
    const hours = Math.floor((now - at) / 3600_000);
    return {
      title: 'Trader Asistanı: günlük tarama yayınlanmadı',
      body: `Son tarama ${hours < 48 ? `${hours} saat` : `${Math.floor(hours / 24)} gün`} önce. Asistanın listeleri, `
        + 'plan takibi ve sanal portföy güncel değil; yeni alım için listeye güvenmeyin.',
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
