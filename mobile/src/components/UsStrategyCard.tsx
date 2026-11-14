import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { UsStrategy } from '@/lib/types';

const ROWS = ['index', 'ramom_20', 'mom_20', 'mom_20_trend', 'index_trend'];
const SHORT: Record<string, string> = {
  index: 'S&P 500’ü tut', ramom_20: 'Düzeltilmiş momentum (20)', mom_20: 'Momentum (20)', mom_20_trend: 'Momentum + trend',
  index_trend: 'Endeks + trend filtresi',
};

/** ABD için strateji araştırmasının sonucu: önerilen yaklaşım (endeks) ve canlı test edilen deneysel momentum portföyü. */
export function UsStrategyCard({ data }: { data: UsStrategy | null | undefined }) {
  const t = useTheme();
  if (!data) return null;
  const rep = data.report;
  const idx = rep?.[data.recommended];
  const exp = rep?.[data.experiment];
  const fwd = data.forward;
  return (
    <Card title="ABD için strateji (araştırma)" right={<Chip label="Öneri: endeks" fg={t.accent} bg={t.neutralBg} />}>
      <Text style={[styles.text, { color: t.text }]}>
        Asistanın kısa vadeli planı ABD’de 2018’den beri S&P 500’ün çok gerisinde kaldı. 8 farklı strateji aynı veride test edildi:
        risk hesaba katıldığında en iyisi <Text style={{ fontWeight: '700' }}>S&P 500’ü bir endeks fonuyla tutmak</Text>
        {idx ? ` (yıllık %${f.num(idx.cagr, 1)}, en büyük düşüş %${f.num(idx.max_dd, 0)})` : ''}.
      </Text>
      {rep ? (
        <>
          <View style={[styles.tr, { borderBottomColor: t.border, marginTop: 8 }]}>
            <Text style={[styles.th, { color: t.muted, flex: 2 }]}>Strateji</Text>
            <Text style={[styles.th, { color: t.muted }]}>Yıllık</Text>
            <Text style={[styles.th, { color: t.muted }]}>Düşüş</Text>
            <Text style={[styles.th, { color: t.muted }]}>Sharpe</Text>
          </View>
          {ROWS.filter((k) => rep[k]).map((k) => (
            <View key={k} style={[styles.tr, { borderBottomColor: t.border, backgroundColor: k === data.recommended ? t.neutralBg : 'transparent' }]}>
              <Text style={[styles.td, { color: t.text, flex: 2, fontWeight: k === data.recommended ? '700' : '400' }]}>{SHORT[k] ?? k}</Text>
              <Text style={[styles.td, { color: rep[k].cagr >= rep[k].index_cagr ? t.up : t.down }]}>%{f.num(rep[k].cagr, 1)}</Text>
              <Text style={[styles.td, { color: t.text }]}>%{f.num(rep[k].max_dd, 0)}</Text>
              <Text style={[styles.td, { color: t.text }]}>{rep[k].sharpe != null ? f.num(rep[k].sharpe, 2) : '—'}</Text>
            </View>
          ))}
          <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
            Sharpe: birim risk başına getiri (yüksek daha iyi). Maliyet dahil, aylık yeniden dengeleme. Hisse evreni bugün işlem
            görenler olduğu için hisse stratejileri olduğundan iyi görünür.
          </Text>
        </>
      ) : null}

      <Text style={[styles.section, { color: t.text }]}>Deneysel: düzeltilmiş momentum portföyü</Text>
      <Text style={[styles.small, { color: t.text }]}>
        Her ay, son 12 ayda (son 1 ay hariç) oynaklığına göre en güçlü yükselen 20 hisse eşit ağırlıkla tutulur.
        {exp ? ` Testte yıllık %${f.num(exp.cagr, 1)} (S&P %${f.num(exp.index_cagr, 1)}), düşüş %${f.num(exp.max_dd, 0)}.` : ''}{' '}
        Birçok seçenek arasından seçildiği için iyimser olabilir; bu yüzden {fwd ? f.date(fwd.start) : 'bugün'}’den beri canlı
        test ediliyor
        {fwd ? `: ${f.pct(fwd.return_pct, 1)} (S&P ${f.pct(fwd.index_return_pct, 1)})` : ''}. Canlı sonuç güven verene kadar
        sadece izleyin.
      </Text>
      {data.current.holdings.length ? (
        <View style={styles.chips}>
          {data.current.holdings.map((h) => (
            <Pressable key={h.yf} onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: h.symbol, market: 'US' } })}
              style={[styles.chip, { borderColor: t.border }]}>
              <Text style={{ color: t.text, fontSize: 12, fontWeight: '600' }}>{h.symbol}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={[styles.tiny, { color: t.muted, marginTop: 4 }]}>Liste {f.date(data.current.date)} kapanışına göre; her ay sonu yenilenir.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 11 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  tr: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6, paddingHorizontal: 4 },
  th: { flex: 1, fontSize: 11, fontWeight: '700' },
  td: { flex: 1, fontSize: 12, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
});
