import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { Card, Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Market, ModelMeta } from '@/lib/types';

/** "Asistan nasıl öğreniyor": haftalık eğitim, ileriye dönük test sonuçları, strateji formu ve modelin neye baktığı. */
export function ModelCard({ meta, market }: { meta: ModelMeta | null | undefined; market: Market }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  if (!meta) {
    return (
      <Card title="Asistan nasıl öğreniyor">
        <Text style={[styles.text, { color: t.muted }]}>
          Öğrenen model henüz eğitilmedi. Her cumartesi asistanın planları geçmiş veride yeniden oynatılır ve model
          yeniden eğitilir; o zamana kadar adaylar kural tabanlı sıralanır.
        </Text>
      </Card>
    );
  }
  const reg = meta.metrics.reg;
  const clf = meta.metrics.clf;
  const form = meta.form[market];
  const mk = meta.by_market[market];
  const offset = meta.clf_offset[market];
  const ft = meta.form_test?.[market];

  return (
    <Card
      title="Asistan nasıl öğreniyor"
      right={
        <Chip
          label={meta.reliable ? 'Model sıralıyor' : 'Kurallar sıralıyor'}
          fg={meta.reliable ? t.up : t.warn}
          bg={meta.reliable ? t.upBg : t.warnBg}
        />
      }>
      <Text style={[styles.text, { color: t.text }]}>
        Her hafta asistanın planları geçmiş {f.num(meta.n_samples, 0)} kurulumda yeniden oynatılıyor ({ymd(meta.period.from)} –{' '}
        {ymd(meta.period.to)}): önce hedef mi geldi, stop mu, kaç R kazandırdı? Model bundan öğreniyor; her 6 aylık dönem, o
        dönemden önceki veriyle eğitilen modelle tahmin edilerek test ediliyor ve model ancak testi geçerse karar veriyor.
        Son eğitim: {f.date(meta.trained_at)}.
      </Text>

      {form && form.recent_r != null ? (
        <View style={[styles.box, { backgroundColor: form.recent_r > 0 ? t.upBg : t.downBg }]}>
          <Text style={[styles.boxTitle, { color: form.recent_r > 0 ? t.up : t.down }]}>
            Strateji formu ({f.marketLabel(market)}): son 8 hafta {rText(form.recent_r)}
          </Text>
          <Text style={[styles.small, { color: t.text }]}>
            Sonuçlanan {f.num(form.recent_n, 0)} kurulumda hedefe ulaşma %{f.num(form.recent_win, 0)}; uzun dönem ortalaması{' '}
            {rText(form.long_r)}.{' '}
            {form.recent_r > 0 ? 'Planlar şu an çalışıyor.' : 'Planlar şu an çalışmıyor.'}
            {ft && ft.good_next_r != null && ft.bad_next_r != null
              ? ` 10 yıllık testte form kötüyken sonraki hafta ortalama ${rText(ft.bad_next_r)}, iyiyken ${rText(ft.good_next_r)}.` +
                (ft.good_next_r - ft.bad_next_r >= 0.05
                  ? (form.recent_r <= 0 ? ' Fark anlamlı olduğu için asistan temkin modunda (daha az aday, yarım pozisyon).' : '')
                  : ' Bu piyasada fark küçük; form sadece bilgi olarak gösteriliyor.')
              : ''}
          </Text>
          <View style={styles.spark}>
            {form.weekly.map((w) => {
              const h = Math.max(2, Math.min(28, Math.abs(w.r) * 28));
              return (
                <View key={w.w} style={styles.barCol}>
                  <View style={styles.half}>{w.r >= 0 ? <View style={[styles.bar, { height: h, backgroundColor: t.up }]} /> : null}</View>
                  <View style={[styles.half, { justifyContent: 'flex-start' }]}>
                    {w.r < 0 ? <View style={[styles.bar, { height: h, backgroundColor: t.down }]} /> : null}
                  </View>
                </View>
              );
            })}
          </View>
          <Text style={[styles.tiny, { color: t.muted }]}>Haftalık ortalama sonuç (son 26 hafta, sinyal tarihine göre)</Text>
        </View>
      ) : null}

      <Text style={[styles.section, { color: t.text }]}>Geçmiş test (modelin görmediği {ymd(reg.test_from)} – {ymd(reg.test_to)})</Text>
      <View style={styles.stats}>
        <Stat label="Olasılık isabeti (AUC)" value={f.num(clf.auc, 2)} sub="0,50 = yazı-tura" color={clf.auc >= 0.55 ? t.up : t.warn} />
        <Stat label="Haftalık ilk 5: model" value={rText(reg.wk_model_r ?? reg.model_top_r)}
          sub={`kurallar: ${rText(reg.wk_rule_r ?? reg.rule_top_r)}`} color={(reg.wk_model_r ?? 0) > 0 ? t.up : t.down} />
        <Stat label="Tüm kurulumlar" value={rText(reg.wk_all_r ?? reg.all_r)} sub={`${f.num(reg.n_test, 0)} kurulum`}
          color={(reg.wk_all_r ?? reg.all_r) > 0 ? t.up : t.down} />
      </View>
      <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
        Hedefe ulaşma olasılığını tahmin etmekte model yazı-turadan iyi (AUC {f.num(clf.auc, 2)}).
        {reg.edge != null && reg.edge_t != null
          ? ` Her hafta seçilen ilk 5'te model kurallardan ortalama ${rText(reg.edge)} ${reg.edge >= 0 ? 'iyi' : 'kötü'}; ` +
            (reg.edge_t >= 2
              ? `bu fark ${reg.weeks} haftalık testte anlamlı (t=${f.num(reg.edge_t, 1)}).`
              : `ama ${reg.weeks} haftalık testte bu fark şans eseri olabilecek kadar küçük (t=${f.num(reg.edge_t, 1)}; en az 2 gerekiyor).`)
          : ''}
        {meta.reliable
          ? ' Testi geçtiği için adayları model sıralıyor.'
          : ' Bu yüzden adayları kurallar sıralıyor; model olasılığı bilgi olarak gösteriliyor. Her hafta yeniden denenir.'}
        {' '}Asıl kazanç planın kendisinden geliyor: tüm kurulumların ortalaması {rText(reg.wk_all_r ?? reg.all_r)} (işlem
        maliyetleri hariç; bugün borsada olmayan hisseler veride yok).
        {offset != null && Math.abs(offset) > 0.1
          ? ` Son dönemde model ${offset < 0 ? 'fazla iyimserdi' : 'fazla kötümserdi'}; olasılıklar buna göre otomatik düzeltildi.`
          : ''}
        {mk ? ` ${f.marketLabel(market)} geçmişi: ${f.num(mk.n, 0)} kurulum, hedefe ulaşma %${f.num(mk.win, 0)}, ortalama ${rText(mk.avg_r)}.` : ''}
      </Text>

      {meta.insights.length ? (
        <>
          <Text style={[styles.section, { color: t.text }]}>Geçmiş veriden öğrenilenler</Text>
          {meta.insights.map((x) => (
            <View key={x.feature} style={styles.insight}>
              <Ionicons name="ellipse" size={6} color={t.muted} style={{ marginTop: 6 }} />
              <Text style={[styles.small, { color: t.text, flex: 1 }]}>{x.text}</Text>
            </View>
          ))}
        </>
      ) : null}

      <Pressable onPress={() => router.push('/timemachine')} style={[styles.tmButton, { borderColor: t.accent }]} accessibilityRole="button">
        <Ionicons name="time-outline" size={16} color={t.accent} />
        <Text style={{ color: t.accent, fontWeight: '700', fontSize: 13 }}>Zaman makinesi: yıl yıl geçmiş test</Text>
      </Pressable>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.more} accessibilityRole="button">
        <Text style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>{open ? 'Ayrıntıları gizle' : 'Olasılık doğruluğu ve eğitim geçmişi'}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={t.accent} />
      </Pressable>
      {open ? (
        <View style={{ gap: 4 }}>
          <Text style={[styles.small, { color: t.muted }]}>
            Model “%40” dediğinde gerçekte ne oldu? (düzeltme öncesi, test dönemi)
          </Text>
          {meta.calibration.map((c) => (
            <View key={c.from} style={[styles.row, { borderTopColor: t.border }]}>
              <Text style={[styles.small, { color: t.text, flex: 1 }]}>Tahmin %{f.num(c.predicted, 0)}</Text>
              <Text style={[styles.small, { color: t.text, width: 105 }]}>Gerçekleşen %{f.num(c.actual, 0)}</Text>
              <Text style={[styles.small, { color: c.avg_r >= 0 ? t.up : t.down, width: 60, textAlign: 'right' }]}>{rText(c.avg_r)}</Text>
            </View>
          ))}
          <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>Eğitim geçmişi</Text>
          {meta.history.slice(-6).reverse().map((h) => (
            <View key={h.trained_at} style={[styles.row, { borderTopColor: t.border }]}>
              <Text style={[styles.small, { color: t.text, width: 64 }]}>{f.date(h.trained_at)}</Text>
              <Text style={[styles.small, { color: t.muted, flex: 1 }]}>
                {f.num(h.n, 0)} kurulum · model {rText(h.model_top_r)} / kurallar {rText(h.rule_top_r)} · {h.decision}
              </Text>
            </View>
          ))}
          <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
            1R = giriş ile stop arası mesafe kadar kazanç ya da kayıp. Haberler geçmiş veride olmadığı için modele girmez,
            canlıda süzgeç olarak kullanılır. Canlı sonuçlar ayrıca “Asistan karnesi”nde ölçülür.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function ymd(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' });
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={[styles.tiny, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: color ?? t.text }]}>{value}</Text>
      {sub ? <Text style={[styles.tiny, { color: t.muted }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 10 },
  value: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', gap: 8, marginTop: 6 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  box: { borderRadius: 10, padding: 10, marginTop: 10, gap: 4 },
  boxTitle: { fontSize: 13, fontWeight: '700' },
  spark: { flexDirection: 'row', gap: 2, height: 58, marginTop: 4 },
  barCol: { flex: 1 },
  half: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderRadius: 1 },
  insight: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 3 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, marginBottom: 4 },
  tmButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: 10,
    paddingVertical: 9, marginTop: 12,
  },
  row: { flexDirection: 'row', gap: 8, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth },
});
