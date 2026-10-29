import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PriceChart, type ChartLevel } from '@/components/PriceChart';
import { Card, Chip, LevelChip, ScoreBadge, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { scoreColors, useTheme } from '@/lib/theme';
import type { Market, NewsItem, StockDetail } from '@/lib/types';

type Tf = 'daily' | 'weekly';
const REASONS_COLLAPSED = 6;
const NEWS_COLLAPSED = 8;

export default function StockScreen() {
  const { symbol, market } = useLocalSearchParams<{ symbol: string; market?: Market }>();
  const t = useTheme();
  const { isWatched, toggleWatch } = useSettings();
  const path = `/api/stock/${encodeURIComponent(symbol)}${market ? `?market=${market}` : ''}`;
  const { data: s, error, loading, reload } = useApi<StockDetail>(path);
  const [tf, setTf] = useState<Tf>('daily');

  const watched = s ? isWatched(s.symbol, s.market) : false;
  const header = (
    <Stack.Screen
      options={{
        title: symbol,
        headerRight: () =>
          s ? (
            <Pressable
              onPress={() => toggleWatch({ symbol: s.symbol, market: s.market })}
              hitSlop={10}
              accessibilityLabel={watched ? 'İzleme listesinden çıkar' : 'İzleme listesine ekle'}>
              <Ionicons name={watched ? 'star' : 'star-outline'} size={22} color={watched ? t.warn : t.text} />
            </Pressable>
          ) : null,
      }}
    />
  );

  if (!s) {
    return (
      <>
        {header}
        <StateView loading={loading} error={error} onRetry={reload} />
      </>
    );
  }

  const changeColor = s.change_pct > 0 ? t.up : s.change_pct < 0 ? t.down : t.muted;
  const daily = tf === 'daily';
  const levels: ChartLevel[] = daily
    ? [
        { label: 'Destek', value: s.support, kind: 'support' },
        { label: 'Direnç', value: s.resistance, kind: 'resistance' },
        { label: 'Stop', value: s.stop, kind: 'stop' },
      ]
    : [
        { label: 'Destek', value: s.weekly_support, kind: 'support' },
        { label: 'Direnç', value: s.weekly_resistance, kind: 'resistance' },
      ];

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {header}

      {/* Başlık */}
      <View style={styles.top}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: t.text }]} numberOfLines={2}>{s.name}</Text>
          <Text style={[styles.sub, { color: t.muted }]}>
            {f.marketLabel(s.market)}{s.sector ? ` · ${s.sector}` : ''} · {f.date(s.date)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.price, { color: t.text }]}>{f.price(s.close, s.market)}</Text>
          <Text style={[styles.change, { color: changeColor }]}>{f.pct(s.change_pct)}</Text>
        </View>
      </View>

      {/* Genel görünüm */}
      <Card>
        <View style={styles.outlookRow}>
          <ScoreBadge value={s.combined_score} size="lg" />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={[styles.outlook, { color: scoreColors(t, s.combined_score).fg }]}>{s.outlook}</Text>
            <View style={styles.chipRow}>
              <LevelChip prefix="Genel risk" level={s.overall_risk} />
              <LevelChip prefix="Volatilite" level={s.volatility} />
              <LevelChip prefix="Haber riski" level={s.news_risk} />
            </View>
          </View>
        </View>
        <View style={[styles.split, { borderTopColor: t.border }]}>
          <ScorePart label="Kısa vade (günlük)" value={s.daily_score} outlook={s.daily_outlook} />
          <ScorePart label="Orta vade (haftalık)" value={s.weekly_score} outlook={s.weekly_outlook} />
          <ScorePart label="Haber skoru" value={s.news_score} outlook={null} />
        </View>
        {s.reliability ? (
          <Text style={[styles.note, { color: t.muted }]}>
            Teknik skor güvenilirliği ({f.marketLabel(s.market)}): {s.reliability.level}. {s.reliability.note}
          </Text>
        ) : null}
      </Card>

      {/* Uyarılar */}
      {s.alerts.length > 0 ? (
        <View style={[styles.alertBox, { backgroundColor: t.warnBg }]}>
          {s.alerts.map((a) => (
            <View key={a} style={styles.alertLine}>
              <Ionicons name="warning" size={16} color={t.warn} />
              <Text style={[styles.alertText, { color: t.warn }]}>{a}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Grafik */}
      <Card
        title="Grafik"
        right={
          <View style={{ width: 170 }}>
            <Segmented
              options={[{ value: 'daily', label: 'Günlük' }, { value: 'weekly', label: 'Haftalık' }]}
              value={tf}
              onChange={setTf}
            />
          </View>
        }>
        <PriceChart
          key={tf}
          bars={daily ? s.chart_daily : s.chart_weekly}
          levels={levels}
          market={s.market}
          emaLabels={daily ? ['EMA20', 'EMA50', 'EMA200'] : ['EMA10', 'EMA30', 'EMA50']}
        />
      </Card>

      {/* Seviyeler */}
      <Card title="Seviyeler ve risk">
        {s.at_new_high ? <Chip label="Yeni zirve bölgesi: üstte direnç yok" fg={t.up} bg={t.upBg} /> : null}
        {s.at_new_low ? <Chip label="Dip bölgesi: altta destek yok" fg={t.down} bg={t.downBg} /> : null}
        <View style={styles.grid}>
          <Stat label="Destek" value={f.price(s.support)} color={t.up} />
          <Stat label="Direnç" value={f.price(s.resistance)} color={t.down} />
          <Stat label="Önerilen stop" value={f.price(s.stop)} />
          <Stat label="Hedef (direnç)" value={f.price(s.target)} />
          <Stat label="Risk / getiri" value={s.risk_reward != null ? `1 : ${f.num(s.risk_reward, 2)}` : '—'} />
          <Stat label="Günlük oynaklık (ATR)" value={f.pct(s.atr_pct, 1).replace('+', '')} />
          <Stat label="RSI" value={f.num(s.rsi, 0)} />
          <Stat label="Trend gücü (ADX)" value={f.num(s.adx, 0)} />
          <Stat label="52 hafta en yüksek" value={f.price(s.high_52w)} />
          <Stat label="52 hafta en düşük" value={f.price(s.low_52w)} />
          <Stat label="1 yıllık en büyük düşüş" value={f.pct(s.max_drawdown_1y_pct, 1)} color={t.down} />
          <Stat label="Devre kesici (30 gün)" value={s.circuit_breakers != null ? String(s.circuit_breakers) : '—'} />
        </View>
        <Text style={[styles.note, { color: t.muted }]}>
          Stop ve hedef seviyeleri alım yönlü bir pozisyon için teknik referanstır, öneri değildir.
        </Text>
      </Card>

      {/* Risk bayrakları */}
      {s.risk_flags.length > 0 ? (
        <Card title="Gerçek hayat riskleri (son 30 gün)">
          {s.risk_flags.map((rf) => (
            <Pressable
              key={rf.category}
              disabled={!rf.latest?.url}
              onPress={() => rf.latest?.url && WebBrowser.openBrowserAsync(rf.latest.url)}
              style={[styles.flag, { borderTopColor: t.border }]}>
              <View style={styles.flagHead}>
                <Chip
                  label={`${rf.category} · ${rf.count}`}
                  fg={rf.severe ? t.down : t.warn}
                  bg={rf.severe ? t.downBg : t.warnBg}
                />
                {rf.severe ? <Text style={[styles.severe, { color: t.down }]}>Ciddi</Text> : null}
              </View>
              {rf.latest ? (
                <Text style={[styles.flagText, { color: t.text }]} numberOfLines={2}>
                  {rf.latest.title} <Text style={{ color: t.muted }}>· {rf.latest.source} {f.date(rf.latest.date)}</Text>
                </Text>
              ) : null}
            </Pressable>
          ))}
        </Card>
      ) : null}

      {/* Teknik gerekçeler */}
      <Reasons daily={s.daily_reasons} weekly={s.weekly_reasons} />

      {/* Haberler */}
      <News items={s.news} />

      <Text style={[styles.disclaimer, { color: t.muted }]}>
        Bu ekran yatırım tavsiyesi değildir. Skorlar geçmiş fiyat hareketleri ve haber başlıklarından otomatik üretilir.
      </Text>
    </ScrollView>
  );
}

function ScorePart({ label, value, outlook }: { label: string; value: number | null; outlook: string | null }) {
  const t = useTheme();
  const c = scoreColors(t, value);
  return (
    <View style={styles.part}>
      <Text style={[styles.partLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.partValue, { color: c.fg }]}>{f.score(value)}</Text>
      {outlook ? <Text style={[styles.partOutlook, { color: c.fg }]}>{outlook}</Text> : null}
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? t.text }]}>{value}</Text>
    </View>
  );
}

