import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { EquityChart } from '@/components/EquityChart';
import { Card, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Market, PaperReport, PaperResult } from '@/lib/types';

const HOW: Record<string, string> = { stop: 'stop', target: 'hedef', time: 'süre doldu' };

/** Sanal portföy: asistanın önerileri gerçek bir hesap gibi uygulansaydı (canlı) ve 2018'den beri (test). */
export default function PaperScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ market?: string; mode?: string }>();
  const [market, setMarket] = useState<Market>(params.market === 'US' ? 'US' : 'BIST');
  const [mode, setMode] = useState<'live' | 'backtest'>(params.mode === 'backtest' ? 'backtest' : 'live');
  const { data, error, loading, reload } = useApi<PaperReport>('/api/paper');
  if (!data) return <StateView loading={loading} error={error} onRetry={reload} />;
  const r = mode === 'live' ? data.live[market] : data.backtest?.markets[market];
  const indexName = market === 'BIST' ? 'BIST 100' : 'S&P 500';

  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}>
      <Segmented options={[{ value: 'live', label: 'Canlı' }, { value: 'backtest', label: "2018'den beri test" }]}
        value={mode} onChange={setMode} />
      <View style={{ height: 8 }} />
      <Segmented options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]} value={market} onChange={setMarket} />
      <View style={{ height: 12 }} />
      {!r ? (
        <StateView empty={mode === 'live' ? 'Canlı portföy henüz başlamadı.' : 'Test portföyü haftalık öğrenmede hesaplanır.'} />
      ) : (
        <>
          <Summary r={r} indexName={indexName} mode={mode} />
          <Card title="Getiri">
            <EquityChart curve={r.curve} indexName={indexName} capital={r.capital} />
          </Card>
          {r.open.length ? (
            <Card title={`Açık pozisyonlar (${r.open.length})`}>
              {r.open.map((p) => (
                <Pressable key={p.symbol} onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.symbol, market } })}
                  style={[styles.row, { borderTopColor: t.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sym, { color: t.text }]}>{p.symbol}</Text>
                    <Text style={[styles.small, { color: t.muted }]}>
                      {f.date(p.entry_date)} · {p.shares} adet · giriş {f.price(p.fill)} · stop {f.price(p.stop)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.val, { color: p.pnl_pct >= 0 ? t.up : t.down }]}>{f.pct(p.pnl_pct, 1)}</Text>
                    <Text style={[styles.small, { color: t.muted }]}>{f.money(p.value, market)}</Text>
                  </View>
                </Pressable>
              ))}
            </Card>
          ) : null}
          {r.closed.length ? (
            <Card title={`Kapanan işlemler (son ${r.closed.length})`}>
              {r.closed.map((p) => (
                <View key={`${p.symbol}-${p.entry_date}`} style={[styles.row, { borderTopColor: t.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sym, { color: t.text }]}>{p.symbol}</Text>
                    <Text style={[styles.small, { color: t.muted }]}>
                      {f.date(p.entry_date)} → {f.date(p.exit_date)} · {HOW[p.how] ?? p.how} · {p.days} gün
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.val, { color: p.pnl >= 0 ? t.up : t.down }]}>{f.pct(p.pnl_pct, 1)}</Text>
                    <Text style={[styles.small, { color: t.muted }]}>{rText(p.r)}</Text>
                  </View>
                </View>
              ))}
            </Card>
          ) : null}
          <Card title="Kurallar">
            <Text style={[styles.small, { color: t.text }]}>
              Başlangıç {f.money(r.capital, market)}. Asistanın listesindeki her aday, sonraki {r.settings.entry_days} gün içinde
              giriş bölgesine gelirse alınır. Lot: sermayenin %{f.num(r.settings.risk_pct, 0)}’i stopta kaybedilecek şekilde
              (zayıf piyasada küçültülür); tek pozisyon sermayenin %{f.num(r.settings.max_pos_pct, 0)}’ini ve hissenin günlük işlem
              hacminin %{f.num(data.settings.participation_pct, 0)}’sini geçmez; en fazla {r.settings.max_positions} pozisyon. Çıkış
              asistanın çıkış kuralıyla. Her alış ve satışta %{f.num(r.settings.cost_pct, 2)} maliyet (komisyon + kayma); vergi yok.
              BIST’te tavanda açılan hisse alınmaz, tabanda kilitli hisse o gün satılamaz.
            </Text>
            {mode === 'backtest' ? (
              <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
                Test: her hafta asistanın süzgecinden geçen ilk 5 kurulum; çıkış kuralı her yıl yalnızca önceki yıllara bakılarak
                seçildi. Önemli sınırlamalar: hisse evreni bugün işlem gören likit hisselerdir (geçmişte batan ya da sığlaşan hisseler
                yok), haber ve bilanço süzgeci geçmişte uygulanamadı. Bu yüzden test sonucu gerçekte elde edilebilecekten iyimser
                olabilir; asıl ölçüt canlı portföydür.
                {r.excluded?.length ? ` Veri hatası şüphesiyle çıkarılan hisseler: ${r.excluded.join(', ')}.` : ''}
              </Text>
            ) : (
              <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
                Canlı: asistanın gerçekten yayınladığı listelerle {f.date(r.start)}’den beri. Henüz kısa bir dönem; sonuçlar şansa bağlı
                olabilir.
              </Text>
            )}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

