import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Market, PaperReport } from '@/lib/types';

/** Asistan sekmesinde: "asistanı takip etseydin" özeti (canlı ve 2018'den beri test); dokununca sanal portföy ekranı. */
export function PaperCard({ rep, market }: { rep: PaperReport | null | undefined; market: Market }) {
  const t = useTheme();
  const live = rep?.live[market];
  const bt = rep?.backtest?.markets[market];
  if (!live && !bt) return null;
  const idx = market === 'BIST' ? 'BIST 100' : 'S&P 500';
  const color = (a: number, b: number) => (a >= b ? t.up : t.down);
  return (
    <Pressable onPress={() => router.push({ pathname: '/paper', params: { market } })}
      style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]} accessibilityRole="button">
      <Ionicons name="wallet-outline" size={22} color={t.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.title, { color: t.text }]}>Asistanı takip etseydin</Text>
        {live ? (
          <Text style={[styles.small, { color: t.muted }]}>
            Canlı ({f.date(live.start)}’den beri):{' '}
            <Text style={{ color: color(live.return_pct, live.index_return_pct), fontWeight: '700' }}>{f.pct(live.return_pct, 1)}</Text>
            {` · ${idx} ${f.pct(live.index_return_pct, 1)}`}
          </Text>
        ) : null}
        {bt && bt.cagr_pct != null && bt.index_cagr_pct != null ? (
          <Text style={[styles.small, { color: t.muted }]}>
            2018’den beri test: yıllık{' '}
            <Text style={{ color: color(bt.cagr_pct, bt.index_cagr_pct), fontWeight: '700' }}>%{f.num(bt.cagr_pct, 1)}</Text>
            {` · ${idx} %${f.num(bt.index_cagr_pct, 1)}`}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    padding: 14, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: '700' },
  small: { fontSize: 12, lineHeight: 17 },
});
