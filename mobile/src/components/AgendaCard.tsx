import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme, type Theme } from '@/lib/theme';
import type { Agenda, PoliticalRisk } from '@/lib/types';

export function riskColors(t: Theme, level: PoliticalRisk['level'] | undefined): { fg: string; bg: string } {
  if (level === 'Yüksek') return { fg: t.down, bg: t.downBg };
  if (level === 'Orta') return { fg: t.warn, bg: t.warnBg };
  return { fg: t.up, bg: t.upBg };
}

export function toneColor(t: Theme, tone: number | string): string {
  if (tone === 'olumlu' || (typeof tone === 'number' && tone > 0.2)) return t.up;
  if (tone === 'olumsuz' || (typeof tone === 'number' && tone < -0.2)) return t.down;
  return t.warn;
}

/** Asistan sekmesinin üstünde: politik risk, gündemin öne çıkan temaları, sektör etkisi, yaklaşan olaylar. */
export function AgendaCard({ agenda }: { agenda: Agenda | null | undefined }) {
  const t = useTheme();
  if (!agenda || (!agenda.themes.length && !agenda.risk)) return null;
  const rc = riskColors(t, agenda.risk?.level);
  const themes = agenda.ai?.themes.length
    ? agenda.ai.themes.slice(0, 3).map((x) => ({ key: x.title, title: x.title, tone: x.tone as string | number }))
    : agenda.themes.slice(0, 3).map((x) => ({ key: x.theme, title: `${x.name}: ${x.variants[0]?.label ?? ''}`, tone: x.tone as string | number }));
  const pos = agenda.sectors.filter((s) => s.score > 0 && s.sector !== 'genel').slice(0, 3);
  const neg = agenda.sectors.filter((s) => s.score < 0 && s.sector !== 'genel').slice(-3).reverse();
  const next = agenda.calendar.slice(0, 2);

  return (
    <Pressable onPress={() => router.push('/agenda')} style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}
      accessibilityRole="button">
      <View style={styles.head}>
        <Ionicons name="newspaper-outline" size={18} color={t.accent} />
        <Text style={[styles.title, { color: t.text }]}>Gündem</Text>
        {agenda.risk ? <Chip label={`Politik risk: ${agenda.risk.level} (${agenda.risk.score})`} fg={rc.fg} bg={rc.bg} /> : null}
        <Ionicons name="chevron-forward" size={16} color={t.muted} style={{ marginLeft: 'auto' }} />
      </View>
      {themes.map((x) => (
        <View key={x.key} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: toneColor(t, x.tone) }]} />
          <Text style={[styles.text, { color: t.text }]} numberOfLines={1}>{x.title}</Text>
        </View>
      ))}
      {pos.length || neg.length ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 6 }]} numberOfLines={2}>
          {pos.length ? <Text style={{ color: t.up }}>Olumlu: {pos.map((s) => s.name).join(', ')}</Text> : null}
          {pos.length && neg.length ? '  ·  ' : ''}
          {neg.length ? <Text style={{ color: t.down }}>Olumsuz: {neg.map((s) => s.name).join(', ')}</Text> : null}
        </Text>
      ) : null}
      {next.length ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 4 }]} numberOfLines={1}>
          Yaklaşan: {next.map((e) => `${e.title.split(' (')[0]} ${f.date(e.date)}`).join(' · ')}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12, gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  title: { fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 13, flex: 1 },
  small: { fontSize: 12, lineHeight: 17 },
});
