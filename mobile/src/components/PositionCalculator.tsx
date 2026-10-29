import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '@/components/ui';
import * as f from '@/lib/format';
import { usePortfolio } from '@/lib/portfolio';
import { parseNumber, sizePosition } from '@/lib/risk';
import { useTheme } from '@/lib/theme';
import type { Market } from '@/lib/types';

/** Hisse detayında: sermaye ve risk yüzdesine göre kaç lot alınabileceğini hesaplar, portföye ekler. */
export function PositionCalculator({ symbol, market, price, stop, target }: {
  symbol: string;
  market: Market;
  price: number;
  stop: number | null;
  target: number | null;
}) {
  const t = useTheme();
  const { profile, capitalFor, addPosition, getPosition } = usePortfolio();
  // null: kullanıcı değiştirmedi, öneri değeri kullanılır
  const [entryTxt, setEntryTxt] = useState<string | null>(null);
  const [stopTxt, setStopTxt] = useState<string | null>(null);
  const [targetTxt, setTargetTxt] = useState<string | null>(null);
  const [riskTxt, setRiskTxt] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const num = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
  const entryStr = entryTxt ?? num(price);
  const stopStr = stopTxt ?? num(stop);
  const targetStr = targetTxt ?? num(target);
  const riskStr = riskTxt ?? num(profile.riskPct);
  const capital = capitalFor(market);
  const cur = f.currency(market);

  const r = sizePosition({
    capital,
    riskPct: parseNumber(riskStr),
    entry: parseNumber(entryStr),
    stop: parseNumber(stopStr),
    target: parseNumber(targetStr) || null,
  });
  const pos = getPosition(symbol, market);

  const add = () => {
    if ('error' in r || r.qty <= 0) return;
    addPosition({ symbol, market, qty: r.qty, price: parseNumber(entryStr) });
    setAdded(`${r.qty} lot portföye eklendi.`);
  };

  return (
    <Card title="Pozisyon hesaplayıcı">
      <Text style={[styles.note, { color: t.muted }]}>
        Sermaye {f.price(capital, market)} · işlem başına risk %{riskStr || '—'}. Stop gelirse kaybın sermayenin bu
        yüzdesiyle sınırlı kalacak şekilde lot hesaplanır.{' '}
        <Text style={{ color: t.accent }} onPress={() => router.push('/portfolio')}>Sermayeyi değiştir</Text>
      </Text>
      <View style={styles.inputs}>
        <Field label={`Giriş (${cur})`} value={entryStr} onChange={setEntryTxt} />
        <Field label={`Stop (${cur})`} value={stopStr} onChange={setStopTxt} />
        <Field label={`Hedef (${cur})`} value={targetStr} onChange={setTargetTxt} />
        <Field label="Risk %" value={riskStr} onChange={setRiskTxt} />
      </View>

      {'error' in r ? (
        <Text style={[styles.note, { color: t.down }]}>{r.error}</Text>
      ) : (
        <>
          <View style={[styles.result, { backgroundColor: t.neutralBg }]}>
            <Text style={[styles.big, { color: t.text }]}>{r.qty.toLocaleString('tr-TR')} lot</Text>
            <Text style={[styles.note, { color: t.muted, marginTop: 0 }]}>
              {f.money(r.value, market)} · sermayenin %{r.capitalPct.toFixed(1).replace('.', ',')}’i
            </Text>
          </View>
          <View style={styles.grid}>
            <Out label="Stop’ta kayıp" value={`-${f.money(r.lossAtStop, market)}`} color={t.down} />
            <Out label="Hedefte kazanç" value={r.gainAtTarget != null ? `+${f.money(r.gainAtTarget, market)}` : '—'} color={t.up} />
            <Out label="Risk / getiri" value={r.rr != null ? `1 : ${f.num(r.rr, 2)}` : '—'} />
            <Out label="Stop uzaklığı" value={`%${f.num(r.stopPct, 1)}`} />
          </View>
          {r.warnings.map((w) => (
            <View key={w} style={styles.warn}>
              <Ionicons name="alert-circle-outline" size={14} color={t.warn} />
              <Text style={[styles.warnText, { color: t.warn }]}>{w}</Text>
            </View>
          ))}
          <Pressable
            onPress={add}
            disabled={r.qty <= 0}
            style={[styles.button, { backgroundColor: t.accent, opacity: r.qty > 0 ? 1 : 0.4 }]}>
            <Text style={styles.buttonText}>Portföye ekle ({r.qty} lot @ {f.price(parseNumber(entryStr))})</Text>
          </Pressable>
          {added ? <Text style={[styles.note, { color: t.up }]}>{added}</Text> : null}
        </>
      )}

      {pos ? (
        <View style={[styles.pos, { borderTopColor: t.border }]}>
          <Text style={[styles.posTitle, { color: t.text }]}>Portföyünde</Text>
          <Text style={[styles.note, { color: t.muted, marginTop: 2 }]}>
            {pos.qty} lot · maliyet {f.price(pos.cost, market)} · şu an{' '}
            <Text style={{ color: price >= pos.cost ? t.up : t.down, fontWeight: '700' }}>
              {price >= pos.cost ? '+' : '-'}{f.money(Math.abs((price - pos.cost) * pos.qty), market)} (
              {f.pct(((price / pos.cost) - 1) * 100, 1)})
            </Text>
          </Text>
        </View>
      ) : null}
      <Text style={[styles.note, { color: t.muted }]}>Hesaplama yardımcıdır, yatırım tavsiyesi değildir.</Text>
    </Card>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: t.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
      />
    </View>
  );
}

function Out({ label, value, color }: { label: string; value: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.out}>
      <Text style={[styles.fieldLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.outValue, { color: color ?? t.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  inputs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  field: { width: '47%', flexGrow: 1 },
  fieldLabel: { fontSize: 11, marginBottom: 3 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 15, fontVariant: ['tabular-nums'] },
  result: { borderRadius: 10, padding: 12, marginTop: 12, alignItems: 'center' },
  big: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  out: { width: '50%', paddingVertical: 5 },
  outValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  warn: { flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'flex-start' },
  warnText: { flex: 1, fontSize: 12, lineHeight: 17 },
  button: { borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  pos: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 12, paddingTop: 10 },
  posTitle: { fontSize: 13, fontWeight: '700' },
});
