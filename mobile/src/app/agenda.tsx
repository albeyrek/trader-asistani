import { useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { riskColors, toneColor } from '@/components/AgendaCard';
import { Card, Chip, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { SECTOR_NAMES, type Agenda, type MarketOverview, type SectorRotationRow } from '@/lib/types';

/** Gündem: politik risk, yapay zekâ özeti, sektör etkisi ve rotasyonu, takvim, başlıklar. */
export default function AgendaScreen() {
  const t = useTheme();
  const { data, error, loading, reload } = useApi<Agenda>('/api/agenda');
  const market = useApi<MarketOverview>('/api/market');
  const [filter, setFilter] = useState<string | null>(null);

  if (!data) return <StateView loading={loading} error={error} onRetry={reload} />;
  const headlines = data.headlines.filter((h) => (filter ? h.themes.some((x) => x.theme === filter) : true)).slice(0, 40);

  return (
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { reload(); market.reload(); }} />}>
      {data.risk ? <RiskCard risk={data.risk} /> : null}

      {data.ai?.themes.length ? (
        <Card title="Gündem özeti" right={<Text style={[styles.tiny, { color: t.muted }]}>yapay zekâ · {time(data.ai.at)}</Text>}>
          {data.ai.themes.map((x) => (
            <View key={x.title} style={[styles.theme, { borderTopColor: t.border }]}>
              <View style={styles.rowCenter}>
                <View style={[styles.dot, { backgroundColor: toneColor(t, x.tone) }]} />
                <Text style={[styles.themeTitle, { color: t.text }]}>{x.title}</Text>
              </View>
              <Text style={[styles.text, { color: t.text }]}>{x.summary}</Text>
              {x.sectors.length ? (
                <View style={styles.chips}>
                  {x.sectors.map((s) => (
                    <Chip key={s.sector} label={`${s.dir > 0 ? '▲' : '▼'} ${SECTOR_NAMES[s.sector] ?? s.sector}`}
                      fg={s.dir > 0 ? t.up : t.down} bg={s.dir > 0 ? t.upBg : t.downBg} />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
          <Text style={[styles.tiny, { color: t.muted, marginTop: 8 }]}>
            Son 24 saatin {data.ai.n} başlığından otomatik özet; hata içerebilir. Sektör yönleri genel eğilimlerdir.
          </Text>
        </Card>
      ) : null}

      <SectorCard agenda={data} rows={market.data?.BIST?.sector_rotation ?? []} />

      {data.calendar.length ? (
        <Card title="Takvim">
          {data.calendar.map((e) => (
            <View key={`${e.date}-${e.title}`} style={[styles.row, { borderTopColor: t.border }]}>
              <Text style={[styles.calDate, { color: t.text }]}>{f.date(e.date)}{'\n'}<Text style={{ color: t.muted }}>{e.time}</Text></Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.text, { color: t.text, fontWeight: '600' }]}>{e.country === 'TR' ? '🇹🇷' : '🇺🇸'} {e.title}</Text>
                <Text style={[styles.small, { color: t.muted }]}>{e.note}</Text>
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <Card title="Başlıklar">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {[{ theme: null as string | null, name: 'Tümü' }, ...data.themes.map((x) => ({ theme: x.theme as string | null, name: `${x.name} (${x.count})` }))].map((x) => {
            const active = filter === x.theme;
            return (
              <Pressable key={x.name} onPress={() => setFilter(x.theme)}
                style={[styles.filter, { borderColor: active ? t.accent : t.border, backgroundColor: active ? t.neutralBg : 'transparent' }]}>
                <Text style={{ color: active ? t.accent : t.text, fontSize: 12, fontWeight: '600' }}>{x.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {headlines.map((h) => (
          <Pressable key={h.id} onPress={() => Linking.openURL(h.url)} style={[styles.headline, { borderTopColor: t.border }]}>
            <Text style={[styles.text, { color: t.text }]}>{h.title}</Text>
            <Text style={[styles.tiny, { color: t.muted }]}>
              {h.source}{h.published ? ` · ${time(h.published)}` : ''}
              {h.themes.length ? ' · ' : ''}
              {h.themes.map((x, i) => (
                <Text key={x.theme} style={{ color: x.tone > 0 ? t.up : t.down }}>{i ? ', ' : ''}{x.variant}</Text>
              ))}
            </Text>
          </Pressable>
        ))}
      </Card>

      <Text style={[styles.disclaimer, { color: t.muted }]}>
        {data.disclaimer} Son güncelleme: {data.updated_at ? time(data.updated_at) : '—'}.
      </Text>
    </ScrollView>
  );
}

function RiskCard({ risk }: { risk: NonNullable<Agenda['risk']> }) {
  const t = useTheme();
  const c = riskColors(t, risk.level);
  const comp = risk.components;
  const pct = (v: number | null) => (v == null ? '—' : f.pct(v, 1));
  return (
    <Card title="Politik risk" right={<Chip label={`${risk.level} · ${risk.score}/100`} fg={c.fg} bg={c.bg} />}>
      <View style={[styles.bar, { backgroundColor: t.neutralBg }]}>
        <View style={[styles.barFill, { width: `${Math.max(3, risk.score)}%`, backgroundColor: c.fg }]} />
      </View>
      {risk.notes.length ? risk.notes.map((n) => <Text key={n} style={[styles.text, { color: t.text }]}>• {n}</Text>) : (
        <Text style={[styles.text, { color: t.text }]}>Siyasi gerilim başlıkları olağan seviyede, kur ve borsada olağandışı bir hareket yok.</Text>
      )}
      <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
        {comp.source === 'none'
          ? 'Siyasi başlık sayısı şu an ölçülemiyor'
          : `Son 6 saatte ${comp.headlines6h} siyasi gerilim başlığı (olağan ~${Math.round(comp.baseline6h)}`
            + `${comp.source === 'feeds' ? ', yayıncı akışlarından' : ''})`} · Dolar/TL {pct(comp.usdtry)} ·
        BIST 100 {pct(comp.xu100)} · Banka endeksi {pct(comp.xbank)} (bugün)
      </Text>
      <Text style={[styles.tiny, { color: t.muted, marginTop: 4 }]}>
        Risk “Yüksek”e çıkınca bildirim gelir ve asistan BIST’te önerilen pozisyonu yarıya indirir (liste kısalmaz:
        geçmişte sert düşüşlerin ardından açılan işlemler ortalamada iyi sonuç verdi).
      </Text>
    </Card>
  );
}

function SectorCard({ agenda, rows }: { agenda: Agenda; rows: SectorRotationRow[] }) {
  const t = useTheme();
  const impact = new Map(agenda.sectors.map((s) => [s.sector, s]));
  const ids = [...new Set([...rows.map((r) => r.sector), ...agenda.sectors.map((s) => s.sector)])].filter((s) => s !== 'genel');
  if (!ids.length) return null;
  const rowOf = new Map(rows.map((r) => [r.sector, r]));
  ids.sort((a, b) => (impact.get(b)?.score ?? 0) - (impact.get(a)?.score ?? 0) || (rowOf.get(b)?.rel_1m ?? -99) - (rowOf.get(a)?.rel_1m ?? -99));
  return (
    <Card title="Sektörler: gündem ve fiyat">
      <View style={[styles.tr, { borderBottomColor: t.border }]}>
        <Text style={[styles.th, { color: t.muted, flex: 1.6 }]}>Sektör</Text>
        <Text style={[styles.th, { color: t.muted }]}>Gündem</Text>
        <Text style={[styles.th, { color: t.muted }]}>1 ay / BIST</Text>
        <Text style={[styles.th, { color: t.muted }]}>Trendde</Text>
      </View>
      {ids.map((id) => {
        const im = impact.get(id);
        const r = rowOf.get(id);
        return (
          <View key={id} style={[styles.tr, { borderBottomColor: t.border }]}>
            <Text style={[styles.td, { color: t.text, flex: 1.6 }]} numberOfLines={1}>{SECTOR_NAMES[id] ?? id}</Text>
            <Text style={[styles.td, { color: !im ? t.muted : im.score > 0 ? t.up : t.down }]}>
              {!im ? '—' : `${im.score > 0 ? '+' : ''}${im.score}`}
            </Text>
            <Text style={[styles.td, { color: r?.rel_1m == null ? t.muted : r.rel_1m >= 0 ? t.up : t.down }]}>
              {r?.rel_1m == null ? '—' : f.pct(r.rel_1m, 1)}
            </Text>
            <Text style={[styles.td, { color: r ? (r.above_ema50 >= 50 ? t.up : t.down) : t.muted }]}>{r ? `%${f.num(r.above_ema50, 0)}` : '—'}</Text>
          </View>
        );
      })}
      <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
        Gündem: son 24 saatte sektörü olumlu (+) ya da olumsuz (−) etkileyebilecek başlıkların net sayısı. “1 ay / BIST”:
        sektördeki hisselerin son 1 aydaki medyan getirisinin BIST 100’e göre farkı. Trendde: 50 günlük ortalamasının üstündeki
        hisse oranı. Gündem olumlu ve fiyat da güçlüyse sektör izlenmeye değer; ikisi çelişiyorsa haber fiyata yansımamış ya da
        zaten fiyatlanmış olabilir.
      </Text>
    </Card>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 11, lineHeight: 15 },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  theme: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, marginTop: 8, gap: 4 },
  themeTitle: { fontSize: 14, fontWeight: '700', flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  row: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  calDate: { width: 56, fontSize: 12, fontWeight: '700' },
  filters: { gap: 6, paddingBottom: 8 },
  filter: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  headline: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 8 },
  barFill: { height: 8, borderRadius: 4 },
  tr: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  th: { flex: 1, fontSize: 11, fontWeight: '700' },
  td: { flex: 1, fontSize: 12, fontVariant: ['tabular-nums'] },
  disclaimer: { fontSize: 11, textAlign: 'center', lineHeight: 16, marginTop: 4 },
});