function Reasons({ daily, weekly }: { daily: string[]; weekly: string[] }) {
  const t = useTheme();
  const [tf, setTf] = useState<Tf>('daily');
  const [expanded, setExpanded] = useState(false);
  const list = tf === 'daily' ? daily : weekly;
  const shown = expanded ? list : list.slice(0, REASONS_COLLAPSED);
  return (
    <Card title="Teknik gerekçeler">
      <Segmented
        options={[{ value: 'daily', label: 'Kısa vade' }, { value: 'weekly', label: 'Orta vade' }]}
        value={tf}
        onChange={(v) => { setTf(v); setExpanded(false); }}
      />
      <View style={{ marginTop: 10, gap: 6 }}>
        {shown.map((r) => (
          <View key={r} style={styles.reason}>
            <Text style={{ color: t.muted }}>•</Text>
            <Text style={[styles.reasonText, { color: t.text }]}>{r}</Text>
          </View>
        ))}
        {list.length === 0 ? <Text style={{ color: t.muted }}>Gerekçe yok.</Text> : null}
      </View>
      {list.length > REASONS_COLLAPSED ? (
        <Pressable onPress={() => setExpanded(!expanded)} style={styles.more}>
          <Text style={{ color: t.accent, fontWeight: '600' }}>{expanded ? 'Daha az göster' : `Tümü (${list.length})`}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

function News({ items }: { items: NewsItem[] }) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, NEWS_COLLAPSED);
  return (
    <Card title={`Haberler ve KAP (${items.length})`}>
      {items.length === 0 ? (
        <Text style={{ color: t.muted, lineHeight: 19 }}>
          Son 30 günde bu hisse için analiz edilmiş haber yok. Haberler; tarama listelerinin başındaki/sonundaki
          hisseler, izleme listesi ve tüm BIST hisseleri için KAP bildirimlerinden toplanır.
        </Text>
      ) : null}
      {shown.map((n) => {
        const c = n.sentiment > 0.05 ? t.up : n.sentiment < -0.05 ? t.down : t.muted;
        return (
          <Pressable
            key={`${n.url}-${n.title}`}
            onPress={() => WebBrowser.openBrowserAsync(n.url)}
            style={[styles.newsItem, { borderTopColor: t.border }]}>
            <View style={[styles.dot, { backgroundColor: c }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.newsTitle, { color: t.text }]} numberOfLines={3}>{n.title}</Text>
              <Text style={[styles.newsMeta, { color: t.muted }]}>
                {n.source} · {f.date(n.date)}
                {n.categories.length ? ` · ${n.categories.join(', ')}` : ''}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {items.length > NEWS_COLLAPSED ? (
        <Pressable onPress={() => setExpanded(!expanded)} style={styles.more}>
          <Text style={{ color: t.accent, fontWeight: '600' }}>{expanded ? 'Daha az göster' : `Tümü (${items.length})`}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  top: { flexDirection: 'row', gap: 12, marginBottom: 14 },
  name: { fontSize: 18, fontWeight: '700' },
  sub: { fontSize: 12, marginTop: 2 },
  price: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  change: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  outlookRow: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  outlook: { fontSize: 18, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  split: { flexDirection: 'row', marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  part: { flex: 1, gap: 2 },
  partLabel: { fontSize: 11 },
  partValue: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  partOutlook: { fontSize: 11, fontWeight: '600' },
  note: { fontSize: 11, lineHeight: 16, marginTop: 10 },
  alertBox: { borderRadius: 12, padding: 12, gap: 6, marginBottom: 12 },
  alertLine: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  alertText: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  stat: { width: '50%', paddingVertical: 6, paddingRight: 8 },
  statLabel: { fontSize: 11 },
  statValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  flag: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  flagHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  severe: { fontSize: 12, fontWeight: '700' },
  flagText: { fontSize: 13, lineHeight: 18 },
  reason: { flexDirection: 'row', gap: 8 },
  reasonText: { flex: 1, fontSize: 13, lineHeight: 18 },
  more: { paddingTop: 10 },
  newsItem: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  newsTitle: { fontSize: 13, lineHeight: 18 },
  newsMeta: { fontSize: 11, marginTop: 3 },
  disclaimer: { fontSize: 11, textAlign: 'center', marginTop: 8, lineHeight: 16 },
});
