import { FlatList, RefreshControl, StyleSheet, Text } from 'react-native';

import { StockRow } from '@/components/StockRow';
import { StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import { quoteKey, useQuotes } from '@/lib/quotes';
import { useSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';
import type { StockSummary } from '@/lib/types';

export default function WatchlistScreen() {
  const t = useTheme();
  const { watchlist, toggleWatch } = useSettings();
  const symbols = watchlist.map((w) => w.symbol).join(',');
  const { data, error, loading, reload } = useApi<{ items: StockSummary[] }>(
    symbols ? `/api/stocks?symbols=${encodeURIComponent(symbols)}` : null,
  );
  // Aynı kod iki piyasada olabilir; sadece izlenen piyasadakiler gösterilir
  const items = (data?.items ?? []).filter((s) => watchlist.some((w) => w.symbol === s.symbol && w.market === s.market));
  const quotes = useQuotes(watchlist);

  if (watchlist.length === 0) {
    return (
      <StateView empty={'İzleme listen boş.\nBir hissenin detay ekranında sağ üstteki yıldıza dokunarak ekleyebilirsin.'} />
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(s) => `${s.market}:${s.symbol}`}
      renderItem={({ item }) => (
        <StockRow
          item={item}
          quote={quotes[quoteKey(item.symbol, item.market)]}
          onRemove={() => toggleWatch({ symbol: item.symbol, market: item.market })}
        />
      )}
      ListHeaderComponent={
        <Text style={[styles.hint, { color: t.muted }]}>
          {watchlist.length} hisse · fiyatlar dakikada bir yenilenir (BIST 15 dk gecikmeli) · skorlar günlük kapanışa göre
        </Text>
      }
      ListEmptyComponent={<StateView loading={loading} error={error} empty="Hisseler bulunamadı." onRetry={reload} />}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  hint: { fontSize: 12, marginBottom: 10 },
});
