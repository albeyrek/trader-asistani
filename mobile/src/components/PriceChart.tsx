import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Bar, Market } from '@/lib/types';

export interface ChartLevel {
  label: string;
  value: number | null | undefined;
  kind: 'support' | 'resistance' | 'stop';
}

const HEIGHT = 230;
const VOLUME_H = 34;
const PAD_RIGHT = 52; // fiyat etiketleri için
const PAD_TOP = 8;

type EmaKey = 'ema_fast' | 'ema_mid' | 'ema_slow';

function linePath(bars: Bar[], key: 'close' | EmaKey, x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let drawing = false;
  bars.forEach((b, i) => {
    const v = b[key];
    if (v == null) {
      drawing = false;
      return;
    }
    d += `${drawing ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    drawing = true;
  });
  return d;
}

export function PriceChart({ bars, levels, market, emaLabels }: {
  bars: Bar[];
  levels: ChartLevel[];
  market: Market;
  emaLabels: [string, string, string];
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - PAD_RIGHT, 1);
  const priceH = HEIGHT - VOLUME_H - PAD_TOP;

  const scale = useMemo(() => {
    const visibleLevels = levels.map((l) => l.value).filter((v): v is number => v != null);
    const values = bars.flatMap((b) => [b.low, b.high]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    // Grafiğe çok uzak seviyeler ölçeği bozmasın: sadece fiyat aralığının %25 yakınındakiler dahil edilir
    const range = hi - lo || 1;
    for (const v of visibleLevels) {
      if (v >= lo - range * 0.25 && v <= hi + range * 0.25) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const pad = (hi - lo) * 0.05 || 1;
    const maxVol = Math.max(...bars.map((b) => b.volume), 1);
    return { lo: lo - pad, hi: hi + pad, maxVol };
  }, [bars, levels]);

  if (bars.length < 2) {
    return <Text style={{ color: t.muted }}>Grafik için yeterli veri yok.</Text>;
  }

  const x = (i: number) => (i / (bars.length - 1)) * plotW;
  const y = (v: number) => PAD_TOP + (1 - (v - scale.lo) / (scale.hi - scale.lo)) * priceH;
  const barW = Math.max(plotW / bars.length - 1, 1);

  const onTouch = (e: GestureResponderEvent) => {
    const lx = e.nativeEvent.locationX;
    const i = Math.round((lx / plotW) * (bars.length - 1));
    setHover(Math.min(Math.max(i, 0), bars.length - 1));
  };

  const shown = bars[hover ?? bars.length - 1];
  const first = bars[0].close;
  const lastClose = bars[bars.length - 1].close;
  const lineColor = lastClose >= first ? t.up : t.down;
  const levelColor = { support: t.up, resistance: t.down, stop: t.muted };

  return (
    <View>
      <View style={styles.readout}>
        <Text style={[styles.readoutDate, { color: t.muted }]}>{shown.d}</Text>
        <Text style={[styles.readoutPrice, { color: t.text }]}>{f.price(shown.close, market)}</Text>
        <Text style={[styles.readoutSub, { color: t.muted }]}>
          A {f.price(shown.open)} · Y {f.price(shown.high)} · D {f.price(shown.low)}
        </Text>
      </View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
        onResponderRelease={() => setHover(null)}
        onResponderTerminate={() => setHover(null)}
        style={{ height: HEIGHT }}>
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {/* hacim çubukları */}
            {bars.map((b, i) => {
              const h = (b.volume / scale.maxVol) * (VOLUME_H - 4);
              return (
                <Rect
                  key={b.d}
                  x={x(i) - barW / 2}
                  y={HEIGHT - h}
                  width={barW}
                  height={h}
                  fill={b.close >= b.open ? t.up : t.down}
                  opacity={0.25}
                />
              );
            })}
            {/* seviyeler */}
            {levels.map((l) =>
              l.value != null && l.value >= scale.lo && l.value <= scale.hi ? (
                <Line
                  key={l.label}
                  x1={0}
                  x2={plotW}
                  y1={y(l.value)}
                  y2={y(l.value)}
                  stroke={levelColor[l.kind]}
                  strokeWidth={1}
                  strokeDasharray={l.kind === 'stop' ? '2,4' : '6,4'}
                />
              ) : null,
            )}
            {levels.map((l) =>
              l.value != null && l.value >= scale.lo && l.value <= scale.hi ? (
                <SvgText key={`${l.label}-t`} x={plotW + 4} y={y(l.value) + 4} fontSize={10} fill={levelColor[l.kind]}>
                  {f.price(l.value)}
                </SvgText>
              ) : null,
            )}
            {/* ortalamalar ve fiyat */}
            <Path d={linePath(bars, 'ema_slow', x, y)} stroke={t.emaSlow} strokeWidth={1.2} fill="none" opacity={0.85} />
            <Path d={linePath(bars, 'ema_mid', x, y)} stroke={t.emaMid} strokeWidth={1.2} fill="none" opacity={0.85} />
            <Path d={linePath(bars, 'ema_fast', x, y)} stroke={t.emaFast} strokeWidth={1.2} fill="none" opacity={0.85} />
            <Path d={linePath(bars, 'close', x, y)} stroke={lineColor} strokeWidth={2} fill="none" />
            {/* son fiyat etiketi */}
            <SvgText x={plotW + 4} y={y(lastClose) + 4} fontSize={10} fontWeight="bold" fill={lineColor}>
              {f.price(lastClose)}
            </SvgText>
            {hover != null ? (
              <Line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={HEIGHT} stroke={t.muted} strokeWidth={1} />
            ) : null}
          </Svg>
        ) : null}
      </View>
      <View style={styles.legend}>
        <LegendItem color={lineColor} label="Kapanış" />
        <LegendItem color={t.emaFast} label={emaLabels[0]} />
        <LegendItem color={t.emaMid} label={emaLabels[1]} />
        <LegendItem color={t.emaSlow} label={emaLabels[2]} />
        {levels.filter((l) => l.value != null).map((l) => (
          <LegendItem key={l.label} color={levelColor[l.kind]} label={l.label} dashed />
        ))}
      </View>
    </View>
  );
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  const t = useTheme();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: dashed ? 'transparent' : color, borderColor: color }, dashed && styles.legendDashed]} />
      <Text style={[styles.legendText, { color: t.muted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { marginBottom: 6 },
  readoutDate: { fontSize: 12 },
  readoutPrice: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutSub: { fontSize: 11, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 14, height: 3, borderRadius: 2, borderWidth: 1 },
  legendDashed: { borderStyle: 'dashed', height: 0, borderTopWidth: 2, borderWidth: 0 },
  legendText: { fontSize: 11 },
});
