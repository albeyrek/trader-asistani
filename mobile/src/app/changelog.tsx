import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Chip, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useTheme, type Theme } from '@/lib/theme';
import type { ChangelogEntry } from '@/lib/types';

function kindColors(t: Theme, kind: ChangelogEntry['kind']): { fg: string; bg: string } {
  if (kind === 'rule') return { fg: t.warn, bg: t.warnBg };
  if (kind === 'model') return { fg: t.accent, bg: t.neutralBg };
  if (kind === 'data') return { fg: t.down, bg: t.downBg };
  return { fg: t.up, bg: t.upBg };
}

/** Değişiklik günlüğü: asistanın davranışını etkileyen değişiklikler (performans değişince "neden?" sorusu için). */
export default function ChangelogScreen() {
  const t = useTheme();
  const { data, error, loading, reload } = useApi<ChangelogEntry[]>('/api/changelog');
  if (!data) return <StateView loading={loading} error={error} empty="Değişiklik günlüğü henüz yayınlanmadı." onRetry={reload} />;

  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}>
      <Text style={[styles.intro, { color: t.muted }]}>
        Kurallar, öğrenen model ve veri işleme değiştiğinde buraya yazılır. Haftalık öğrenmenin kendi verdiği kararlar
        (ör. çıkış kuralının değişmesi) otomatik eklenir.
      </Text>
      {data.map((e, i) => {
        const col = kindColors(t, e.kind);
        return (
          <View key={`${e.date}-${i}`} style={[styles.item, { backgroundColor: t.card, borderColor: t.border }]}>
            <View style={styles.head}>
              <Text style={[styles.date, { color: t.muted }]}>
                {new Date(e.date).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}
              </Text>
              <Chip label={e.auto ? `${e.kind_name} · otomatik` : e.kind_name} fg={col.fg} bg={col.bg} />
            </View>
            <Text style={[styles.title, { color: t.text }]}>{e.title}</Text>
            <Text style={[styles.detail, { color: t.text }]}>{e.detail}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 10 },
  intro: { fontSize: 12, lineHeight: 17 },
  item: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  date: { fontSize: 12 },
  title: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  detail: { fontSize: 13, lineHeight: 19 },
});
