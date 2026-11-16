import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useNotificationRouting } from '@/lib/notifications';
import { PortfolioProvider } from '@/lib/portfolio';
import { SettingsProvider } from '@/lib/settings';
import { useTheme } from '@/lib/theme';

function RootStack() {
  const t = useTheme();
  useNotificationRouting();
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.card },
          headerTintColor: t.text,
          contentStyle: { backgroundColor: t.bg },
          headerBackTitle: 'Geri',
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="stock/[symbol]" options={{ title: '' }} />
        <Stack.Screen name="screener" options={{ title: 'Filtreler' }} />
        <Stack.Screen name="timemachine" options={{ title: 'Zaman makinesi' }} />
        <Stack.Screen name="agenda" options={{ title: 'Gündem' }} />
        <Stack.Screen name="paper" options={{ title: 'Sanal portföy' }} />
        <Stack.Screen name="chat" options={{ title: 'Asistana sor' }} />
        <Stack.Screen name="health" options={{ title: 'Sistem durumu' }} />
        <Stack.Screen name="changelog" options={{ title: 'Değişiklik günlüğü' }} />
        <Stack.Screen name="plans" options={{ title: 'Takipteki planlar' }} />
        <Stack.Screen name="research" options={{ title: 'Asistanın zekâsı' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SettingsProvider>
      <PortfolioProvider>
        <RootStack />
      </PortfolioProvider>
    </SettingsProvider>
  );
}
