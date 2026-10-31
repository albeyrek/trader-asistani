import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CandidateCard, rText, zoneStatus } from '@/components/CandidateCard';
import { ModelCard } from '@/components/ModelCard';
import { Card, Chip, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { usePortfolio } from '@/lib/portfolio';
import { quoteKey, useQuotes } from '@/lib/quotes';
import { regimeColors, useTheme } from '@/lib/theme';
import type {
  AssistantData, AssistantMarket, AssistantScore, AssistantScoreMarket, Market, ModelMeta, StockSummary, TradeStatus,
} from '@/lib/types';

/** "PİYASA:KOD" -> [yahoo kodu, son kapanış, destek, direnç, stop] */
type Levels = Record<string, [string, number | null, number | null, number | null, number | null]>;

export default function AssistantScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ market?: string }>();
  const [picked, setPicked] = useState<Market | null>(null);
  const market: Market = picked ?? (params.market === 'US' ? 'US' : 'BIST');
  const { data, error, loading, reload } = useApi<AssistantData>('/api/assistant');
  const score = useApi<AssistantScore>('/api/assistant/score');
  const model = useApi<ModelMeta>('/api/model');
  const mk = data?.markets[market];
  const quotes = useQuotes(mk?.candidates ?? []);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { reload(); score.reload(); model.reload(); }} />}>
      <Segmented
        options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]}
        value={market}
        onChange={setPicked}
      />
      <View style={{ height: 12 }} />
      {!data ? (
        <StateView loading={loading} error={error} empty="Asistan verisi henüz yok." onRetry={reload} />
      ) : !mk ? (
        <StateView empty={`${f.marketLabel(market)} için bugün liste yok.`} />
      ) : (
        <>
          <StanceCard mk={mk} market={market} />
          {mk.candidates.map((c) => (
            <CandidateCard key={c.symbol} c={c} quote={quotes[quoteKey(c.symbol, c.market)]} riskScale={mk.risk_scale} />
          ))}
          <RadarCard mk={mk} />
          <PortfolioCheck market={market} mk={mk} />
          <ScoreCard sc={score.data?.[market]} />
          <ModelCard meta={model.data} market={market} />
          <Text style={[styles.disclaimer, { color: t.muted }]}>
            {data.disclaimer}
            {data.ai_model ? ` Yorumlar yapay zekâ ile (${data.ai_model.split('/').pop()}) yazılır ve hata içerebilir; sayılar plandan gelir.` : ''}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function StanceCard({ mk, market }: { mk: AssistantMarket; market: Market }) {
  const t = useTheme();
  const rc = regimeColors(t, mk.regime.score);
  const n = mk.candidates.length;
  return (
    <Card
      title={n ? `Günün alım adayları (${n})` : 'Bugün aday yok'}
      right={<Chip label={`Piyasa: ${mk.regime.label}`} fg={rc.fg} bg={rc.bg} />}>
      {mk.form ? (
        <View style={{ marginBottom: 8 }}>
          <Chip
            label={`Strateji formu (8 hafta): ${rText(mk.form.recent_r)}${mk.form.recent_r <= 0 ? ' · temkin modu' : ''}`}
            fg={mk.form.recent_r > 0 ? t.up : t.down}
            bg={mk.form.recent_r > 0 ? t.upBg : t.downBg}
          />
        </View>
      ) : null}
      <Text style={[styles.text, { color: t.text }]}>{mk.stance}</Text>
      <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
        {f.date(mk.date)} kapanışına göre {mk.screened} hisse tarandı; {mk.passed_filter} hisse süzgeçten geçti (yükseliş
        trendi, göreli güç ≥70, olumsuz haber ve uyarı yok, yakında bilanço yok), {mk.with_plan} tanesi için uygun ödül/risk
        planı çıktı.{mk.risk_scale < 1 ? ` Piyasa ortamı nedeniyle önerilen pozisyon büyüklüğü ×${f.num(mk.risk_scale, 2)}.` : ''}
        {mk.ranking === 'model' ? ' Sıralamayı öğrenen model yaptı; beklenen getirisi düşük olanlar elendi.' : ''}
        {market === 'BIST' ? ' Liste her iş günü ~18:45’te, ABD listesi sabah yenilenir.' : ' Liste her sabah (ABD kapanışından sonra) yenilenir.'}
      </Text>
    </Card>
  );
}

function RadarCard({ mk }: { mk: AssistantMarket }) {
  const t = useTheme();
  if (!mk.radar.length) return null;
  return (
    <Card title="Yakın takip">
      <Text style={[styles.small, { color: t.muted, marginBottom: 6 }]}>
        Planı olan ama bugün listeye girmeyen hisseler (sıralamada geride kaldı ya da zayıf piyasa için göreli gücü yetmedi).
      </Text>
      {mk.radar.map((r) => (
        <Pressable
          key={r.symbol}
          onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: r.symbol, market: r.market } })}
          style={[styles.row, { borderTopColor: t.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: t.text }]}>{r.symbol} <Text style={[styles.small, { color: t.muted }]}>{r.setup_text}</Text></Text>
            <Text style={[styles.small, { color: t.muted }]} numberOfLines={1}>{r.name}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.small, { color: t.text }]}>Giriş {f.price(r.entry_low)}–{f.price(r.entry_high)}</Text>
            <Text style={[styles.small, { color: t.muted }]}>
              stop {f.price(r.stop)} · Ö/R {f.num(r.rr, 1)}{r.model ? ` · hedefe ulaşma %${Math.round(r.model.p * 100)}${r.model.exp_r != null ? ` (${rText(r.model.exp_r)})` : ''}` : ` · göreli güç ${r.rs_rating}`}
            </Text>
          </View>
        </Pressable>
      ))}
    </Card>
  );
}

