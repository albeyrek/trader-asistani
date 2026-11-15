import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { rText } from '@/components/CandidateCard';
import { Card, Chip, StateView } from '@/components/ui';
import { WORKER_URL } from '@/lib/cloud';
import * as f from '@/lib/format';
import { useSettings, type TrackedPlan } from '@/lib/settings';
import { useTheme, type Theme } from '@/lib/theme';

interface PlanStatus {
  status: 'open' | 'stop' | 'target' | 'time';
  stop: number;
  peak: number;
  days: number;
  last: number | null;
  as_of: string | null;
  exit?: number;
  exit_date?: string;
  r: number | null;
}

const STATUS_TEXT: Record<PlanStatus['status'], string> = {
  open: 'Açık', stop: 'Stop: plana göre çıkış', target: 'Hedef: kâr al', time: 'Süre doldu: çık',
};
const RULE_TEXT: Record<string, string> = {
  trail3: 'İz süren stop (3 ATR)', trail2: 'İz süren stop (2 ATR)', base: 'Sabit hedef', be: 'Başabaş stoplu',
};

function statusColors(t: Theme, s: PlanStatus['status'] | undefined): { fg: string; bg: string } {
  if (s === 'stop') return { fg: t.down, bg: t.downBg };
  if (s === 'target') return { fg: t.up, bg: t.upBg };
  if (s === 'time') return { fg: t.warn, bg: t.warnBg };
  return { fg: t.accent, bg: t.neutralBg };
}

/** Takipteki planlar: "bu planla aldım" denen hisseler; iz süren stop her taramadan sonra bulutta güncellenir. */
export default function PlansScreen() {
  const t = useTheme();
  const { plans, removePlan, push } = useSettings();
  const token = push?.state === 'ok' ? push.token : null;
  const [statuses, setStatuses] = useState<Record<string, PlanStatus>>({});
  const [error, setError] = useState<string | null>(null);

  const fetchStatuses = useCallback(async (): Promise<Record<string, PlanStatus> | null> => {
    if (!token) return null;
    const r = await fetch(`${WORKER_URL}/api/plans?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { statuses: Record<string, PlanStatus> }).statuses;
  }, [token]);

  const load = useCallback(() => {
    fetchStatuses()
      .then((s) => {
        if (s) setStatuses(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [fetchStatuses]);

  useEffect(() => {
    let cancelled = false;
    fetchStatuses()
      .then((s) => {
        if (!cancelled && s) setStatuses(s);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchStatuses, plans.length]);

  if (!plans.length) {
    return <StateView empty={'Takipte plan yok. Asistan sekmesindeki bir adayda "Bu planla aldım" dediğinde burada görünür.'} />;
  }
  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}>
      <Text style={[styles.intro, { color: t.muted }]}>
        Her taramadan sonra (BIST ≈18:45, ABD sabah) planın stopu günlük mumlarla yeniden hesaplanır. İz süren stop yalnızca
        yükselir. Gün içinde fiyat stopun altına inerse ya da hedefe ulaşırsa bildirim gelir. Kural, asistanın 10 yıllık
        testte kullandığı çıkış kuralıyla aynıdır.
      </Text>
      {!token ? (
        <Text style={[styles.small, { color: t.warn }]}>Bildirim izni olmadan planlar bulutta takip edilemez (Ayarlar).</Text>
      ) : error ? (
        <Text style={[styles.small, { color: t.warn }]}>Plan durumları alınamadı ({error}); aşağı çekip yenile.</Text>
      ) : null}
      {plans.map((p) => <PlanCard key={p.id} p={p} s={statuses[p.id]} onRemove={() => removePlan(p.id)} />)}
    </ScrollView>
  );
}

function PlanCard({ p, s, onRemove }: { p: TrackedPlan; s: PlanStatus | undefined; onRemove: () => void }) {
  const t = useTheme();
  const [confirm, setConfirm] = useState(false);
  const col = statusColors(t, s?.status);
  const stop = s?.status === 'open' ? s.stop : p.stop;
  const locked = s && s.status === 'open' && s.stop > p.entry ? (s.stop - p.entry) / (p.entry - p.stop) : null;
  return (
    <Card>
      <Pressable onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.symbol, market: p.market } })}
        style={styles.head} accessibilityRole="button">
        <View style={{ flex: 1 }}>
          <Text style={[styles.sym, { color: t.text }]}>{p.symbol}</Text>
          <Text style={[styles.small, { color: t.muted }]}>
            {f.date(p.opened)} alış {f.price(p.entry, p.market)} · {RULE_TEXT[p.rule] ?? p.rule}
          </Text>
        </View>
        <Chip label={s ? STATUS_TEXT[s.status] : 'İlk hesap bekleniyor'} fg={col.fg} bg={col.bg} />
      </Pressable>
      <View style={[styles.grid, { borderColor: t.border }]}>
        <Cell label={s?.status === 'open' && p.trail ? 'Güncel stop' : 'Stop'} value={f.price(stop, p.market)}
          sub={locked != null ? `${rText(locked)} kâr korunuyor` : `ilk stop ${f.price(p.stop, p.market)}`} color={t.down} />
        <Cell label="Son kapanış" value={s?.last != null ? f.price(s.last, p.market) : '—'}
          sub={s?.r != null ? rText(s.r) : undefined} color={s?.r != null ? (s.r >= 0 ? t.up : t.down) : t.text} />
        <Cell label={p.target != null ? 'Hedef' : 'Süre'} value={p.target != null ? f.price(p.target, p.market) : `${s?.days ?? 0}/${p.hold} gün`}
          sub={p.target != null ? `${s?.days ?? 0}/${p.hold} gün` : undefined} color={t.up} />
      </View>
      {s && s.status !== 'open' ? (
        <Text style={[styles.small, { color: col.fg, marginTop: 6 }]}>
          {f.date(s.exit_date)} günü plana göre çıkış: {f.price(s.exit, p.market)} ({rText(s.r)}). Sattıysan takibi bitirebilirsin.
        </Text>
      ) : null}
      <Pressable onPress={() => (confirm ? onRemove() : setConfirm(true))} style={styles.remove} accessibilityRole="button">
        <Ionicons name="close-circle-outline" size={16} color={confirm ? t.down : t.muted} />
        <Text style={[styles.small, { color: confirm ? t.down : t.muted }]}>
          {confirm ? 'Emin misin? Takibi bitirmek için tekrar dokun' : 'Sattım / takibi bitir'}
        </Text>
      </Pressable>
    </Card>
  );
}

function Cell({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, paddingHorizontal: 8, gap: 2 }}>
      <Text style={[styles.tiny, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.val, { color }]}>{value}</Text>
      {sub ? <Text style={[styles.tiny, { color: t.muted }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 10 },
  intro: { fontSize: 12, lineHeight: 17 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sym: { fontSize: 17, fontWeight: '800' },
  small: { fontSize: 12, lineHeight: 17 },
  tiny: { fontSize: 11 },
  val: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginTop: 10, paddingVertical: 8 },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
});
