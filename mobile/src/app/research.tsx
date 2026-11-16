import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { Card, Chip, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useTheme, type Theme } from '@/lib/theme';
import type { Market, ResearchCandidate, ResearchReport, Roadmap, RoadmapItem } from '@/lib/types';

const RULE_TEXT: Record<string, string> = { trail3: 'iz süren stop (3 ATR)', base: 'sabit hedef, 20 gün' };

function statusColors(t: Theme, s: RoadmapItem['status']): { fg: string; bg: string; label: string; icon: 'checkmark-circle' | 'play-circle' | 'arrow-forward-circle' | 'ellipse-outline' } {
  if (s === 'done') return { fg: t.up, bg: t.upBg, label: 'Tamam', icon: 'checkmark-circle' };
  if (s === 'active') return { fg: t.accent, bg: t.neutralBg, label: 'Sürüyor', icon: 'play-circle' };
  if (s === 'next') return { fg: t.warn, bg: t.warnBg, label: 'Sırada', icon: 'arrow-forward-circle' };
  return { fg: t.muted, bg: t.neutralBg, label: 'Planlandı', icon: 'ellipse-outline' };
}

/** Asistanın zekâsı: model yarışı (her hafta, geleceği görmeyen test) ve isabet yol haritası. */
export default function ResearchScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ market?: string }>();
  const [market, setMarket] = useState<Market>(params.market === 'US' ? 'US' : 'BIST');
  const race = useApi<ResearchReport>('/api/research');
  const road = useApi<Roadmap>('/api/roadmap');
  const mk = race.data?.markets[market];

  return (
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { race.reload(); road.reload(); }} />}>
      <Segmented options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]} value={market} onChange={setMarket} />
      {!race.data ? (
        <StateView loading={race.loading} error={race.error} empty="Model yarışı ilk kez haftalık öğrenmede çalışacak." onRetry={race.reload} />
      ) : !mk ? (
        <StateView empty="Bu piyasa için yarış sonucu yok." />
      ) : (
        <Card title="Model yarışı">
          <View style={[styles.decision, { backgroundColor: mk.champion ? t.upBg : t.neutralBg }]}>
            <Ionicons name={mk.champion ? 'trophy' : 'shield-outline'} size={18} color={mk.champion ? t.up : t.text} />
            <Text style={[styles.small, { color: t.text, flex: 1 }]}>{mk.decision}</Text>
          </View>
          <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
            Her hafta, {f.date(mk.period.from)}–{f.date(mk.period.to)} arası {mk.n.toLocaleString('tr-TR')} kurulumla; her
            model yalnızca o günden önceki veriyle eğitilip sonraki 6 aya uygulanır (geleceği görmez). Hedef: asistanın
            {' '}{RULE_TEXT[mk.rule] ?? mk.rule} çıkış kuralıyla sonuç. Ölçü: her gün seçtiği ilk {race.data.top_k} adayın sonucu.
          </Text>
          {Object.entries(mk.candidates).sort(([, a], [, b]) => b.edge_t - a.edge_t).map(([key, c]) => (
            <CandidateRow key={key} c={c} champion={mk.champion === key} />
          ))}
          <Text style={[styles.tiny, { color: t.muted, marginTop: 8 }]}>
            Şampiyon olma şartı: kurallara göre haftalık fark t ≥ {race.data.gate.t} (aynı anda birden çok model denendiği
            için yüksek), en az {rText(race.data.gate.edge)}, yılların en az %{race.data.gate.years * 100}’inde pozitif ve en iyi
            yıl çıkarılınca da pozitif. Geçen yoksa sıralamayı kurallar yapar.
          </Text>
        </Card>
      )}
      {race.data?.history?.length ? <Progress history={race.data.history} market={market} /> : null}
      {road.data ? <RoadmapCard road={road.data} /> : null}
    </ScrollView>
  );
}

function CandidateRow({ c, champion }: { c: ResearchCandidate; champion: boolean }) {
  const t = useTheme();
  const good = c.edge > 0;
  return (
    <View style={[styles.row, { borderTopColor: t.border }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={[styles.name, { color: t.text, flex: 1 }]}>{c.name}</Text>
        {champion ? <Chip label="Şampiyon" fg={t.up} bg={t.upBg} /> : null}
      </View>
      <Text style={[styles.small, { color: t.text }]}>
        İlk 5: <Text style={{ fontWeight: '700', color: good ? t.up : t.down }}>{rText(c.top_r)}</Text> (kurallar {rText(c.rule_r)},
        bütün adaylar {rText(c.all_r)}) · fark {rText(c.edge)}, t {f.num(c.edge_t, 2)} · isabet %{f.num(c.hit, 1)} (kurallar %{f.num(c.rule_hit, 1)})
      </Text>
      {!c.passed && c.why_not.length ? (
        <Text style={[styles.tiny, { color: t.muted }]}>Neden şampiyon değil: {c.why_not.join('; ')}</Text>
      ) : null}
    </View>
  );
}

function Progress({ history, market }: { history: ResearchReport['history']; market: Market }) {
  const t = useTheme();
  const rows = history.filter((h) => h[market]).slice(-8).reverse();
  if (!rows.length) return null;
  return (
    <Card title="Haftalık ilerleme">
      {rows.map((h) => {
        const m = h[market]!;
        return (
          <View key={h.at} style={[styles.progRow, { borderTopColor: t.border }]}>
            <Text style={[styles.small, { color: t.muted, width: 70 }]}>{f.date(h.at)}</Text>
            <Text style={[styles.small, { color: t.text, flex: 1 }]}>
              En iyi fark {m.best_edge != null ? rText(m.best_edge) : '—'} (t {m.best_t != null ? f.num(m.best_t, 2) : '—'}) ·
              {m.champion ? ' şampiyon var' : ' kurallar'} · {m.n.toLocaleString('tr-TR')} örnek
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

function RoadmapCard({ road }: { road: Roadmap }) {
  const t = useTheme();
  return (
    <Card title="İsabet yol haritası">
      <Text style={[styles.small, { color: t.text }]}>{road.goal}</Text>
      <Text style={[styles.tiny, { color: t.muted, marginTop: 4 }]}>{road.measure}</Text>
      {road.phases.map((p) => (
        <View key={p.id} style={{ marginTop: 12 }}>
          <Text style={[styles.name, { color: t.text }]}>{p.id}. {p.title} <Text style={{ color: t.muted, fontWeight: '400' }}>· {p.when}</Text></Text>
          {p.items.map((it) => {
            const c = statusColors(t, it.status);
            return (
              <View key={it.title} style={styles.item}>
                <Ionicons name={c.icon} size={16} color={c.fg} style={{ marginTop: 1 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.small, { color: t.text, fontWeight: '600' }]}>{it.title} <Text style={{ color: c.fg, fontWeight: '400' }}>· {c.label}</Text></Text>
                  <Text style={[styles.tiny, { color: t.muted }]}>{it.detail}</Text>
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  decision: { flexDirection: 'row', gap: 8, alignItems: 'center', borderRadius: 10, padding: 10 },
  row: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 3, marginTop: 6 },
  progRow: { flexDirection: 'row', gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  item: { flexDirection: 'row', gap: 8, marginTop: 6 },
  name: { fontSize: 13, fontWeight: '700' },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 11, lineHeight: 15 },
});