function Summary({ r, indexName, mode }: { r: PaperResult; indexName: string; mode: 'live' | 'backtest' }) {
  const t = useTheme();
  const beat = r.return_pct >= r.index_return_pct;
  return (
    <Card title={mode === 'live' ? 'Asistanı birebir takip etseydin' : "2018'den beri test"}>
      <View style={styles.stats}>
        <Stat label="Portföy" value={f.pct(r.return_pct, 1)} sub={f.money(r.equity, r.market)} color={r.return_pct >= 0 ? t.up : t.down} />
        <Stat label={indexName} value={f.pct(r.index_return_pct, 1)} sub="aynı sermayeyle" color={r.index_return_pct >= 0 ? t.up : t.down} />
        <Stat label="En büyük düşüş" value={f.pct(r.max_dd_pct, 1)} sub={`endeks ${f.pct(r.index_max_dd_pct, 1)}`} color={t.down} />
      </View>
      <Text style={[styles.small, { color: t.text, marginTop: 8 }]}>
        {beat ? 'Portföy endeksin önünde.' : 'Portföy endeksin gerisinde.'}
        {r.cagr_pct != null && r.index_cagr_pct != null ? ` Yıllık ortalama %${f.num(r.cagr_pct, 1)} (endeks %${f.num(r.index_cagr_pct, 1)}).` : ''}
        {` ${r.trades} işlem kapandı, ${r.open_count} açık`}
        {r.win_rate != null ? `; kârla kapanan %${f.num(r.win_rate, 0)}, işlem başına ortalama ${rText(r.avg_r)}` : ''}
        {`; sermayenin ortalama %${f.num(r.exposure_pct, 0)}’i yatırımda.`}
      </Text>
      {r.idle_index ? <IdleIndex r={r} indexName={indexName} /> : null}
    </Card>
  );
}

/** Boştaki para endekste tutulsaydı: aynı işlemler, nakit payı (%10 tampon hariç) haftada bir endeks fonuna. */
function IdleIndex({ r, indexName }: { r: PaperResult; indexName: string }) {
  const t = useTheme();
  const ii = r.idle_index!;
  const better = ii.return_pct > r.return_pct;
  return (
    <View style={[styles.idle, { borderTopColor: t.border }]}>
      <Text style={[styles.small, { color: t.text, fontWeight: '700' }]}>Boştaki para {indexName} fonunda olsaydı</Text>
      <View style={[styles.stats, { marginTop: 6 }]}>
        <Stat label="Portföy" value={f.pct(ii.return_pct, 1)} sub={f.money(ii.equity, r.market)} color={ii.return_pct >= 0 ? t.up : t.down} />
        <Stat label="Yıllık" value={ii.cagr_pct != null ? `%${f.num(ii.cagr_pct, 1)}` : '—'}
          sub={r.cagr_pct != null ? `nakitte %${f.num(r.cagr_pct, 1)}` : undefined} color={better ? t.up : t.down} />
        <Stat label="En büyük düşüş" value={f.pct(ii.max_dd_pct, 1)} sub={`nakitte ${f.pct(r.max_dd_pct, 1)}`} color={t.down} />
      </View>
      <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
        Aynı işlemler; sermayenin %10’u nakitte kalır, fazlası haftada bir endeks fonuna yatırılır, yeni alımda
        gerekirse fon satılır (fon alım-satımı %0,1 maliyetli). Getiri artar ama düşüşler de derinleşir: eklenen
        getiri, eklenen piyasa riskinin karşılığıdır. Kısa vadeli para için para piyasası fonu da bir seçenektir.
      </Text>
    </View>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={[styles.tiny, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.big, { color }]}>{value}</Text>
      {sub ? <Text style={[styles.tiny, { color: t.muted }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  stats: { flexDirection: 'row', gap: 8 },
  big: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tiny: { fontSize: 11 },
  small: { fontSize: 12, lineHeight: 17 },
  idle: { marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  sym: { fontSize: 14, fontWeight: '700' },
  val: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
