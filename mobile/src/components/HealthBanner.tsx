import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme, type Theme } from '@/lib/theme';
import type { Health, HealthCheck, Market } from '@/lib/types';

export function healthColors(t: Theme, status: HealthCheck['status']): { fg: string; bg: string; icon: 'checkmark-circle' | 'alert-circle' | 'close-circle' } {
  if (status === 'error') return { fg: t.down, bg: t.downBg, icon: 'close-circle' };
  if (status === 'warn') return { fg: t.warn, bg: t.warnBg, icon: 'alert-circle' };
  return { fg: t.up, bg: t.upBg, icon: 'checkmark-circle' };
}

/** Asistan sekmesinin üstünde: bu piyasayı etkileyen hata ya da uyarı varsa kısa bant (dokununca Sistem durumu).
 *  Sorun yoksa hiçbir şey göstermez. */
export function HealthBanner({ health, market }: { health: Health | null | undefined; market: Market }) {
  const t = useTheme();
  if (!health) return null;
  const relevant = health.checks.filter((c) => c.status !== 'ok' && (c.market == null || c.market === market));
  if (!relevant.length) return null;
  const worst: HealthCheck['status'] = relevant.some((c) => c.status === 'error') ? 'error' : 'warn';
  const col = healthColors(t, worst);
  const first = relevant.find((c) => c.status === worst) ?? relevant[0];
  return (
    <Pressable onPress={() => router.push('/health')} accessibilityRole="button"
      style={[styles.banner, { backgroundColor: col.bg, borderColor: col.fg }]}>
      <Ionicons name={col.icon} size={18} color={col.fg} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: col.fg }]}>
          {worst === 'error' ? 'Sistem uyarısı' : 'Dikkat'}{relevant.length > 1 ? ` (${relevant.length})` : ''}: {first.name}
        </Text>
        <Text style={[styles.detail, { color: t.text }]} numberOfLines={2}>{first.detail}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={col.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 12 },
  title: { fontSize: 13, fontWeight: '700' },
  detail: { fontSize: 12, marginTop: 2, lineHeight: 17 },
});
