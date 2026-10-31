import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';

import { useTheme } from '@/lib/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

// Sekme çubuğu rengi ColorValue tipinde gelir; Ionicons string bekler
const tabIcon = (name: IconName) =>
  function TabIcon({ color, size }: { color: unknown; size: number }) {
    return <Ionicons name={name} size={size} color={String(color)} />;
  };

export default function TabLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.text,
        sceneStyle: { backgroundColor: t.bg },
      }}>
      {/* Uygulama Asistan ile açılır (index = "/") */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Asistan',
          tabBarIcon: tabIcon('sparkles-outline'),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Tarama',
          tabBarIcon: tabIcon('stats-chart'),
        }}
      />
      <Tabs.Screen
        name="market"
        options={{
          title: 'Piyasa',
          tabBarIcon: tabIcon('pulse'),
        }}
      />
      <Tabs.Screen
        name="watchlist"
        options={{
          title: 'İzleme',
          tabBarIcon: tabIcon('star'),
        }}
      />
      <Tabs.Screen
        name="portfolio"
        options={{
          title: 'Portföy',
          tabBarIcon: tabIcon('briefcase-outline'),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Ayarlar',
          tabBarIcon: tabIcon('settings-outline'),
        }}
      />
    </Tabs>
  );
}
