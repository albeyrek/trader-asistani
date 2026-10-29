import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';

import { PriceChart } from '@/components/PriceChart';
import { Card, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { regimeColors, scoreColors, useTheme } from '@/lib/theme';
import type { Market, MarketData, MarketOverview, Outlook, SectorRow } from '@/lib/types';

const OUTLOOKS: Outlook[] = ['Güçlü Yükseliş', 'Yükseliş', 'Nötr', 'Düşüş', 'Güçlü Düşüş'];

export default function MarketScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<Market>('BIST');
  const { data, error, loading, reload } = useApi<MarketOverview>('/api/market');
  const m = data?.[market];

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} />}>
      <Segmented options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]} value={market} onChange={setMarket} />
      <View style={{ height: 12 }} />
      {!m ? (
        <StateView loading={loading} error={error} empty="Piyasa verisi henüz yok; bir sonraki günlük taramadan sonra gelir." onRetry={reload} />
      ) : (
        <MarketBody m={m} market={market} />
      )}
      <Text style={[styles.note, { color: t.muted, textAlign: 'center' }]}>
        Rejim, endeks trendi ve piyasa genişliğinden otomatik hesaplanır; yatırım tavsiyesi değildir.
      </Text>
    </ScrollView>
  );
}

function MarketBody({ m, market }: { m: MarketData; market: Market }) {
  const t = useTheme();
  const r = m.regime;
  const rc = regimeColors(t, r.score);
  const b = m.breadth;
  const total = Object.values(m.outlook).reduce((a, v) => a + (v ?? 0), 0) || 1;

  return (
    <>
      <Card>
        <Text style={[styles.small, { color: t.muted }]}>Piyasa rejimi · {m.index_name}</Text>
        <View style={styles.regimeRow}>
          <View style={[styles.regimeBadge, { backgroundColor: rc.bg }]}>
            <Text style={[styles.regimeText, { color: rc.fg }]}>{r.label}</Text>
          </View>
          <Text style={[styles.score, { color: rc.fg }]}>{r.score > 0 ? '+' : ''}{r.score} / 5</Text>
        </View>
        <ScoreBar score={r.score} />
        <Text style={[styles.text, { color: t.text, marginTop: 10 }]}>{r.summary}</Text>
        <View style={{ marginTop: 10, gap: 6 }}>
          {r.factors.map((fa) => (
            <View key={fa.text} style={styles.factor}>
              <Ionicons
                name={fa.signal > 0 ? 'arrow-up-circle' : fa.signal < 0 ? 'arrow-down-circle' : 'remove-circle'}
                size={16}
                color={fa.signal > 0 ? t.up : fa.signal < 0 ? t.down : t.muted}
              />
              <Text style={[styles.text, { color: t.text, flex: 1 }]}>{fa.text}</Text>
            </View>
          ))}
        </View>
      </Card>

      <View style={styles.indices}>
        {m.indices.map((ix) => {
          const c = scoreColors(t, (ix.chg_1d ?? 0) * 10);
          return (
            <View key={ix.symbol} style={[styles.indexCard, { backgroundColor: t.card, borderColor: t.border }]}>
              <Text style={[styles.small, { color: t.muted }]}>{ix.name}</Text>
              <Text style={[styles.indexPrice, { color: t.text }]}>{f.price(ix.close)}</Text>
              <Text style={[styles.small, { color: c.fg, fontWeight: '700' }]}>{f.pct(ix.chg_1d)} gün</Text>
              <Text style={[styles.tiny, { color: t.muted }]}>1A {f.pct(ix.chg_1m, 1)} · 1Y {f.pct(ix.chg_1y, 1)}</Text>
            </View>
          );
        })}
      </View>

      <Card title={`${m.index_name} grafiği`}>
        <PriceChart all={m.chart} visible={253} levels={[]} trendlines={[]} market={market} type="line" unitless
          emaLabels={['EMA20', 'EMA50', 'EMA200']} />
      </Card>

      <Card title="Piyasa genişliği">
        <View style={styles.grid}>
          <Stat label="50 g. ortalama üstü" value={`%${f.num(b.pct_above_50, 0)}`} color={pctColor(t, b.pct_above_50)} />
          <Stat label="200 g. ortalama üstü" value={`%${f.num(b.pct_above_200, 0)}`} color={pctColor(t, b.pct_above_200)} />
          <Stat label="Yükselen / düşen (son gün)" value={`${b.advancers} / ${b.decliners}`} />
          <Stat label="Yeni 1Y zirve / dip" value={`${b.new_highs} / ${b.new_lows}`} />
          <Stat label="Medyan hisse (1 ay)" value={f.pct(b.median_1m, 1)} color={(b.median_1m ?? 0) >= 0 ? t.up : t.down} />
          <Stat label="Taranan hisse" value={String(b.stocks)} />
        </View>
        <Text style={[styles.small, { color: t.muted, marginTop: 10 }]}>Ortalamaların üstündeki hisse oranı (son 6 ay)</Text>
        <BreadthChart history={m.breadth_history} />
        <Text style={[styles.note, { color: t.muted }]}>
          %60 üstü geniş katılımlı yükseliş, %40 altı geniş tabanlı zayıflık olarak yorumlanır.
        </Text>
      </Card>

      {m.sectors?.length ? <SectorsCard rows={m.sectors} market={market} /> : null}

      <Card title="Hisselerin teknik görünümü">
        <View style={styles.stack}>
          {OUTLOOKS.map((o) => {
            const n = m.outlook[o] ?? 0;
            if (!n) return null;
            const c = scoreColors(t, o.includes('Yükseliş') ? 50 : o.includes('Düşüş') ? -50 : 0);
            return <View key={o} style={{ flex: n, backgroundColor: o.startsWith('Güçlü') ? c.fg : c.bg, height: 14 }} />;
          })}
        </View>
        <View style={{ marginTop: 8, gap: 3 }}>
          {OUTLOOKS.map((o) => (
            <Text key={o} style={[styles.small, { color: t.text }]}>
              {o}: {m.outlook[o] ?? 0} hisse (%{f.num(((m.outlook[o] ?? 0) / total) * 100, 0)})
            </Text>
          ))}
        </View>
      </Card>
    </>
  );
}

