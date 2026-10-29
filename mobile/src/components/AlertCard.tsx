import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '@/components/ui';
import * as f from '@/lib/format';
import { parseNumber } from '@/lib/risk';
import { useSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';
import type { Market } from '@/lib/types';

/** Kişisel fiyat alarmları: hazır seviyelerden ya da elle girilen fiyattan. */
export function AlertCard({ symbol, market, price, suggestions }: {
  symbol: string;
  market: Market;
  price: number;
  suggestions: { label: string; value: number | null | undefined }[];
}) {
  const t = useTheme();
  const { customAlerts, addAlert, removeAlert, push } = useSettings();
  const [txt, setTxt] = useState('');
  const mine = customAlerts.filter((a) => a.symbol === symbol && a.market === market);
  const v = parseNumber(txt);
  const valid = Number.isFinite(v) && v > 0;

  const add = (value: number) => {
    // Fiyatın üstündeki seviye için "üstüne çıkarsa", altındaki için "altına inerse"
    addAlert({ symbol, market, price: Math.round(value * 10000) / 10000, op: value >= price ? 'above' : 'below' });
    setTxt('');
  };

  return (
    <Card title="Fiyat alarmı">
      <Text style={[styles.note, { color: t.muted }]}>
        Fiyat seviyeye ulaşınca bildirim gelir (piyasa saatlerinde 5 dakikada bir kontrol; koşul sürdükçe günde bir kez).
        {push?.state !== 'ok' ? ' Bildirimler bu cihazda açık değil; alarm kaydedilir ama bildirim gelmez.' : ''}
      </Text>
      <View style={styles.chips}>
        {suggestions.filter((s) => s.value != null && s.value > 0).map((s) => (
          <Pressable key={s.label} onPress={() => add(s.value as number)} style={[styles.chip, { borderColor: t.border }]}>
            <Text style={[styles.chipText, { color: t.text }]}>{s.label} {f.price(s.value)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.row}>
        <TextInput
          value={txt}
          onChangeText={setTxt}
          placeholder={`Fiyat (şu an ${f.price(price)})`}
          placeholderTextColor={t.muted}
          keyboardType="decimal-pad"
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
        />
        <Pressable disabled={!valid} onPress={() => add(v)} style={[styles.button, { backgroundColor: t.accent, opacity: valid ? 1 : 0.4 }]}>
          <Text style={styles.buttonText}>Alarm kur</Text>
        </Pressable>
      </View>
      {valid ? (
        <Text style={[styles.note, { color: t.muted }]}>
          {f.price(v, market)} {v >= price ? 'üstüne çıkarsa' : 'altına inerse'} bildirim gelecek.
        </Text>
      ) : null}
      {mine.map((a) => (
        <View key={a.id} style={[styles.alert, { borderTopColor: t.border }]}>
          <Ionicons name={a.op === 'above' ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline'} size={18}
            color={a.op === 'above' ? t.up : t.down} />
          <Text style={[styles.alertText, { color: t.text }]}>
            {f.price(a.price, market)} {a.op === 'above' ? 'üstüne çıkarsa' : 'altına inerse'}
          </Text>
          <Pressable onPress={() => removeAlert(a.id)} hitSlop={10} accessibilityLabel="Alarmı sil">
            <Ionicons name="trash-outline" size={18} color={t.muted} />
          </Pressable>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  button: { borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  alert: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  alertText: { flex: 1, fontSize: 14, fontWeight: '600' },
});
