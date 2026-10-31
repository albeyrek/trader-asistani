import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { usePortfolio } from '@/lib/portfolio';
import type { Quote } from '@/lib/quotes';
import { sizePosition } from '@/lib/risk';
import { useSettings } from '@/lib/settings';
import { useTheme, type Theme } from '@/lib/theme';
import type { Candidate } from '@/lib/types';

export type ZoneStatus = 'in_zone' | 'above' | 'below' | 'stopped';

/** Güncel fiyatın plana göre yeri (bulut bekçisindeki candidateStatus ile aynı). */
export function zoneStatus(c: Candidate, price: number): ZoneStatus {
  if (price <= c.stop) return 'stopped';
  if (price > c.entry_high) return 'above';
  if (price < c.entry_low) return 'below';
  return 'in_zone';
}

const ZONE_TEXT: Record<ZoneStatus, string> = {
  in_zone: 'Giriş bölgesinde',
  above: 'Bölgenin üstünde · kovalamayın',
  below: 'Bölgenin altında · zayıflık',
  stopped: 'Stop altında · plan geçersiz',
};

function zoneColors(t: Theme, s: ZoneStatus): { fg: string; bg: string } {
  if (s === 'in_zone') return { fg: t.up, bg: t.upBg };
  if (s === 'stopped') return { fg: t.down, bg: t.downBg };
  return { fg: t.warn, bg: t.warnBg };
}

