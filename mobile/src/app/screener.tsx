import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { StockRow } from '@/components/StockRow';
import { Card, Segmented, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import { parseNumber } from '@/lib/risk';
import { applyFilter, describe, NUM_FIELDS, PRESETS, type NumField, type Range, type ScreenFilter } from '@/lib/screener';
import { useTheme } from '@/lib/theme';
import type { Level, Market, StockSummary } from '@/lib/types';

const SAVED_KEY = 'savedFilters';
const MAX_SHOWN = 200;
const LEVELS: Level[] = ['Düşük', 'Orta', 'Yüksek'];

const EMPTY: ScreenFilter = { id: 'custom', name: 'Özel filtre', ranges: {}, sort: 'combined_score', desc: true };

export default function ScreenerScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<Market>('BIST');
  const [saved, setSaved] = useState<ScreenFilter[]>([]);
  const [active, setActive] = useState<ScreenFilter>(PRESETS[0]);
  const [editing, setEditing] = useState(false);
  const { data, error, loading, reload } = useApi<{ total: number; items: StockSummary[] }>(
    `/api/scan?market=${market}&list=all&limit=5000`,
  );

  useEffect(() => {
    AsyncStorage.getItem(SAVED_KEY).then((v) => v && setSaved(JSON.parse(v))).catch(() => {});
  }, []);

  const persist = (next: ScreenFilter[]) => {
    setSaved(next);
    AsyncStorage.setItem(SAVED_KEY, JSON.stringify(next)).catch(() => {});
  };

  const results = useMemo(() => (data ? applyFilter(data.items, active) : []), [data, active]);
  const filters = [...PRESETS, ...saved];

  const header = (
    <View style={{ gap: 10, marginBottom: 10 }}>
      <Segmented options={[{ value: 'BIST', label: 'BIST' }, { value: 'US', label: 'ABD' }]} value={market} onChange={setMarket} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {filters.map((fl) => {
          const on = fl.id === active.id && !editing;
          return (
            <Pressable key={fl.id} onPress={() => { setActive(fl); setEditing(false); }}
              style={[styles.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent' }]}>
              <Text style={[styles.chipText, { color: on ? '#FFFFFF' : t.text }]}>
                {fl.preset ? '' : '★ '}{fl.name}
              </Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => { setActive({ ...EMPTY, ranges: { ...active.ranges } }); setEditing(true); }}
          style={[styles.chip, { borderColor: t.accent, backgroundColor: editing ? t.accent : 'transparent' }]}>
          <Text style={[styles.chipText, { color: editing ? '#FFFFFF' : t.accent }]}>+ Özel filtre</Text>
        </Pressable>
      </ScrollView>

      {editing ? (
        <FilterEditor
          value={active}
          onChange={setActive}
          onSave={(name) => {
            const fl = { ...active, id: `s-${Date.now().toString(36)}`, name, preset: false };
            persist([...saved.filter((x) => x.name !== name), fl]);
            setActive(fl);
            setEditing(false);
          }}
        />
      ) : (
        <Card>
          <Text style={[styles.title, { color: t.text }]}>{active.name}</Text>
          {active.description ? <Text style={[styles.text, { color: t.muted }]}>{active.description}</Text> : null}
          <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>{describe(active)}</Text>
          {!active.preset ? (
            <Pressable onPress={() => { persist(saved.filter((x) => x.id !== active.id)); setActive(PRESETS[0]); }}
              style={styles.delete}>
              <Ionicons name="trash-outline" size={14} color={t.down} />
              <Text style={[styles.small, { color: t.down }]}>Kayıtlı filtreyi sil</Text>
            </Pressable>
          ) : null}
        </Card>
      )}
      <Text style={[styles.small, { color: t.muted }]}>
        {data ? `${results.length} hisse uyuyor (${data.total} taranan)` : ''}
        {results.length > MAX_SHOWN ? ` · ilk ${MAX_SHOWN} gösteriliyor` : ''}
      </Text>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Filtreler' }} />
      <FlatList
        data={results.slice(0, MAX_SHOWN)}
        keyExtractor={(s) => `${s.market}:${s.symbol}`}
        renderItem={({ item }) => <StockRow item={item} />}
        ListHeaderComponent={header}
        ListEmptyComponent={<StateView loading={loading && !data} error={error} empty="Bu filtreye uyan hisse yok." onRetry={reload} />}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      />
    </>
  );
}

function FilterEditor({ value, onChange, onSave }: {
  value: ScreenFilter;
  onChange: (f: ScreenFilter) => void;
  onSave: (name: string) => void;
}) {
  const t = useTheme();
  const [name, setName] = useState('');
  const setRange = (k: NumField, part: 'min' | 'max', txt: string) => {
    const n = parseNumber(txt);
    const r: Range = { ...(value.ranges[k] ?? {}), [part]: Number.isFinite(n) ? n : undefined };
    onChange({ ...value, ranges: { ...value.ranges, [k]: r } });
  };
  const toggleRisk = (l: Level) => {
    const cur = value.risk ?? [];
    onChange({ ...value, risk: cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l] });
  };

  return (
    <Card title="Özel filtre">
      {NUM_FIELDS.map((fld) => (
        <View key={fld.key} style={styles.rangeRow}>
          <Text style={[styles.rangeLabel, { color: t.text }]}>
            {fld.label}{fld.hint ? <Text style={{ color: t.muted }}> ({fld.hint})</Text> : null}
          </Text>
          <TextInput placeholder="en az" placeholderTextColor={t.muted} keyboardType="numbers-and-punctuation"
            defaultValue={value.ranges[fld.key]?.min?.toString() ?? ''} onChangeText={(v) => setRange(fld.key, 'min', v)}
            style={[styles.rangeInput, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />
          <TextInput placeholder="en çok" placeholderTextColor={t.muted} keyboardType="numbers-and-punctuation"
            defaultValue={value.ranges[fld.key]?.max?.toString() ?? ''} onChangeText={(v) => setRange(fld.key, 'max', v)}
            style={[styles.rangeInput, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />
        </View>
      ))}

      <Text style={[styles.small, { color: t.muted, marginTop: 10 }]}>Genel risk</Text>
      <View style={styles.chipsRow}>
        {LEVELS.map((l) => {
          const on = value.risk?.includes(l);
          return (
            <Pressable key={l} onPress={() => toggleRisk(l)}
              style={[styles.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent' }]}>
              <Text style={[styles.chipText, { color: on ? '#FFFFFF' : t.text }]}>{l}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.switchRow}>
        <Text style={[styles.text, { color: t.text, flex: 1 }]}>Sadece yeni zirve bölgesindekiler</Text>
        <Switch value={!!value.newHigh} onValueChange={(v) => onChange({ ...value, newHigh: v })} />
      </View>
      <View style={styles.switchRow}>
        <Text style={[styles.text, { color: t.text, flex: 1 }]}>Bilançosuna 7 günden az kalanları çıkar</Text>
        <Switch value={value.excludeEarningsDays != null}
          onValueChange={(v) => onChange({ ...value, excludeEarningsDays: v ? 7 : undefined })} />
      </View>

      <Text style={[styles.small, { color: t.muted, marginTop: 10 }]}>Sırala</Text>
      <View style={styles.chipsRow}>
        {NUM_FIELDS.slice(0, 6).map((fld) => {
          const on = value.sort === fld.key;
          return (
            <Pressable key={fld.key} onPress={() => onChange({ ...value, sort: fld.key, desc: on ? !value.desc : true })}
              style={[styles.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : 'transparent' }]}>
              <Text style={[styles.chipText, { color: on ? '#FFFFFF' : t.text }]}>
                {fld.label}{on ? (value.desc ? ' ↓' : ' ↑') : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.saveRow}>
        <TextInput value={name} onChangeText={setName} placeholder="Filtre adı" placeholderTextColor={t.muted}
          style={[styles.nameInput, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />
        <Pressable disabled={!name.trim()} onPress={() => onSave(name.trim())}
          style={[styles.save, { backgroundColor: t.accent, opacity: name.trim() ? 1 : 0.4 }]}>
          <Text style={styles.saveText}>Kaydet</Text>
        </Pressable>
      </View>
      <Text style={[styles.small, { color: t.muted, marginTop: 6 }]}>Sonuçlar sen yazdıkça aşağıda güncellenir.</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  title: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, lineHeight: 17 },
  delete: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  rangeLabel: { flex: 1, fontSize: 13 },
  rangeInput: { width: 70, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  saveRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  nameInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  save: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontWeight: '700' },
});
