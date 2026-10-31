import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { Card, Chip, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useTheme, type Theme } from '@/lib/theme';
import type { Market, ModelMeta, TmPick, TmWeek, TmYear, TradeStatus, YearRow } from '@/lib/types';

const SETUP_TEXT = { breakout: 'Kırılım', pullback: 'Geri çekilme', trend: 'Trend devamı' } as const;
const STATUS_TEXT: Record<TradeStatus, string> = {
  target: 'Hedefe ulaştı', stop: 'Stop oldu', timeout: '20 günde sonuçlanmadı', open: 'Açık', not_filled: 'Girilmedi',
  pending: 'Bekliyor',
};

/** Zaman makinesi: geçmişte bir hafta seç — asistan o gün ne derdi, sonra ne oldu? Model o tarihten sonrasını görmedi. */
export default function TimeMachineScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<Market>('BIST');
  const [year, setYear] = useState<string | null>(null);
  const [weekIdx, setWeekIdx] = useState<number | null>(null);
  const [who, setWho] = useState<'rule' | 'model'>('rule');
  const index = useApi<{ years: string[] }>('/api/timemachine/index');
  const meta = useApi<ModelMeta>('/api/model');
  const years = index.data?.years ?? [];
  const y = year ?? years[years.length - 1] ?? null;
  const data = useApi<TmYear>(y ? `/api/timemachine/${y}` : null);
  const weeks = data.data?.[market] ?? [];
  // Varsayılan: sonucu belli olan en yeni hafta (son ~5 haftanın işlemleri henüz kapanmadı)
  const settled = weeks.filter((w) => w.rule.concat(w.model).every((p) => p.status !== 'pending' && p.status !== 'open'));
  const defaultIdx = weeks.length ? weeks.indexOf(settled[settled.length - 1] ?? weeks[weeks.length - 1]) : null;
  const wi = weekIdx != null && weekIdx < weeks.length ? weekIdx : defaultIdx;
  const week = wi != null ? weeks[wi] : null;
  const rows = (meta.data?.yearly ?? []).filter((r) => r.market === market);

  if (index.error) return <StateView error="Zaman makinesi verisi henüz yayınlanmadı (haftalık öğrenme çalışınca gelir)." onRetry={index.reload} />;
  if (!index.data) return <StateView loading />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Segmented
        options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]}
        value={market}
        onChange={(m) => { setMarket(m); setWeekIdx(null); }}
      />
      <Card style={{ marginTop: 12 }}>
        <Text style={[styles.text, { color: t.text }]}>
          Geçmişten bir hafta seç: asistan o haftanın kapanışında, sadece o güne kadarki fiyatlarla hangi hisseleri
          seçerdi ve sonra ne oldu? Model de o tarihten önceki veriyle eğitildi; sonrasını görmedi.
        </Text>
        <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
          Haber ve bilanço süzgeci geçmişte uygulanamadığı için canlı listeden farklı olabilir. Bugün borsada olmayan
          hisseler veride yok; bu, sonuçları biraz iyimser gösterebilir.
        </Text>
      </Card>

      {rows.length ? <YearTable rows={rows} meta={meta.data!} market={market} /> : null}

      <View style={styles.chips}>
        {years.map((yy) => (
          <Pressable key={yy} onPress={() => { setYear(yy); setWeekIdx(null); }}
            style={[styles.chip, { borderColor: yy === y ? t.accent : t.border, backgroundColor: yy === y ? t.neutralBg : 'transparent' }]}>
            <Text style={{ color: yy === y ? t.accent : t.text, fontWeight: '600' }}>{yy}</Text>
          </Pressable>
        ))}
      </View>

      {data.loading && !data.data ? <StateView loading /> : null}
      {weeks.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.weeks}>
          {weeks.map((w, i) => {
            const active = i === wi;
            const c = w.all_r >= 0 ? t.up : t.down;
            return (
              <Pressable key={w.date} onPress={() => setWeekIdx(i)}
                style={[styles.week, { borderColor: active ? t.accent : t.border, backgroundColor: active ? t.neutralBg : t.card }]}>
                <Text style={[styles.weekDate, { color: t.text }]}>{f.date(w.date)}</Text>
                <View style={[styles.weekBar, { backgroundColor: c, opacity: Math.min(1, 0.25 + Math.abs(w.all_r)) }]} />
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {week ? (
        <>
          <WeekSummary week={week} market={market} />
          <Segmented
            options={[{ value: 'rule', label: 'Asistanın seçimi' }, { value: 'model', label: 'Modelin seçimi' }]}
            value={who}
            onChange={setWho}
          />
          <View style={{ height: 10 }} />
          {(who === 'rule' ? week.rule : week.model).length === 0 ? (
            <StateView empty="O hafta süzgeçten geçen hisse yoktu: asistan alım önermezdi." />
          ) : (
            (who === 'rule' ? week.rule : week.model).map((p) => <PickCard key={p.s} p={p} market={market} />)
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

function YearTable({ rows, meta, market }: { rows: YearRow[]; meta: ModelMeta; market: Market }) {
  const t = useTheme();
  const ft = meta.form_test?.[market];
  const color = (v: number | null) => (v == null ? t.muted : v > 0 ? t.up : t.down);
  return (
    <Card title="Yıl yıl geçmiş test">
      <View style={[styles.tr, { borderBottomColor: t.border }]}>
        <Text style={[styles.th, { color: t.muted, width: 44 }]}>Yıl</Text>
        <Text style={[styles.th, { color: t.muted }]}>Asistan ilk 5</Text>
        <Text style={[styles.th, { color: t.muted }]}>Model ilk 5</Text>
        <Text style={[styles.th, { color: t.muted }]}>Tüm kurulumlar</Text>
      </View>
      {rows.map((r) => (
        <View key={r.year} style={[styles.tr, { borderBottomColor: t.border }]}>
          <Text style={[styles.td, { color: t.text, width: 44 }]}>{r.year}</Text>
          <Text style={[styles.td, { color: color(r.rule_top_r) }]}>{rText(r.rule_top_r)}</Text>
          <Text style={[styles.td, { color: color(r.model_top_r) }]}>{rText(r.model_top_r)}</Text>
          <Text style={[styles.td, { color: color(r.all_r) }]}>{rText(r.all_r)} · %{f.num(r.win, 0)}</Text>
        </View>
      ))}
      <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
        Her hücre: o yılın haftalarında seçilen kurulumların plan sonucunun ortalaması (1R = stop mesafesi). “Tüm
        kurulumlar” yanındaki yüzde hedefe ulaşma oranı. Tahminler her 6 aylık dönem için, o dönemden önceki veriyle
        eğitilen modelden.
        {ft && ft.good_next_r != null && ft.bad_next_r != null
          ? ` Strateji formu kuralının testi: form iyiyken sonraki hafta ortalama ${rText(ft.good_next_r)}, kötüyken ${rText(ft.bad_next_r)} (${ft.weeks} hafta).`
          : ''}
      </Text>
    </Card>
  );
}

function WeekSummary({ week, market }: { week: TmWeek; market: Market }) {
  const t = useTheme();
  const avg = (ps: TmPick[]) => {
    const done = ps.filter((p) => p.status !== 'pending' && p.status !== 'not_filled');
    return done.length ? done.reduce((a, p) => a + p.r, 0) / done.length : null;
  };
  const ra = avg(week.rule);
  const ma = avg(week.model);
  return (
    <Card title={`${f.date(week.date)} haftası · ${f.marketLabel(market)}`}>
      <View style={styles.stats}>
        <Stat t={t} label="Asistanın seçimi" value={rText(ra)} color={ra == null ? t.muted : ra >= 0 ? t.up : t.down} />
        <Stat t={t} label="Modelin seçimi" value={rText(ma)} color={ma == null ? t.muted : ma >= 0 ? t.up : t.down} />
        <Stat t={t} label={`Tüm ${week.n} kurulum`} value={rText(week.all_r)} color={week.all_r >= 0 ? t.up : t.down} />
      </View>
    </Card>
  );
}

function Stat({ t, label, value, color }: { t: Theme; label: string; value: string; color: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={[styles.tiny, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.value, { color }]}>{value}</Text>
    </View>
  );
}

function PickCard({ p, market }: { p: TmPick; market: Market }) {
  const t = useTheme();
  const good = p.status === 'target' || (p.status === 'timeout' && p.r > 0);
  const bad = p.status === 'stop' || (p.status === 'timeout' && p.r < 0);
  const c = good ? { fg: t.up, bg: t.upBg } : bad ? { fg: t.down, bg: t.downBg } : { fg: t.muted, bg: t.neutralBg };
  return (
    <Card>
      <Pressable onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.s, market } })} style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.symbol, { color: t.text }]}>{p.s}</Text>
          <Text style={[styles.small, { color: t.muted }]}>
            {SETUP_TEXT[p.setup]} · kapanış {f.price(p.close, market)} · göreli güç {p.rs}
          </Text>
        </View>
        <Chip label={`${STATUS_TEXT[p.status]} ${p.status === 'not_filled' || p.status === 'pending' ? '' : rText(p.r)}`} fg={c.fg} bg={c.bg} />
      </Pressable>
      <Text style={[styles.small, { color: t.text, marginTop: 8 }]}>
        Plan: giriş {f.price(p.el)}–{f.price(p.eh)} · stop {f.price(p.stop)} · hedef {f.price(p.t1)} (Ö/R {f.num(p.rr, 1)})
      </Text>
      <Text style={[styles.small, { color: t.muted, marginTop: 2 }]}>
        Model o gün: hedefe ulaşma %{Math.round(p.p * 100)}, beklenen {rText(p.pred)}
        {p.days ? ` · ${p.days} işlem gününde sonuçlandı` : ''}
        {p.ret20 != null ? ` · 20 gün sonra fiyat ${f.pct(p.ret20, 1)}` : ''}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 10 },
  value: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  weeks: { gap: 6, paddingBottom: 12 },
  week: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, alignItems: 'center', gap: 4 },
  weekDate: { fontSize: 12, fontWeight: '600' },
  weekBar: { width: 28, height: 4, borderRadius: 2 },
  stats: { flexDirection: 'row', gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { fontSize: 16, fontWeight: '800' },
  tr: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth },
  th: { flex: 1, fontSize: 11, fontWeight: '700' },
  td: { flex: 1, fontSize: 12, fontVariant: ['tabular-nums'] },
});
