import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import * as f from '@/lib/format';
import { levelColors, scoreColors, useTheme } from '@/lib/theme';
import type { Level } from '@/lib/types';

export function Card({ title, right, children, style }: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: ViewStyle;
}) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>
      {title ? (
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: t.text }]}>{title}</Text>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Chip({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function LevelChip({ prefix, level }: { prefix: string; level: Level }) {
  const t = useTheme();
  const c = levelColors(t, level);
  return <Chip label={`${prefix}: ${level}`} fg={c.fg} bg={c.bg} />;
}

export function ScoreBadge({ value, size = 'md' }: { value: number | null | undefined; size?: 'md' | 'lg' }) {
  const t = useTheme();
  const c = scoreColors(t, value);
  const lg = size === 'lg';
  return (
    <View style={[styles.badge, lg && styles.badgeLg, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, lg && styles.badgeTextLg, { color: c.fg }]}>{f.score(value)}</Text>
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: t.neutralBg }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.segmentItem, active && { backgroundColor: t.card }]}>
            <Text style={[styles.segmentText, { color: active ? t.text : t.muted }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Yükleniyor / hata / boş durumları için ortak görünüm. */
export function StateView({ loading, error, empty, onRetry }: {
  loading?: boolean;
  error?: string | null;
  empty?: string;
  onRetry?: () => void;
}) {
  const t = useTheme();
  if (loading) {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }
  return (
    <View style={styles.state}>
      <Text style={[styles.stateText, { color: error ? t.down : t.muted }]}>{error ?? empty}</Text>
      {error && onRetry ? (
        <Pressable onPress={onRetry} style={[styles.retry, { borderColor: t.border }]}>
          <Text style={{ color: t.accent, fontWeight: '600' }}>Tekrar dene</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  chip: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignSelf: 'flex-start' },
  chipText: { fontSize: 12, fontWeight: '600' },
  badge: { minWidth: 46, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, alignItems: 'center' },
  badgeLg: { minWidth: 72, borderRadius: 12, paddingVertical: 10 },
  badgeText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  badgeTextLg: { fontSize: 26 },
  segment: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  segmentText: { fontSize: 13, fontWeight: '600' },
  state: { padding: 32, alignItems: 'center', gap: 12 },
  stateText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  retry: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
});
