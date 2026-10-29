import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card, StateView } from '@/components/ui';
import { useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { usePortfolio, type Position } from '@/lib/portfolio';
import { quoteKey, useQuotes, type Quote } from '@/lib/quotes';
import { parseNumber } from '@/lib/risk';
import { useTheme } from '@/lib/theme';
import type { Market } from '@/lib/types';

/** "PİYASA:KOD" -> [yahoo kodu, son kapanış, destek, direnç, stop] */
type Levels = Record<string, [string, number | null, number | null, number | null, number | null]>;

interface Row {
  p: Position;
  price: number;
  value: number;
  pnl: number;
  pnlPct: number;
  stop: number | null;
  stopDistPct: number | null;
  lossAtStop: number | null;
  quote?: Quote;
}

export default function PortfolioScreen() {
  const t = useTheme();
  const { ready, positions, profile, setProfile, removePosition } = usePortfolio();
  const levels = useApi<Levels>(positions.length ? '/api/levels' : null);
  const quotes = useQuotes(positions);

  const rows: Row[] = positions.map((p) => {
    const key = quoteKey(p.symbol, p.market);
    const q = quotes[key];
    const lv = levels.data?.[key];
    const price = q?.price ?? lv?.[1] ?? p.cost;
    const stop = lv?.[4] ?? null;
    return {
      p,
      price,
      value: price * p.qty,
      pnl: (price - p.cost) * p.qty,
      pnlPct: (price / p.cost - 1) * 100,
      stop,
      stopDistPct: stop != null ? (stop / price - 1) * 100 : null,
      lossAtStop: stop != null && stop < price ? (price - stop) * p.qty : null,
      quote: q,
    };
  });

  if (!ready) return <StateView loading />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProfileCard profile={profile} onSave={setProfile} />

      {positions.length === 0 ? (
        <Card title="Pozisyonlar">
          <Text style={[styles.text, { color: t.muted }]}>
            Portföyün boş. Bir hissenin detay ekranındaki “Pozisyon hesaplayıcı” ile lot hesaplayıp “Portföye ekle”ye
            dokunarak pozisyon ekleyebilirsin.
          </Text>
        </Card>
      ) : (
        <>
          {(['BIST', 'US'] as Market[]).map((m) => {
            const rs = rows.filter((r) => r.p.market === m);
            if (!rs.length) return null;
            return <Totals key={m} market={m} rows={rs} capital={m === 'US' ? profile.capitalUSD : profile.capitalTRY} />;
          })}
          <Card title={`Pozisyonlar (${positions.length})`}>
            {rows.map((r) => (
              <PositionRow key={`${r.p.market}:${r.p.symbol}`} row={r} onRemove={() => removePosition(r.p.symbol, r.p.market)} />
            ))}
            <Text style={[styles.note, { color: t.muted }]}>
              Stop: günlük analizin önerdiği seviye. Fiyatlar dakikada bir yenilenir (BIST 15 dk gecikmeli). Portföy sadece
              bu telefonda saklanır.
            </Text>
          </Card>
        </>
      )}
    </ScrollView>
  );
}

