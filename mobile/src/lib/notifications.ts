import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import type { Market } from './types';

export type PushStatus =
  | { state: 'ok'; token: string }
  | { state: 'unsupported'; reason: string }
  | { state: 'denied' }
  | { state: 'error'; reason: string };

// Uygulama açıkken gelen bildirimler de gösterilsin
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** Bildirim izni ister ve Expo push adresini (token) döndürür. Hata fırlatmaz, durumu döndürür. */
export async function registerForPush(): Promise<PushStatus> {
  if (Platform.OS === 'web') return { state: 'unsupported', reason: 'Web sürümünde bildirim yok.' };
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return { state: 'unsupported', reason: 'Expo Go’da bildirim desteklenmiyor; kurulu uygulamada (APK) çalışır.' };
  }
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Hisse uyarıları',
        importance: AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { state: 'denied' };

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return { state: 'error', reason: 'EAS proje kimliği bulunamadı.' };
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    return { state: 'ok', token };
  } catch (e) {
    return { state: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Bildirime dokununca ilgili hissenin detay ekranını açar (uygulama kapalıyken gelenler dahil).
 *  Web'de bildirim API'si yok; platform çalışma boyunca değişmediği için hook kuralları bozulmaz. */
export const useNotificationRouting: () => void = Platform.OS === 'web' ? () => {} : useNativeNotificationRouting;

function useNativeNotificationRouting() {
  const last = Notifications.useLastNotificationResponse();

  useEffect(() => {
    const data = last?.notification.request.content.data as { symbol?: string; market?: Market } | undefined;
    if (data?.symbol) {
      router.push({ pathname: '/stock/[symbol]', params: { symbol: data.symbol, market: data.market ?? 'BIST' } });
    }
  }, [last]);
}