/** Portföydeki pozisyonlar için asistan notu: teknik görünüm bozuldu mu, stop altında mı, listede mi? */
function PortfolioCheck({ market, mk }: { market: Market; mk: AssistantMarket }) {
  const t = useTheme();
  const { positions } = usePortfolio();
  const mine = positions.filter((p) => p.market === market);
  const symbols = mine.map((p) => p.symbol).join(',');
  const stocks = useApi<{ items: StockSummary[] }>(symbols ? `/api/stocks?symbols=${encodeURIComponent(symbols)}` : null);
  const levels = useApi<Levels>(symbols ? '/api/levels' : null);
  const quotes = useQuotes(mine);
  if (!mine.length) return null;

  return (
    <Card title="Portföyün">
      {mine.map((p) => {
        const key = quoteKey(p.symbol, p.market);
        const s = stocks.data?.items.find((x) => x.symbol === p.symbol && x.market === p.market);
        const price = quotes[key]?.price ?? levels.data?.[key]?.[1] ?? null;
        const stop = levels.data?.[key]?.[4] ?? null;
        const cand = mk.candidates.find((c) => c.symbol === p.symbol);
        let note: { text: string; color: string };
        if (price != null && cand && zoneStatus(cand, price) === 'stopped') {
          note = { text: `Asistan planının stopu (${f.price(cand.stop)}) kırıldı: planı gözden geçir.`, color: t.down };
        } else if (price != null && stop != null && price < stop) {
          note = { text: `Fiyat günlük analizin stop seviyesinin (${f.price(stop)}) altında: çıkışı değerlendir.`, color: t.down };
        } else if (s && (s.outlook === 'Düşüş' || s.outlook === 'Güçlü Düşüş')) {
          note = { text: `Teknik görünüm “${s.outlook}”a döndü: stopu sıkılaştırmak ya da kâr almak düşünülebilir.`, color: t.warn };
        } else if (cand) {
          note = { text: 'Bugünkü aday listesinde: görünüm olumlu, plandaki stopu kullanabilirsin.', color: t.up };
        } else if (s) {
          note = { text: `Görünüm: ${s.outlook}${stop != null ? ` · stop ${f.price(stop)}` : ''}`, color: t.muted };
        } else {
          note = { text: 'Veri bekleniyor…', color: t.muted };
        }
        const pnl = price != null ? (price / p.cost - 1) * 100 : null;
        return (
          <Pressable
            key={key}
            onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.symbol, market: p.market } })}
            style={[styles.row, { borderTopColor: t.border }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.rowTitle, { color: t.text }]}>
                {p.symbol}{' '}
                <Text style={[styles.small, { color: pnl == null ? t.muted : pnl >= 0 ? t.up : t.down }]}>{f.pct(pnl, 1)}</Text>
              </Text>
              <Text style={[styles.small, { color: note.color }]}>{note.text}</Text>
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

const TRADE_TEXT: Record<TradeStatus, string> = {
  pending: 'bekliyor', not_filled: 'girilmedi', open: 'açık', target: 'hedef', stop: 'stop', timeout: 'süre doldu',
};

function ScoreCard({ sc }: { sc: AssistantScoreMarket | undefined }) {
  const t = useTheme();
  const r = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${f.num(v, 2)}R`);
  return (
    <Card title="Asistan karnesi">
      <Text style={[styles.small, { color: t.muted }]}>
        Geçmiş adaylar plana uyulsaydı ne olurdu? 5 gün içinde giriş bölgesine gelen aday alınmış sayılır; önce stop gelirse
        zarar, önce ilk hedef gelirse kâr, 20 günde ikisi de olmazsa son fiyattan kapanır. 1R = giriş ile stop arası mesafe.
      </Text>
      {!sc || !sc.signals ? (
        <Text style={[styles.text, { color: t.text, marginTop: 10 }]}>
          Kayıt yeni başladı; ilk sonuçlar adaylar stopa ya da hedefe ulaştıkça görünecek.
        </Text>
      ) : (
        <>
          <View style={styles.stats}>
            <Stat label="Sonuçlanan" value={`${sc.closed}`} sub={`${sc.targets} hedef · ${sc.stops} stop`} />
            <Stat label="Kazanma oranı" value={sc.win_rate == null ? '—' : `%${f.num(sc.win_rate, 0)}`} />
            <Stat label="Ortalama" value={r(sc.avg_r)} color={sc.avg_r == null ? t.muted : sc.avg_r >= 0 ? t.up : t.down} />
            <Stat label="Toplam" value={r(sc.total_r)} color={sc.total_r == null ? t.muted : sc.total_r >= 0 ? t.up : t.down} />
          </View>
          <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
            {sc.signals} aday ({f.date(sc.first_date)} itibarıyla) · {sc.open} açık · {sc.not_filled} girilmedi. Az sayıda
            işlemle sonuçlar şansa bağlıdır.
          </Text>
          {sc.trades.slice(0, 10).map((x) => (
            <View key={`${x.date}-${x.symbol}`} style={[styles.trade, { borderTopColor: t.border }]}>
              <Text style={[styles.small, { color: t.text, flex: 1 }]}>{f.date(x.date)} · {x.symbol}</Text>
              <Text style={[styles.small, { color: t.muted }]}>{TRADE_TEXT[x.status]}</Text>
              <Text style={[styles.small, styles.tradeR, { color: x.r == null ? t.muted : x.r >= 0 ? t.up : t.down }]}>{r(x.r)}</Text>
            </View>
          ))}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={[styles.tiny, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? t.text }]}>{value}</Text>
      {sub ? <Text style={[styles.tiny, { color: t.muted }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  rowTitle: { fontSize: 14, fontWeight: '700' },
  stats: { flexDirection: 'row', marginTop: 10 },
  statValue: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  trade: { flexDirection: 'row', gap: 10, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth },
  tradeR: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  disclaimer: { fontSize: 11, textAlign: 'center', lineHeight: 16, marginTop: 4 },
});
