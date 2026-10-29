import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { StockRow } from '@/components/StockRow';
import { Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { levelColors, regimeColors, useTheme } from '@/lib/theme';
import type { Market, MarketOverview, Meta, StockSummary } from '@/lib/types';

type ListKind = 'up' | 'down' | 'alerts';

const LIST_HINT: Record<ListKind, string> = {
  up: 'Birleşik teknik skoru en yüksek hisseler',
  down: 'Birleşik teknik skoru en düşük hisseler',
  alerts: 'Haber, devre kesici ya da teknik-haber çelişkisi uyarısı olanlar',
};

export default function ScanScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<Market>('BIST');
  const [kind, setKind] = useState<ListKind>('up');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const path = `/api/scan?market=${market}&list=${kind}&limit=100${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`;
  const { data, error, loading, reload } = useApi<{ total: number; items: StockSummary[] }>(path);
  const meta = useApi<Meta>('/api/meta');
  const marketData = useApi<MarketOverview>('/api/market');
  const regime = marketData.data?.[market]?.regime;
  const rgc = regime ? regimeColors(t, regime.score) : null;
  const reliability = meta.data?.reliability[market];
  const relColors = levelColors(t, reliability?.level === 'Düşük' ? 'Yüksek' : reliability?.level === 'Orta' ? 'Orta' : 'Düşük');

  const header = (
    <View style={styles.header}>
      <Segmented
        options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]}
        value={market}
        onChange={setMarket}
      />
      <Segmented
        options={[
          { value: 'up', label: 'Yükseliş' },
          { value: 'down', label: 'Düşüş riski' },
          { value: 'alerts', label: 'Uyarılar' },
        ]}
        value={kind}
        onChange={setKind}
      />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Hisse kodu ya da şirket adı ara"
        placeholderTextColor={t.muted}
        autoCapitalize="characters"
        autoCorrect={false}
        style={[styles.search, { backgroundColor: t.card, borderColor: t.border, color: t.text }]}
      />
      <Text style={[styles.hint, { color: t.muted }]}>
        {LIST_HINT[kind]}
        {data ? ` · ${data.total} hisse` : ''}
        {meta.data ? ` · veri: ${f.date(meta.data.last_date)}` : ''}
      </Text>
      {regime && rgc ? (
        <Pressable onPress={() => router.push('/market')} style={[styles.reliability, styles.regime, { backgroundColor: rgc.bg }]}>
          <Text style={[styles.regimeText, { color: rgc.fg }]}>
            Piyasa rejimi: {regime.label} ({regime.score > 0 ? '+' : ''}{regime.score}/5)
          </Text>
          <Text style={[styles.reliabilityText, { color: rgc.fg }]}>Ayrıntı ›</Text>
        </Pressable>
      ) : null}
      {reliability ? (
        <View style={[styles.reliability, { backgroundColor: relColors.bg }]}>
          <Text style={[styles.reliabilityText, { color: relColors.fg }]}>
            Teknik skor güvenilirliği ({f.marketLabel(market)}): {reliability.level}. {reliability.note}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <FlatList
      data={data?.items ?? []}
      keyExtractor={(s) => `${s.market}:${s.symbol}`}
      renderItem={({ item }) => <StockRow item={item} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <StateView loading={loading && !data} error={error} empty="Bu listede hisse yok." onRetry={reload} />
      }
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={() => { reload(); meta.reload(); }} />}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  header: { gap: 10, marginBottom: 12 },
  search: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
  hint: { fontSize: 12 },
  reliability: { borderRadius: 10, padding: 10 },
  reliabilityText: { fontSize: 12, lineHeight: 17 },
  regime: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  regimeText: { fontSize: 13, fontWeight: '700' },
});
