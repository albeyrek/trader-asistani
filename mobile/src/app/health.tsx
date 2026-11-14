import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { healthColors } from '@/components/HealthBanner';
import { Card, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Health, HealthCheck } from '@/lib/types';

const OVERALL: Record<Health['overall'], string> = {
  ok: 'Her şey yolunda',
  warn: 'Dikkat gerektiren noktalar var',
  error: 'Asistanın önerilerini etkileyen sorun var',
};
const ORDER: Record<HealthCheck['status'], number> = { error: 0, warn: 1, ok: 2 };

/** Sistem durumu: her taramada veri, kaynaklar, öğrenme ve canlı sonuçlar kontrol edilir. */
export default function HealthScreen() {
  const t = useTheme();
  const { data, error, loading, reload } = useApi<Health>('/api/health');
  if (!data) return <StateView loading={loading} error={error} empty="Sistem durumu henüz yayınlanmadı." onRetry={reload} />;
  const col = healthColors(t, data.overall);
  const checks = [...data.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const drift = Object.entries(data.drift ?? {});

  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}>
      <View style={[styles.hero, { backgroundColor: col.bg, borderColor: col.fg }]}>
        <Ionicons name={col.icon} size={28} color={col.fg} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.heroTitle, { color: col.fg }]}>{OVERALL[data.overall]}</Text>
          <Text style={[styles.small, { color: t.text }]}>
            Son kontrol: {f.date(data.generated_at)} {new Date(data.generated_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
            {data.blocked_markets.length ? ` · ${data.blocked_markets.map(f.marketLabel).join(' ve ')} için bugün aday verilmiyor` : ''}
          </Text>
        </View>
      </View>

      <Card title="Kontroller">
        {checks.map((c) => {
          const cc = healthColors(t, c.status);
          return (
            <View key={c.id} style={[styles.row, { borderTopColor: t.border }]}>
              <Ionicons name={cc.icon} size={18} color={cc.fg} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: t.text }]}>{c.name}</Text>
                <Text style={[styles.small, { color: t.muted }]}>{c.detail}</Text>
              </View>
            </View>
          );
        })}
      </Card>

      {drift.length ? (
        <Card title="Canlı sonuç ve test beklentisi">
          <Text style={[styles.small, { color: t.muted, marginBottom: 6 }]}>
            Asistanın gerçek listelerindeki kapanmış işlemlerin ortalama getirisi (R), 10 yıllık testin beklentisiyle
            karşılaştırılır. Fark istatistiksel olarak belirginse (z ≤ −2) asistan temkin moduna geçer: liste kısalır,
            önerilen pozisyon yarıya iner.
          </Text>
          {drift.map(([market, d]) => (
            <View key={market} style={[styles.row, { borderTopColor: t.border }]}>
              <Text style={[styles.name, { color: t.text, width: 44 }]}>{f.marketLabel(market as 'BIST' | 'US')}</Text>
              <Text style={[styles.small, { color: d?.status === 'alarm' ? t.down : d?.status === 'watch' ? t.warn : t.text, flex: 1 }]}>
                {d?.text}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Pressable onPress={() => router.push('/changelog')} accessibilityRole="button"
        style={[styles.link, { backgroundColor: t.card, borderColor: t.border }]}>
        <Ionicons name="git-commit-outline" size={20} color={t.accent} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: t.text }]}>Değişiklik günlüğü</Text>
          <Text style={[styles.small, { color: t.muted }]}>Asistanın kuralları, modeli ve verisi ne zaman, neden değişti?</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={t.muted} />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  hero: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 14 },
  heroTitle: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  name: { fontSize: 14, fontWeight: '600' },
  small: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14 },
});
