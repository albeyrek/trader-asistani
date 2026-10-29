import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip, ScoreBadge } from '@/components/ui';
import * as f from '@/lib/format';
import type { Quote } from '@/lib/quotes';
import { levelColors, scoreColors, useTheme } from '@/lib/theme';
import type { StockSummary } from '@/lib/types';

/** quote verilirse gün içi fiyat ve günlük değişim gösterilir; yoksa son kapanış. */
function StockRowBase({ item, quote, onRemove }: { item: StockSummary; quote?: Quote; onRemove?: () => void }) {
  const t = useTheme();
  const price = quote?.price ?? item.close;
  const change = quote?.change_pct ?? item.change_pct;
  const changeColor = change > 0 ? t.up : change < 0 ? t.down : t.muted;
  const outlook = scoreColors(t, item.combined_score);
  const risk = levelColors(t, item.overall_risk);
  const earnings = f.earningsBadge(item.earnings_date, item.earnings_status);

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: item.symbol, market: item.market } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.neutralBg : t.card, borderColor: t.border }]}>
      <View style={styles.left}>
        <View style={styles.titleLine}>
          <Text style={[styles.symbol, { color: t.text }]}>{item.symbol}</Text>
          {item.alerts.length > 0 ? <Ionicons name="warning" size={14} color={t.warn} /> : null}
          {item.at_new_high ? <Ionicons name="trending-up" size={14} color={t.up} /> : null}
          {item.at_new_low ? <Ionicons name="trending-down" size={14} color={t.down} /> : null}
          {item.rs_rating != null ? (
            <Text style={[styles.rs, { color: item.rs_rating >= 80 ? t.up : item.rs_rating <= 30 ? t.down : t.muted }]}>
              RS {item.rs_rating}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.name, { color: t.muted }]} numberOfLines={1}>{item.name}</Text>
        <View style={styles.chips}>
          <Chip label={item.outlook} fg={outlook.fg} bg={outlook.bg} />
          <Chip label={`Risk: ${item.overall_risk}`} fg={risk.fg} bg={risk.bg} />
          {earnings ? <Chip label={earnings.text} fg={earnings.soon ? t.warn : t.muted} bg={earnings.soon ? t.warnBg : t.neutralBg} /> : null}
        </View>
      </View>
      <View style={styles.right}>
        <Text style={[styles.price, { color: t.text }]}>{f.price(price, item.market)}</Text>
        <Text style={[styles.change, { color: changeColor }]}>{f.pct(change)}</Text>
        {quote ? <Text style={[styles.quoteTime, { color: t.muted }]}>{f.quoteTime(quote)}</Text> : null}
        <ScoreBadge value={item.combined_score} />
      </View>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={10} style={styles.remove} accessibilityLabel={`${item.symbol} listeden çıkar`}>
          <Ionicons name="close-circle" size={20} color={t.muted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export const StockRow = memo(StockRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  left: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  symbol: { fontSize: 16, fontWeight: '700' },
  name: { fontSize: 12 },
  chips: { flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  right: { alignItems: 'flex-end', gap: 3 },
  price: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  quoteTime: { fontSize: 10 },
  rs: { fontSize: 11, fontWeight: '700', marginLeft: 2 },
  remove: { marginLeft: 2 },
});
