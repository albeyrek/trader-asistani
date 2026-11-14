import { StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { Card, Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { ExitsReport, Market } from '@/lib/types';

const SHOWN = ['base', 't2', 't3', 'plan40', 'trail3', 'trail2', 'half'];

/** Çıkış kuralları testi: aynı girişlerle farklı çıkış kuralları 10 yılda nasıl sonuç verdi, hangisi seçildi. */
export function ExitsCard({ rep, market }: { rep: ExitsReport | null | undefined; market: Market }) {
  const t = useTheme();
  const pol = rep?.policies[market];
  const wf = rep?.walk_forward[market];
  if (!rep || !pol) return null;
  const sel = rep.selected[market];
  const chosen = sel?.name ?? 'base';
  return (
    <Card title="Çıkış kuralı testi (10 yıl)"
      right={<Chip label={chosen === 'base' ? 'Sabit hedef' : 'İz süren stop'} fg={t.accent} bg={t.neutralBg} />}>
      <Text style={[styles.text, { color: t.text }]}>
        Asistanın geçmişteki girişleri sabit tutulup sadece çıkış kuralı değiştirildi.{' '}
        {chosen !== 'base' && sel
          ? `${f.marketLabel(market)} için “${sel.desc}” seçildi: işlem başına ortalama ${rText(sel.avg_r)} (sabit hedefli plan ${rText(sel.base_avg_r)}). Kayıplar küçük, kazananlar uzun süre taşınıyor; bu yüzden isabet oranı düşük ama ortalama yüksek.`
          : `${f.marketLabel(market)} için hiçbir alternatif, sabit hedefli plandan yeterince ve tutarlı şekilde iyi çıkmadı; plan korunuyor.`}
      </Text>
      <View style={[styles.tr, { borderBottomColor: t.border, marginTop: 8 }]}>
        <Text style={[styles.th, { color: t.muted, flex: 2.4 }]}>Kural</Text>
        <Text style={[styles.th, { color: t.muted }]}>Ort. R</Text>
        <Text style={[styles.th, { color: t.muted }]}>İsabet</Text>
        <Text style={[styles.th, { color: t.muted }]}>Gün</Text>
      </View>
      {SHOWN.filter((k) => pol[k]).map((k) => {
        const s = pol[k];
        const active = k === chosen;
        return (
          <View key={k} style={[styles.tr, { borderBottomColor: t.border, backgroundColor: active ? t.neutralBg : 'transparent' }]}>
            <Text style={[styles.td, { color: t.text, flex: 2.4, fontWeight: active ? '700' : '400' }]} numberOfLines={2}>{s.desc}</Text>
            <Text style={[styles.td, { color: s.avg_r >= 0 ? t.up : t.down }]}>{rText(s.avg_r)}</Text>
            <Text style={[styles.td, { color: t.text }]}>%{f.num(s.win, 0)}</Text>
            <Text style={[styles.td, { color: t.text }]}>{f.num(s.avg_days, 0)}</Text>
          </View>
        );
      })}
      {wf?.oos_chosen_r != null && wf.oos_base_r != null ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
          Aşırı uyum testi: her yıl, sadece o yıldan önceki yıllarda en iyi olan kural seçilip o yılda uygulandığında ortalama{' '}
          {rText(wf.oos_chosen_r)} (sabit hedefli plan {rText(wf.oos_base_r)}). {pol.base ? `${f.num(pol.base.n, 0)} geçmiş işlem; ` : ''}
          işlem maliyetleri hariç. Kural her hafta yeniden test edilir.
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tr: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6, paddingHorizontal: 4 },
  th: { flex: 1, fontSize: 11, fontWeight: '700' },
  td: { flex: 1, fontSize: 12, fontVariant: ['tabular-nums'] },
});