const SECTORS_COLLAPSED = 8;

function SectorsCard({ rows, market }: { rows: SectorRow[]; market: Market }) {
  const t = useTheme();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SECTORS_COLLAPSED);
  return (
    <Card title="Sektörler (göreli güce göre)">
      <Text style={[styles.note, { color: t.muted, marginTop: 0 }]}>
        Para hangi sektörlere giriyor: medyan göreli güç (RS), 1 ve 3 aylık medyan getiri, 200 günlük ortalama üstü oranı.
        Liderlere dokunarak hisseye git.
      </Text>
      {shown.map((r) => {
        const c = (r.rs ?? 50) >= 70 ? t.up : (r.rs ?? 50) <= 35 ? t.down : t.warn;
        return (
          <View key={r.sector} style={[styles.secRow, { borderTopColor: t.border }]}>
            <Text style={[styles.secRank, { color: t.muted }]}>{r.rank}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.secName, { color: t.text }]} numberOfLines={1}>{r.sector} <Text style={{ color: t.muted, fontWeight: '400' }}>({r.count})</Text></Text>
              <Text style={[styles.tiny, { color: t.muted }]}>
                1A {f.pct(r.ret_1m, 1)} · 3A {f.pct(r.ret_3m, 1)} · 200g üstü %{f.num(r.above200, 0)}
              </Text>
              <View style={styles.leaders}>
                {r.leaders.map((sym) => (
                  <Text key={sym} style={[styles.leader, { color: t.accent }]}
                    onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: sym, market } })}>
                    {sym}
                  </Text>
                ))}
              </View>
            </View>
            <Text style={[styles.secRs, { color: c }]}>{r.rs ?? '—'}</Text>
          </View>
        );
      })}
      {rows.length > SECTORS_COLLAPSED ? (
        <Text style={[styles.more, { color: t.accent }]} onPress={() => setAll(!all)}>
          {all ? 'Daha az göster' : `Tüm sektörler (${rows.length})`}
        </Text>
      ) : null}
    </Card>
  );
}

