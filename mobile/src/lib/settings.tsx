import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

import { WORKER_URL } from './cloud';
import { registerForPush, type PushStatus } from './notifications';
import type { Market } from './types';

const API_URL_KEY = 'apiUrl';
const MODE_KEY = 'dataMode';
const WATCHLIST_KEY = 'watchlist';
const SEVERE_ALL_KEY = 'notifyAllSevere';
const PRICE_ALERTS_KEY = 'notifyPriceAlerts';
const API_PORT = 8000;

/** Veri kaynağı: bulut (GitHub Pages + Cloudflare, her yerden çalışır) ya da yerel bilgisayardaki API. */
export type DataMode = 'cloud' | 'local';
/** useApi/fetchJson için bulut kaynağını belirten özel değer. */
export const CLOUD = 'cloud';

export interface WatchItem {
  symbol: string;
  market: Market;
}

/** Varsayılan sunucu adresi: geliştirme sırasında Expo sunucusunun çalıştığı bilgisayar (aynı makinede API de çalışır).
 *  Kurulu uygulamada (APK) Expo sunucusu olmadığı için ev ağındaki bilgisayarın adresi kullanılır. */
function defaultApiUrl(): string {
  if (Platform.OS === 'web') return `http://localhost:${API_PORT}`;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:${API_PORT}` : `http://192.168.1.7:${API_PORT}`;
}

/** Sunucuya kayıt durumu: bildirim gönderebilmesi için cihazın adresi ve izleme listesi API'ye iletilir. */
export type SyncState = { ok: boolean; at: number; error?: string } | null;

interface SettingsValue {
  ready: boolean;
  mode: DataMode;
  setMode: (m: DataMode) => void;
  /** useApi'nin kullandığı kaynak: CLOUD ya da yerel API adresi */
  dataSource: string;
  apiUrl: string;
  setApiUrl: (url: string) => void;
  watchlist: WatchItem[];
  isWatched: (symbol: string, market: Market) => boolean;
  toggleWatch: (item: WatchItem) => void;
  push: PushStatus | null;
  notifyAllSevere: boolean;
  setNotifyAllSevere: (v: boolean) => void;
  notifyPriceAlerts: boolean;
  setNotifyPriceAlerts: (v: boolean) => void;
  sync: SyncState;
  resync: () => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<DataMode>('cloud');
  const [apiUrl, setApiUrlState] = useState(defaultApiUrl);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [notifyAllSevere, setNotifyAllSevereState] = useState(true);
  const [notifyPriceAlerts, setNotifyPriceAlertsState] = useState(true);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [sync, setSync] = useState<SyncState>(null);
  const [syncNonce, setSyncNonce] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const [url, wl, severe, savedMode, priceAlerts] = await Promise.all([
          AsyncStorage.getItem(API_URL_KEY),
          AsyncStorage.getItem(WATCHLIST_KEY),
          AsyncStorage.getItem(SEVERE_ALL_KEY),
          AsyncStorage.getItem(MODE_KEY),
          AsyncStorage.getItem(PRICE_ALERTS_KEY),
        ]);
        if (priceAlerts != null) setNotifyPriceAlertsState(priceAlerts === 'true');
        if (url) setApiUrlState(url);
        if (savedMode === 'local' || savedMode === 'cloud') setModeState(savedMode);
        if (wl) setWatchlist(JSON.parse(wl));
        if (severe != null) setNotifyAllSevereState(severe === 'true');
      } catch {
        // Depolama okunamazsa varsayılanlarla devam edilir
      } finally {
        setReady(true);
      }
    })();
    registerForPush().then(setPush);
    // Uygulama her ön plana geldiğinde kaydı yenile (ilk açılışta izin penceresi yüzünden yarım kalabiliyor)
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      registerForPush().then(setPush);
      setSyncNonce((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  // Bildirim adresi, izleme listesi ya da tercih değişince sunucuya bildir
  const token = push?.state === 'ok' ? push.token : null;
  const deviceUrl = mode === 'cloud' ? WORKER_URL : apiUrl;
  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;
    fetch(`${deviceUrl}/api/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, watchlist, notify_all_severe: notifyAllSevere, notify_price_alerts: notifyPriceAlerts, platform: Platform.OS,
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!cancelled) setSync({ ok: true, at: Date.now() });
      })
      .catch((e: Error) => {
        if (!cancelled) setSync({ ok: false, at: Date.now(), error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [ready, token, deviceUrl, watchlist, notifyAllSevere, notifyPriceAlerts, syncNonce]);

  const setNotifyPriceAlerts = useCallback((v: boolean) => {
    setNotifyPriceAlertsState(v);
    AsyncStorage.setItem(PRICE_ALERTS_KEY, String(v)).catch(() => {});
  }, []);

  const setMode = useCallback((m: DataMode) => {
    setModeState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  const setApiUrl = useCallback((url: string) => {
    const clean = url.trim().replace(/\/+$/, '');
    setApiUrlState(clean);
    AsyncStorage.setItem(API_URL_KEY, clean).catch(() => {});
  }, []);

  const setNotifyAllSevere = useCallback((v: boolean) => {
    setNotifyAllSevereState(v);
    AsyncStorage.setItem(SEVERE_ALL_KEY, String(v)).catch(() => {});
  }, []);

  const toggleWatch = useCallback((item: WatchItem) => {
    setWatchlist((prev) => {
      const exists = prev.some((w) => w.symbol === item.symbol && w.market === item.market);
      const next = exists
        ? prev.filter((w) => !(w.symbol === item.symbol && w.market === item.market))
        : [...prev, item];
      AsyncStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const resync = useCallback(() => setSyncNonce((n) => n + 1), []);

  const value = useMemo<SettingsValue>(
    () => ({
      ready,
      mode,
      setMode,
      dataSource: mode === 'cloud' ? CLOUD : apiUrl,
      apiUrl,
      setApiUrl,
      watchlist,
      isWatched: (symbol, market) => watchlist.some((w) => w.symbol === symbol && w.market === market),
      toggleWatch,
      push,
      notifyAllSevere,
      setNotifyAllSevere,
      notifyPriceAlerts,
      setNotifyPriceAlerts,
      sync,
      resync,
    }),
    [ready, mode, setMode, apiUrl, setApiUrl, watchlist, toggleWatch, push, notifyAllSevere, setNotifyAllSevere,
      notifyPriceAlerts, setNotifyPriceAlerts, sync, resync],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings, SettingsProvider içinde kullanılmalı');
  return ctx;
}