function ProfileCard({ profile, onSave }: {
  profile: { capitalTRY: number; capitalUSD: number; riskPct: number };
  onSave: (p: { capitalTRY: number; capitalUSD: number; riskPct: number }) => void;
}) {
  const t = useTheme();
  const [tryTxt, setTryTxt] = useState<string | null>(null);
  const [usdTxt, setUsdTxt] = useState<string | null>(null);
  const [riskTxt, setRiskTxt] = useState<string | null>(null);
  const dirty = tryTxt != null || usdTxt != null || riskTxt != null;
  const values = {
    capitalTRY: parseNumber(tryTxt ?? String(profile.capitalTRY)),
    capitalUSD: parseNumber(usdTxt ?? String(profile.capitalUSD)),
    riskPct: parseNumber(riskTxt ?? String(profile.riskPct).replace('.', ',')),
  };
  const valid = values.capitalTRY >= 0 && values.capitalUSD >= 0 && values.riskPct > 0 && values.riskPct <= 10;

  return (
    <Card title="Risk profili">
      <Text style={[styles.text, { color: t.muted }]}>
        Pozisyon hesaplayıcı bu değerleri kullanır. Yaygın kural: tek işlemde sermayenin %0,5–2’sinden fazlasını riske etme.
      </Text>
      <View style={styles.inputs}>
        <Field label="Sermaye (₺)" value={tryTxt ?? String(profile.capitalTRY)} onChange={setTryTxt} />
        <Field label="Sermaye ($)" value={usdTxt ?? String(profile.capitalUSD)} onChange={setUsdTxt} />
        <Field label="İşlem başına risk %" value={riskTxt ?? String(profile.riskPct).replace('.', ',')} onChange={setRiskTxt} />
      </View>
      {dirty ? (
        <Pressable
          disabled={!valid}
          onPress={() => {
            onSave(values);
            setTryTxt(null);
            setUsdTxt(null);
            setRiskTxt(null);
          }}
          style={[styles.button, { backgroundColor: t.accent, opacity: valid ? 1 : 0.4 }]}>
          <Text style={styles.buttonText}>{valid ? 'Kaydet' : 'Risk % 0 ile 10 arasında olmalı'}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

function Totals({ market, rows, capital }: { market: Market; rows: Row[]; capital: number }) {
  const t = useTheme();
  const cost = rows.reduce((a, r) => a + r.p.cost * r.p.qty, 0);
  const value = rows.reduce((a, r) => a + r.value, 0);
  const pnl = value - cost;
  const risk = rows.reduce((a, r) => a + (r.lossAtStop ?? 0), 0);
  const c = pnl >= 0 ? t.up : t.down;
  return (
    <Card title={`${f.marketLabel(market)} toplam`}>
      <View style={styles.grid}>
        <Stat label="Değer" value={f.money(value, market)} />
        <Stat label="Kâr / zarar" value={`${pnl >= 0 ? '+' : '-'}${f.money(Math.abs(pnl), market)} (${f.pct((value / cost - 1) * 100, 1)})`} color={c} />
        <Stat label="Sermayeye oranı" value={capital > 0 ? `%${f.num((value / capital) * 100, 0)}` : '—'} />
        <Stat label="Stoplar gelirse kayıp" value={`-${f.money(risk, market)}${capital > 0 ? ` (%${f.num((risk / capital) * 100, 1)})` : ''}`} color={t.down} />
      </View>
    </Card>
  );
}

function PositionRow({ row, onRemove }: { row: Row; onRemove: () => void }) {
  const t = useTheme();
  const { p } = row;
  const c = row.pnl >= 0 ? t.up : t.down;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/stock/[symbol]', params: { symbol: p.symbol, market: p.market } })}
      style={[styles.row, { borderTopColor: t.border }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.symbol, { color: t.text }]}>{p.symbol}</Text>
        <Text style={[styles.small, { color: t.muted }]}>
          {p.qty.toLocaleString('tr-TR')} lot · maliyet {f.price(p.cost, p.market)}
        </Text>
        <Text style={[styles.small, { color: row.stopDistPct != null && row.stopDistPct > -3 ? t.warn : t.muted }]}>
          {row.stop != null
            ? `Stop ${f.price(row.stop)} (${f.pct(row.stopDistPct, 1)})${row.lossAtStop != null ? ` · gelirse -${f.money(row.lossAtStop)}` : ' · fiyat stop altında!'}`
            : 'Stop seviyesi yok'}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[styles.price, { color: t.text }]}>{f.price(row.price, p.market)}</Text>
        <Text style={[styles.small, { color: c, fontWeight: '700' }]}>
          {row.pnl >= 0 ? '+' : '-'}{f.money(Math.abs(row.pnl))} ({f.pct(row.pnlPct, 1)})
        </Text>
        {row.quote ? <Text style={[styles.tiny, { color: t.muted }]}>{f.quoteTime(row.quote)}</Text> : null}
      </View>
      <Pressable onPress={onRemove} hitSlop={10} accessibilityLabel={`${p.symbol} pozisyonunu sil`}>
        <Ionicons name="trash-outline" size={18} color={t.muted} />
      </Pressable>
    </Pressable>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.small, { color: t.muted, marginBottom: 3 }]}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType="decimal-pad"
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.small, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.statValue, { color: color ?? t.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  note: { fontSize: 11, lineHeight: 16, marginTop: 10 },
  inputs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  field: { width: '30%', flexGrow: 1, minWidth: 100 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 15, fontVariant: ['tabular-nums'] },
  button: { borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  stat: { width: '50%', paddingVertical: 5 },
  statValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  symbol: { fontSize: 15, fontWeight: '700' },
  small: { fontSize: 12, fontVariant: ['tabular-nums'] },
  tiny: { fontSize: 10 },
  price: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
