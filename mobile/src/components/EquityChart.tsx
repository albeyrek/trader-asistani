import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';

import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';

const H = 170;
const PAD = 6;

/** Portföy ve endeks: başlangıç sermayesine göre yüzde değişim (iki çizgi). curve: [tarih, portföy, endeks] */
export function EquityChart({ curve, indexName, capital }: { curve: [string, number, number][]; indexName: string; capital: number }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  if (curve.length < 2) return null;
  const e0 = capital;
  const i0 = capital;
  const ep = curve.map((c) => (c[1] / e0 - 1) * 100);
  const ip = curve.map((c) => (c[2] / i0 - 1) * 100);
  const lo = Math.min(0, ...ep, ...ip);
  const hi = Math.max(0, ...ep, ...ip);
  const x = (i: number) => PAD + (i / (curve.length - 1)) * (w - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = curve.length - 1;
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
      {w > 0 ? (
        <Svg width={w} height={H}>
          <Line x1={PAD} x2={w - PAD} y1={y(0)} y2={y(0)} stroke={t.border} strokeDasharray="4 4" />
          <Path d={path(ip)} stroke={t.muted} strokeWidth={1.5} fill="none" />
          <Path d={path(ep)} stroke={ep[last] >= ip[last] ? t.up : t.down} strokeWidth={2.2} fill="none" />
        </Svg>
      ) : <View style={{ height: H }} />}
      <View style={styles.legend}>
        <View style={styles.item}>
          <View style={[styles.swatch, { backgroundColor: ep[last] >= ip[last] ? t.up : t.down }]} />
          <Text style={[styles.text, { color: t.text }]}>Asistan {f.pct(ep[last], 1)}</Text>
        </View>
        <View style={styles.item}>
          <View style={[styles.swatch, { backgroundColor: t.muted }]} />
          <Text style={[styles.text, { color: t.text }]}>{indexName} {f.pct(ip[last], 1)}</Text>
        </View>
        <Text style={[styles.text, { color: t.muted, marginLeft: 'auto' }]}>{ym(curve[0][0])} – {ym(curve[last][0])}</Text>
      </View>
    </View>
  );
}

function ym(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: '2-digit' });
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 3, borderRadius: 2 },
  text: { fontSize: 12 },
});
