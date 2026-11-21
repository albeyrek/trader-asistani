import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card, Chip } from '@/components/ui';
import * as f from '@/lib/format';
import { usePortfolio } from '@/lib/portfolio';
import type { Quote } from '@/lib/quotes';
import { sizePosition } from '@/lib/risk';
import { useSettings } from '@/lib/settings';
import { useTheme, type Theme } from '@/lib/theme';
import type { Candidate } from '@/lib/types';

/** +0,25R biçimi (1R = stop mesafesi kadar kazanç/kayıp) */
export function rText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.num(Math.abs(v), 2)}R`;
}

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
  const { profile, capitalFor, addPosition } = usePortfolio();
  const { customAlerts, addAlert, removeAlert, isWatched, toggleWatch, plans, addPlan } = useSettings();
  const [buying, setBuying] = useState(false);
  const planned = plans.some((p) => p.symbol === c.symbol && p.market === c.market);

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
        {c.repeat ? (
          <Chip label={`Süren plan · ${f.date(c.repeat.since)}’den beri · yeniden alma`} fg={t.warn} bg={t.warnBg} />
        ) : null}
        <Chip label={ZONE_TEXT[status]} fg={zc.fg} bg={zc.bg} />
        {c.model ? (
          <Chip
            label={`Hedefe ulaşma %${Math.round(c.model.p * 100)}${c.model.exp_r != null ? ` · ${rText(c.model.exp_r)}` : ''}`}
            fg={t.text}
            bg={t.neutralBg}
          />
        ) : null}
      </View>

      <View style={[styles.plan, { borderColor: t.border }]}>
        <PlanCell label="Giriş aralığı" value={`${f.price(c.entry_low)} – ${f.price(c.entry_high)}`} />
        <PlanCell label="Stop" value={f.price(c.stop)} sub={`risk %${f.num(c.risk_pct, 1)}`} color={t.down} />
        {c.exit_rule?.trail ? (
          <PlanCell label="Çıkış" value="İz süren stop" sub={`${f.num(c.exit_rule.trail, 0)} ATR · ilk direnç ${f.price(c.target1)}`} color={t.up} />
        ) : (
          <PlanCell label="Hedef 1 / 2" value={`${f.price(c.target1)} / ${f.price(c.target2)}`} sub={`ödül/risk ${f.num(c.rr, 1)}`} color={t.up} />
        )}
      </View>
      {c.exit_note ? (
        <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>Çıkış kuralı: {c.exit_note}</Text>
      ) : null}
      {c.projected && !c.exit_rule?.trail ? (
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
      {planned ? (
        <Pressable onPress={() => router.push('/plans')} style={[styles.bought, { borderColor: t.up, backgroundColor: t.upBg }]}
          accessibilityRole="button">
          <Ionicons name="shield-checkmark-outline" size={16} color={t.up} />
          <Text style={[styles.small, { color: t.up, flex: 1, fontWeight: '600' }]}>
            Plan takipte: stop, iz süren stop ve süre için bildirim gelir. Takipteki planlar →
          </Text>
        </Pressable>
      ) : buying ? (
        <BuyForm c={c} defaultPrice={price} defaultQty={'error' in sizing ? 0 : sizing.qty}
          onCancel={() => setBuying(false)}
          onSave={(fill, qty) => {
            if (qty > 0) addPosition({ symbol: c.symbol, market: c.market, qty, price: fill });
            addPlan(planFor(c, fill));
            setBuying(false);
          }} />
      ) : (
        <Pressable onPress={() => setBuying(true)} style={[styles.bought, { borderColor: t.accent }]} accessibilityRole="button">
          <Ionicons name="cart-outline" size={16} color={t.accent} />
          <Text style={[styles.small, { color: t.accent, flex: 1, fontWeight: '600' }]}>
            Bu planla aldım: çıkışı benim için takip et
          </Text>
        </Pressable>
      )}
    </Card>
  );
}

/** Adayın çıkış kuralına göre takip edilecek plan (backend assistant_track ile aynı kural). */
function planFor(c: Candidate, fill: number) {
  const rule = c.exit_rule;
  const risk = fill - c.stop;
  const target = !rule ? c.target1 : rule.target == null ? null : typeof rule.target === 'number' ? fill + rule.target * risk : c.target1;
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // İstanbul günü
  return {
    symbol: c.symbol, market: c.market, opened: today, entry: fill, stop: c.stop, target,
    atr: c.atr && c.atr > 0 ? c.atr : risk / 1.5, trail: rule?.trail ?? null, hold: rule?.hold ?? 20, rule: rule?.name ?? 'base',
  };
}

function BuyForm({ c, defaultPrice, defaultQty, onSave, onCancel }: {
  c: Candidate; defaultPrice: number; defaultQty: number; onSave: (fill: number, qty: number) => void; onCancel: () => void;
}) {
  const t = useTheme();
  const [px, setPx] = useState(String(defaultPrice).replace('.', ','));
  const [qty, setQty] = useState(defaultQty ? String(defaultQty) : '');
  // "1.234,56" (Türkçe) ya da "1234.56" yazılabilir
  const fill = Number(px.includes(',') ? px.replace(/\./g, '').replace(',', '.') : px.trim());
  const n = Math.floor(Number(qty.replace(/[^0-9]/g, '')) || 0);
  const err = !(fill > 0) ? 'Alış fiyatını yaz.' : fill <= c.stop ? `Alış fiyatı stopun (${f.price(c.stop)}) üstünde olmalı.` : null;
  return (
    <View style={[styles.form, { borderColor: t.border }]}>
      <Text style={[styles.small, { color: t.text, fontWeight: '700' }]}>Alışını kaydet</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cellLabel, { color: t.muted }]}>Alış fiyatı</Text>
          <TextInput value={px} onChangeText={setPx} keyboardType="decimal-pad" style={[styles.input, { color: t.text, borderColor: t.border }]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cellLabel, { color: t.muted }]}>Adet (portföye eklenir)</Text>
          <TextInput value={qty} onChangeText={setQty} keyboardType="number-pad" placeholder="isteğe bağlı" placeholderTextColor={t.muted}
            style={[styles.input, { color: t.text, borderColor: t.border }]} />
        </View>
      </View>
      <Text style={[styles.small, { color: err ? t.down : t.muted }]}>
        {err ?? 'Buluta yalnızca plan gider (kod, alış fiyatı, stop, kural); adet ve maliyet telefonda kalır.'}
      </Text>
      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={[styles.button, { borderColor: t.border }]} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: t.text }]}>Vazgeç</Text>
        </Pressable>
        <Pressable onPress={() => !err && onSave(fill, n)} disabled={!!err}
          style={[styles.button, { borderColor: t.accent, backgroundColor: err ? t.neutralBg : t.accent }]} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: err ? t.muted : '#FFFFFF' }]}>Kaydet ve takip et</Text>
        </Pressable>
      </View>
    </View>
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
  bought: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 10 },
  form: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, marginTop: 10, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, marginTop: 2 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, marginBottom: 6 },
  check: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  buttonText: { fontSize: 13, fontWeight: '700' },
});
