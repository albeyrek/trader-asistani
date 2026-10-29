import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { StockDetail } from '@/lib/types';

/** Göreli güç (RS), sektör sırası ve temel veriler (F/K, PD/DD, piyasa değeri, halka açıklık). */
export function FundamentalsCard({ s }: { s: StockDetail }) {
  const t = useTheme();
  const fd = s.fundamentals;
  const sec = s.sector_info;
  const rs = s.rs_rating;
  if (rs == null && !fd && !sec) return null;
  const rsColor = rs == null ? t.muted : rs >= 80 ? t.up : rs <= 30 ? t.down : t.warn;
  const cap = fd?.market_cap;
  const cur = s.market === 'US' ? '$' : '₺';
  // Kaynaklar milyon cinsinden verir
  const capText = cap == null ? '—'
    : cap >= 1_000_000 ? `${f.num(cap / 1_000_000, 2)} trilyon ${cur}`
    : cap >= 1000 ? `${f.num(cap / 1000, 1)} milyar ${cur}` : `${f.num(cap, 0)} milyon ${cur}`;

  return (
    <Card title="Göreli güç ve temel veriler">
      {rs != null ? (
        <View>
          <View style={styles.rsHead}>
            <Text style={[styles.small, { color: t.muted }]}>Göreli güç (RS)</Text>
            <Text style={[styles.rsValue, { color: rsColor }]}>{rs}<Text style={[styles.small, { color: t.muted }]}> / 99</Text></Text>
          </View>
          <View style={[styles.track, { backgroundColor: t.neutralBg }]}>
            <View style={[styles.fill, { width: `${rs}%`, backgroundColor: rsColor }]} />
          </View>
          <Text style={[styles.note, { color: t.muted }]}>
            Son 3-12 ayın ağırlıklı getirisine göre piyasadaki sırası. 80 üstü piyasa liderleri, 30 altı zayıflar.
            {s.rs_3m != null ? ` Son 3 ayda endekse göre ${f.pct(s.rs_3m, 1)}.` : ''}
          </Text>
        </View>
      ) : null}

      {sec ? (
        <View style={[styles.section, { borderTopColor: t.border }]}>
          <Text style={[styles.small, { color: t.muted }]}>Sektör</Text>
          <Text style={[styles.value, { color: t.text }]}>
            {sec.sector} · {sec.of} sektör içinde {sec.rank}.
          </Text>
          <Text style={[styles.note, { color: t.muted, marginTop: 2 }]}>
            Sektör medyanı: 1 ay {f.pct(sec.ret_1m, 1)}, 3 ay {f.pct(sec.ret_3m, 1)} · 200 g. ortalama üstü %{f.num(sec.above200, 0)}
            {sec.leaders.length ? ` · Liderler: ${sec.leaders.join(', ')}` : ''}
          </Text>
        </View>
      ) : null}

      {fd ? (
        <View style={[styles.section, { borderTopColor: t.border }]}>
          <View style={styles.grid}>
            {s.market === 'BIST' ? (
              <>
                <Stat label="F/K" value={fd.pe != null ? f.num(fd.pe, 1) : '—'} />
                <Stat label="PD/DD" value={fd.pb != null ? f.num(fd.pb, 2) : '—'} />
                <Stat label="FD/FAVÖK" value={fd.ev_ebitda != null ? f.num(fd.ev_ebitda, 1) : '—'} />
                <Stat label="Halka açıklık" value={fd.free_float != null ? `%${f.num(fd.free_float, 1)}` : '—'} />
              </>
            ) : (
              <>
                <Stat label="Endüstri" value={fd.industry ?? '—'} />
                <Stat label="Ülke" value={fd.country ?? '—'} />
              </>
            )}
            <Stat label="Piyasa değeri" value={capText} />
            {fd.period ? <Stat label="Son finansal dönem" value={fd.period} /> : null}
          </View>
          {s.market === 'US' ? (
            <Text style={[styles.note, { color: t.muted }]}>ABD için ücretsiz güvenilir F/K kaynağı olmadığından oranlar gösterilmiyor.</Text>
          ) : null}
        </View>
      ) : null}

      {s.fundamental_flags?.map((fl) => (
        <View key={fl} style={styles.flag}>
          <Ionicons name="alert-circle-outline" size={14} color={t.warn} />
          <Text style={[styles.flagText, { color: t.warn }]}>{fl}</Text>
        </View>
      ))}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.small, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: t.text }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 12 },
  note: { fontSize: 11, lineHeight: 16, marginTop: 6 },
  rsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rsValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 4 },
  fill: { height: 8, borderRadius: 4 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12, paddingTop: 10 },
  value: { fontSize: 14, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  stat: { width: '50%', paddingVertical: 5, paddingRight: 8 },
  flag: { flexDirection: 'row', gap: 6, marginTop: 8, alignItems: 'flex-start' },
  flagText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
