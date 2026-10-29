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
