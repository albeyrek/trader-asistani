import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { HorizonStat, Market, ScorecardMarket } from '@/lib/types';

const HORIZONS: { key: 'h5' | 'h10' | 'h20'; label: string }[] = [
  { key: 'h5', label: '5 gün' }, { key: 'h10', label: '10 gün' }, { key: 'h20', label: '20 gün' },
];

/** Sinyal karnesi: geçmişte listeye giren hisselerin sonraki günlerde piyasaya göre performansı. */
export function ScorecardCard({ sc, market }: { sc: ScorecardMarket | undefined; market: Market }) {
  const t = useTheme();
  const matured = sc ? Object.values(sc.up).some((h) => h.n > 0) : false;
  const last = sc?.recent[0];

  return (
    <Card title="Sinyal karnesi (canlı test)">
      <Text style={[styles.note, { color: t.muted, marginTop: 0 }]}>
        Her gün “Güçlü Yükseliş” listesinin ilk 20 hissesi ve “Güçlü Düşüş” listesinin son 20 hissesi kaydedilir; sonraki
        5/10/20 işlem gününde piyasadaki medyan hisseye göre getirileri ölçülür. Yükseliş listesi için iyi sonuç: pozitif fazla
        getiri; düşüş listesi için: negatif.
      </Text>
      {!sc || !matured ? (
        <Text style={[styles.text, { color: t.text, marginTop: 10 }]}>
          {sc?.snapshots
            ? `${sc.snapshots} günlük kayıt var (${f.date(sc.first_date)} itibarıyla). İlk sonuçlar kayıttan 5 işlem günü sonra görünür.`
            : 'Kayıt yeni başlıyor; ilk sonuçlar 5 işlem günü sonra görünür.'}
        </Text>
      ) : (
        <>
          <Table title="Güçlü Yükseliş listesi" stats={sc.up} good="up" />
          <Table title="Güçlü Düşüş listesi" stats={sc.down} good="down" />
          <Text style={[styles.note, { color: t.muted }]}>
            {sc.snapshots} günlük kayıt ({f.date(sc.first_date)} – {f.date(sc.last_date)}). Az veriyle sonuçlar şans eseri
            iyi ya da kötü görünebilir; en az birkaç ay biriktikçe anlamlı olur.
          </Text>
        </>
      )}
      {last && last.days > 0 ? (
        <View style={[styles.recent, { borderTopColor: t.border }]}>
          <Text style={[styles.small, { color: t.muted }]}>
            {f.date(last.date)} listesi ({last.days} işlem günü önce) — o günden bu yana, piyasaya göre:
          </Text>
          <View style={styles.picks}>
            {last.up.slice(0, 6).map((p) => (
              <Text key={p.symbol} style={[styles.pick, { color: p.excess >= 0 ? t.up : t.down }]}
                onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.symbol, market } })}>
                {p.symbol} {f.pct(p.excess, 1)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function Table({ title, stats, good }: { title: string; stats: Record<string, HorizonStat>; good: 'up' | 'down' }) {
  const t = useTheme();
  return (
    <View style={[styles.table, { borderTopColor: t.border }]}>
      <Text style={[styles.tableTitle, { color: t.text }]}>{title}</Text>
      <View style={styles.row}>
        {HORIZONS.map((h) => {
          const s = stats[h.key];
          const ok = s.avg_excess == null ? null : good === 'up' ? s.avg_excess > 0 : s.avg_excess < 0;
          const c = ok == null ? t.muted : ok ? t.up : t.down;
          return (
            <View key={h.key} style={styles.cell}>
              <Text style={[styles.small, { color: t.muted }]}>{h.label}</Text>
              <Text style={[styles.value, { color: c }]}>{s.avg_excess == null ? '—' : f.pct(s.avg_excess, 1)}</Text>
              <Text style={[styles.tiny, { color: t.muted }]}>
                {s.hit == null ? 'veri yok' : `isabet %${f.num(s.hit, 0)} · ${s.n} sinyal`}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 11, lineHeight: 16, marginTop: 8 },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12 },
  tiny: { fontSize: 10 },
  table: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8 },
  tableTitle: { fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row', marginTop: 6 },
  cell: { flex: 1, gap: 2 },
  value: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  recent: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  pick: { fontSize: 12, fontWeight: '700' },
});