function pctColor(t: ReturnType<typeof useTheme>, v: number): string {
  return v >= 60 ? t.up : v <= 40 ? t.down : t.warn;
}

function ScoreBar({ score }: { score: number }) {
  const t = useTheme();
  return (
    <View style={styles.scoreBar}>
      {Array.from({ length: 11 }, (_, i) => i - 5).map((v) => {
        const c = regimeColors(t, v);
        const active = v === score;
        return (
          <View key={v} style={[styles.scoreCell, { backgroundColor: active ? c.fg : c.bg, opacity: active ? 1 : 0.7 }]} />
        );
      })}
    </View>
  );
}

function BreadthChart({ history }: { history: { d: string; a50: number; a200: number }[] }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const H = 110;
  if (history.length < 2) return null;
  const x = (i: number) => (i / (history.length - 1)) * (w - 30);
  const y = (v: number) => 4 + (1 - v / 100) * (H - 8);
  const path = (k: 'a50' | 'a200') => history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h[k]).toFixed(1)}`).join('');
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={{ height: H, marginTop: 6 }}>
      {w > 0 ? (
        <Svg width={w} height={H}>
          {[40, 60].map((v) => (
            <Line key={v} x1={0} x2={w - 30} y1={y(v)} y2={y(v)} stroke={t.border} strokeDasharray="4,4" />
          ))}
          {[0, 50, 100].map((v) => (
            <SvgText key={v} x={w - 26} y={y(v) + 4} fontSize={10} fill={t.muted}>{`%${v}`}</SvgText>
          ))}
          <Path d={path('a200')} stroke={t.emaSlow} strokeWidth={2} fill="none" />
          <Path d={path('a50')} stroke={t.emaMid} strokeWidth={2} fill="none" />
        </Svg>
      ) : null}
      <View style={styles.legendRow}>
        <View style={[styles.swatch, { backgroundColor: t.emaMid }]} />
        <Text style={[styles.tiny, { color: t.muted }]}>50 günlük</Text>
        <View style={[styles.swatch, { backgroundColor: t.emaSlow }]} />
        <Text style={[styles.tiny, { color: t.muted }]}>200 günlük</Text>
      </View>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.small, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? t.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  note: { fontSize: 11, lineHeight: 16, marginTop: 8 },
  small: { fontSize: 12 },
  tiny: { fontSize: 10 },
  regimeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  regimeBadge: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6 },
  regimeText: { fontSize: 22, fontWeight: '800' },
  score: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  scoreBar: { flexDirection: 'row', gap: 3, marginTop: 10 },
  scoreCell: { flex: 1, height: 8, borderRadius: 3 },
  factor: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  indices: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  indexCard: { flex: 1, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 2 },
  indexPrice: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  stat: { width: '50%', paddingVertical: 5 },
  statValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stack: { flexDirection: 'row', borderRadius: 7, overflow: 'hidden' },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6, position: 'absolute', left: 0, bottom: -18 },
  swatch: { width: 12, height: 3, borderRadius: 2 },
  secRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  secRank: { width: 20, fontSize: 12, textAlign: 'right', fontVariant: ['tabular-nums'] },
  secName: { fontSize: 14, fontWeight: '700' },
  secRs: { fontSize: 18, fontWeight: '800', minWidth: 30, textAlign: 'right', fontVariant: ['tabular-nums'] },
  leaders: { flexDirection: 'row', gap: 10, marginTop: 2 },
  leader: { fontSize: 12, fontWeight: '700' },
  more: { fontSize: 13, fontWeight: '600', paddingTop: 10 },
});