export function CandidateCard({ c, quote, riskScale }: { c: Candidate; quote?: Quote; riskScale: number }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const { profile, capitalFor } = usePortfolio();
  const { customAlerts, addAlert, removeAlert, isWatched, toggleWatch } = useSettings();

  const price = quote?.price ?? c.close;
  const status = zoneStatus(c, price);
  const zc = zoneColors(t, status);
  const entry = (c.entry_low + c.entry_high) / 2;
  const riskPct = profile.riskPct * riskScale;
  const sizing = sizePosition({ capital: capitalFor(c.market), riskPct, entry, stop: c.stop, target: c.target1 });

  const planAlerts = customAlerts.filter(
    (a) => a.symbol === c.symbol && a.market === c.market
      && ((a.op === 'below' && a.price === c.stop) || (a.op === 'above' && a.price === c.target1)),
  );
  const tracked = planAlerts.length > 0;
  const track = () => {
    if (tracked) {
      planAlerts.forEach((a) => removeAlert(a.id));
      return;
    }
    if (!isWatched(c.symbol, c.market)) toggleWatch({ symbol: c.symbol, market: c.market });
    addAlert({ symbol: c.symbol, market: c.market, op: 'below', price: c.stop });
    addAlert({ symbol: c.symbol, market: c.market, op: 'above', price: c.target1 });
  };
  const goDetail = () => router.push({ pathname: '/stock/[symbol]', params: { symbol: c.symbol, market: c.market } });

  return (
    <Card>
      <Pressable onPress={goDetail} style={styles.head} accessibilityRole="button">
        <View style={{ flex: 1 }}>
          <Text style={[styles.symbol, { color: t.text }]}>{c.symbol}</Text>
          <Text style={[styles.name, { color: t.muted }]} numberOfLines={1}>{c.name}{c.sector ? ` · ${c.sector}` : ''}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.price, { color: t.text }]}>{f.price(price, c.market)}</Text>
          <Text style={[styles.small, { color: (quote?.change_pct ?? c.change_pct ?? 0) >= 0 ? t.up : t.down }]}>
            {f.pct(quote?.change_pct ?? c.change_pct, 1)}{quote ? ` · ${f.quoteTime(quote)}` : ' · son kapanış'}
          </Text>
        </View>
      </Pressable>

      <View style={styles.chips}>
        <Chip label={c.setup_text} fg={t.accent} bg={t.neutralBg} />
        <Chip label={`Göreli güç ${c.rs_rating}`} fg={c.rs_rating >= 80 ? t.up : t.muted} bg={c.rs_rating >= 80 ? t.upBg : t.neutralBg} />
        <Chip label={ZONE_TEXT[status]} fg={zc.fg} bg={zc.bg} />
      </View>

      <View style={[styles.plan, { borderColor: t.border }]}>
        <PlanCell label="Giriş aralığı" value={`${f.price(c.entry_low)} – ${f.price(c.entry_high)}`} />
        <PlanCell label="Stop" value={f.price(c.stop)} sub={`risk %${f.num(c.risk_pct, 1)}`} color={t.down} />
        <PlanCell label="Hedef 1 / 2" value={`${f.price(c.target1)} / ${f.price(c.target2)}`} sub={`ödül/risk ${f.num(c.rr, 1)}`} color={t.up} />
      </View>
      {c.projected ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
          Fiyat zirve bölgesinde, üstte direnç yok: hedefler stop mesafesinin katları olarak hesaplandı.
        </Text>
      ) : null}

      <Text style={[styles.sectionLabel, { color: t.muted }]}>{c.ai ? 'Asistan yorumu (yapay zekâ)' : 'Asistan yorumu'}</Text>
      <Text style={[styles.text, { color: t.text }]}>{c.ai ?? c.commentary}</Text>

      {'error' in sizing ? null : (
        <Text style={[styles.small, { color: t.muted, marginTop: 8 }]}>
          Risk profiline göre (sermayenin %{f.num(riskPct, riskPct % 1 ? 2 : 0)}’i riskte
          {riskScale < 1 ? `, zayıf piyasa için ×${f.num(riskScale, 2)}` : ''}): {sizing.qty} adet ≈ {f.money(sizing.value, c.market)},
          stopta kayıp ≈ {f.money(sizing.lossAtStop, c.market)}
        </Text>
      )}

      <Pressable onPress={() => setOpen((o) => !o)} style={styles.more} accessibilityRole="button">
        <Text style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>{open ? 'Gerekçeleri gizle' : 'Gerekçeler ve haberler'}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={t.accent} />
      </Pressable>
      {open ? (
        <View style={{ gap: 6 }}>
          {c.checks.map((x) => (
            <View key={x.label} style={styles.check}>
              <Ionicons name={x.ok ? 'checkmark-circle' : 'alert-circle'} size={16} color={x.ok ? t.up : t.warn} />
              <Text style={[styles.text, { color: t.text, flex: 1 }]}>
                <Text style={{ fontWeight: '700' }}>{x.label}: </Text>{x.text}
              </Text>
            </View>
          ))}
          {c.reasons.length ? (
            <Text style={[styles.small, { color: t.muted, marginTop: 4 }]}>Grafik: {c.reasons.join(' · ')}</Text>
          ) : null}
          {c.news.map((n) => (
            <Pressable key={n.url} onPress={() => Linking.openURL(n.url)}>
              <Text style={[styles.small, { color: n.sentiment > 0 ? t.up : n.sentiment < 0 ? t.down : t.text }]} numberOfLines={2}>
                {n.sentiment > 0 ? '▲' : n.sentiment < 0 ? '▼' : '•'} {n.title}
                <Text style={{ color: t.muted }}>{n.date ? ` · ${f.date(n.date)}` : ''}</Text>
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.buttons}>
        <Pressable onPress={goDetail} style={[styles.button, { borderColor: t.border }]} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: t.text }]}>Grafik ve detay</Text>
        </Pressable>
        <Pressable
          onPress={track}
          style={[styles.button, tracked ? { borderColor: t.up, backgroundColor: t.upBg } : { borderColor: t.accent }]}
          accessibilityRole="button">
          <Text style={[styles.buttonText, { color: tracked ? t.up : t.accent }]}>
            {tracked ? '✓ Takipte (kaldır)' : 'Takibe al'}
          </Text>
        </Pressable>
      </View>
      {tracked ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>
          İzleme listesine eklendi; fiyat {f.price(c.stop)} altına inerse ya da {f.price(c.target1)} üstüne çıkarsa bildirim gelir.
        </Text>
      ) : null}
    </Card>
  );
}

function PlanCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.cell}>
      <Text style={[styles.cellLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.cellValue, { color: color ?? t.text }]}>{value}</Text>
      {sub ? <Text style={[styles.cellSub, { color: t.muted }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  symbol: { fontSize: 18, fontWeight: '800' },
  name: { fontSize: 12, marginTop: 1 },
  price: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  plan: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginTop: 12, paddingVertical: 8 },
  cell: { flex: 1, paddingHorizontal: 8, gap: 2 },
  cellLabel: { fontSize: 11 },
  cellValue: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cellSub: { fontSize: 10 },
  sectionLabel: { fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, marginBottom: 6 },
  check: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  buttonText: { fontSize: 13, fontWeight: '700' },
});
