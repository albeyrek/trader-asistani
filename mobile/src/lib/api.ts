import { useCallback, useEffect, useState } from 'react';

import { cloudGet } from './cloud';
import { CLOUD, useSettings } from './settings';

const TIMEOUT_MS = 15000;

/** baseUrl === CLOUD ise veri GitHub Pages'teki statik dosyalardan, değilse yerel API'den gelir. */
export async function fetchJson<T>(baseUrl: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    if (baseUrl === CLOUD) return await cloudGet<T>(path, controller.signal);
    const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = String(body.detail);
      } catch {
        // gövde JSON değil
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('Sunucu yanıt vermedi (zaman aşımı)');
    }
    if (e instanceof TypeError) {
      throw new Error(
        baseUrl === CLOUD
          ? 'Veriye ulaşılamadı. İnternet bağlantını kontrol et.'
          : 'Sunucuya bağlanılamadı. Bilgisayardaki API çalışıyor mu, adres doğru mu?',
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

interface Result<T> {
  key: string | null; // bu sonucu üreten isteğin anahtarı
  data: T | null;
  error: string | null;
}

/** path null ise istek yapılmaz (örn. izleme listesi boşken).
 *  Yükleniyor durumu, son sonucun anahtarı güncel istekle eşleşmiyorsa türetilir (effect içinde senkron setState yok).
 *  Yeni istek sürerken önceki veri ekranda kalır (yenileme sırasında liste boşalmasın). */
export function useApi<T>(path: string | null): ApiState<T> {
  const { dataSource, ready } = useSettings();
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Result<T>>({ key: null, data: null, error: null });
  const key = ready && path !== null ? `${dataSource}|${path}|${nonce}` : null;

  useEffect(() => {
    if (key === null || path === null) return;
    let cancelled = false;
    fetchJson<T>(dataSource, path)
      .then((d) => {
        if (!cancelled) setResult({ key, data: d, error: null });
      })
      .catch((e: Error) => {
        if (!cancelled) setResult((prev) => ({ key, data: prev.data, error: e.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [key, dataSource, path]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const loading = key !== null && result.key !== key;
  return { data: result.data, error: loading ? null : result.error, loading, reload };
}
