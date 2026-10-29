// Gün içi fiyatlar: Cloudflare Worker'daki /api/quotes (Yahoo; BIST ~15 dk gecikmeli, ABD neredeyse anlık).
// Günlük analiz kapanış verisiyle yapılır; bu katman sadece güncel fiyatı ve günlük değişimi gösterir.

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { WORKER_URL } from './cloud';
import type { Market } from './types';

export interface Quote {
  price: number;
  prev_close: number;
  change_pct: number;
  time: string;
  delayed: boolean;
}

const REFRESH_MS = 60_000;

export const quoteKey = (symbol: string, market: Market) => `${market}:${symbol}`;

/** Ekran odaktayken verilen hisselerin fiyatlarını çeker ve dakikada bir yeniler. */
export function useQuotes(items: { symbol: string; market: Market }[]): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const keys = items.map((i) => quoteKey(i.symbol, i.market)).join(',');

  useFocusEffect(
    useCallback(() => {
      if (!keys) return;
      let cancelled = false;
      const load = () =>
        fetch(`${WORKER_URL}/api/quotes?s=${encodeURIComponent(keys)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { quotes?: Record<string, Quote> } | null) => {
            if (!cancelled && d?.quotes) setQuotes(d.quotes);
          })
          .catch(() => {
            // fiyat gelmezse günlük kapanış gösterilmeye devam eder
          });
      load();
      const id = setInterval(load, REFRESH_MS);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }, [keys]),
  );
  return quotes;
}
