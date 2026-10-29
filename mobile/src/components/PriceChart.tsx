import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import * as f from '@/lib/format';
import { useTheme } from '@/lib/theme';
import type { Bar, Market, TrendLine } from '@/lib/types';

export interface ChartLevel {
  label: string;
  value: number | null | undefined;
  kind: 'support' | 'resistance' | 'stop';
}

export type ChartType = 'line' | 'candle';

const HEIGHT = 250;
const VOLUME_H = 34;
const PAD_RIGHT = 54; // fiyat etiketleri için
const PAD_TOP = 8;
const LABEL_GAP = 11; // fiyat etiketleri arasında en az bu kadar piksel

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

/** Tarihe göre çubuk indeksi (tarih yoksa ondan sonraki ilk çubuk). */
function indexOf(all: Bar[], d: string): number {
  const i = all.findIndex((b) => b.d >= d);
  return i < 0 ? all.length - 1 : i;
}

const MIN_SPAN = 12; // en fazla yakınlaştırmada görünen mum sayısı
const ZOOM_STEP = 1.5;

type Gesture =
  | { mode: 'scrub' }
  | { mode: 'pinch'; dist0: number; mid0: number; span0: number; end0: number };

function touchInfo(e: GestureResponderEvent): { n: number; dist: number; mid: number } {
  const ts = e.nativeEvent.touches;
  if (ts.length < 2) return { n: ts.length, dist: 0, mid: e.nativeEvent.locationX };
  const [a, b] = ts;
  return { n: ts.length, dist: Math.abs(a.pageX - b.pageX), mid: (a.locationX + b.locationX) / 2 };
}

/**
 * all: tüm geçmiş (trend çizgilerinin başlangıcını bulmak için), visible: başlangıçta görünen son mum sayısı.
 * Yakınlaştırma: iki parmakla sıkıştırma / sürükleme ya da alttaki düğmeler. Tek parmak: mum değerlerini okuma.
 */
export function PriceChart({ all, visible, levels, trendlines, market, emaLabels, type, unitless }: {
  all: Bar[];
  visible: number;
  levels: ChartLevel[];
  trendlines: TrendLine[];
  market: Market;
  emaLabels: [string, string, string];
  type: ChartType;
  /** Endeks gibi para birimi olmayan seriler için (₺/$ gösterilmez) */
  unitless?: boolean;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const initialSpan = Math.min(visible, all.length);
  const [span, setSpan] = useState(initialSpan); // görünen mum sayısı
  const [endOff, setEndOff] = useState(0); // sağda gizlenen (daha yeni) mum sayısı
  const gesture = useRef<Gesture>({ mode: 'scrub' });

  const clampView = (s: number, e: number): [number, number] => {
    const sp = Math.round(Math.min(Math.max(s, Math.min(MIN_SPAN, all.length)), all.length));
    const en = Math.round(Math.min(Math.max(e, 0), all.length - sp));
    return [sp, en];
  };
  const setView = (s: number, e: number) => {
    const [sp, en] = clampView(s, e);
    setSpan(sp);
    setEndOff(en);
  };

  const offset = Math.max(0, all.length - endOff - span);
  const last = all.length - 1 - endOff; // görünen son mumun indeksi (tüm geçmişte)
  const bars = useMemo(() => all.slice(offset, last + 1), [all, offset, last]);
  const plotW = Math.max(width - PAD_RIGHT, 1);
  const priceH = HEIGHT - VOLUME_H - PAD_TOP;

  // Trend çizgileri: bütün geçmiş üzerindeki indekslerle doğrusal; görünen pencereye kırpılır
  const lines = useMemo(
    () =>
      trendlines.map((tl) => {
        const i1 = indexOf(all, tl.start.d);
        const i2 = all.length - 1;
        const slope = i2 > i1 ? (tl.end.price - tl.start.price) / (i2 - i1) : 0;
        const from = Math.max(i1, offset);
        const to = Math.min(i2, last);
        const at = (i: number) => tl.start.price + slope * (i - i1);
        return { tl, from: from - offset, to: to - offset, v1: at(from), v2: at(to) };
      }),
    [trendlines, all, offset, last],
  );

  const scale = useMemo(() => {
    const values = bars.flatMap((b) => (type === 'candle' ? [b.low, b.high] : [b.close]));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    // Grafiğe çok uzak seviyeler ölçeği bozmasın: sadece fiyat aralığının %25 yakınındakiler dahil edilir
    const range = hi - lo || 1;
    const extra = [...levels.map((l) => l.value), ...lines.flatMap((l) => [l.v1, l.v2])];
    for (const v of extra) {
      if (v != null && v >= lo - range * 0.25 && v <= hi + range * 0.25) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const pad = (hi - lo) * 0.05 || 1;
    const maxVol = Math.max(...bars.map((b) => b.volume), 1);
    return { lo: lo - pad, hi: hi + pad, maxVol };
  }, [bars, levels, lines, type]);

  if (bars.length < 2) {
    return <Text style={{ color: t.muted }}>Grafik için yeterli veri yok.</Text>;
  }

  const x = (i: number) => (i / (bars.length - 1)) * plotW;
  const y = (v: number) => PAD_TOP + (1 - (v - scale.lo) / (scale.hi - scale.lo)) * priceH;
  const inView = (v: number | null | undefined): v is number => v != null && v >= scale.lo && v <= scale.hi;
  const slot = plotW / bars.length;
  const bodyW = Math.max(slot * 0.65, 1);

  const scrub = (locationX: number) => {
    const i = Math.round((locationX / plotW) * (bars.length - 1));
    setHover(Math.min(Math.max(i, 0), bars.length - 1));
  };

  const onTouch = (e: GestureResponderEvent) => {
    const ti = touchInfo(e);
    if (ti.n >= 2) {
      const g = gesture.current;
      if (g.mode !== 'pinch') {
        gesture.current = { mode: 'pinch', dist0: Math.max(ti.dist, 1), mid0: ti.mid, span0: span, end0: endOff };
        setHover(null);
        return;
      }
      // Parmaklar açıldıkça daha az mum (yakınlaştırma); orta nokta kaydıkça pencere kayar
      const newSpan = (g.span0 * g.dist0) / Math.max(ti.dist, 1);
      const shift = ((ti.mid - g.mid0) / plotW) * g.span0;
      setView(newSpan, g.end0 + shift);
      return;
    }
    if (gesture.current.mode === 'scrub') scrub(e.nativeEvent.locationX);
  };

  const endGesture = () => {
    gesture.current = { mode: 'scrub' };
    setHover(null);
  };

  const shown = bars[Math.min(hover ?? bars.length - 1, bars.length - 1)];
  const lastClose = bars[bars.length - 1].close;
  const periodChange = (lastClose / bars[0].close - 1) * 100;
  const lineColor = periodChange >= 0 ? t.up : t.down;
  const levelColor = { support: t.up, resistance: t.down, stop: t.muted };

  // Sağdaki fiyat etiketleri: son fiyat her zaman, diğerleri birbirine çok yakınsa atlanır
  const labels: { y: number; text: string; color: string; bold?: boolean }[] = [
    { y: y(lastClose), text: f.price(lastClose), color: lineColor, bold: true },
  ];
  for (const l of levels) {
    if (!inView(l.value)) continue;
    const ly = y(l.value);
    if (labels.every((o) => Math.abs(o.y - ly) >= LABEL_GAP)) labels.push({ y: ly, text: f.price(l.value), color: levelColor[l.kind] });
  }

  return (
    <View>
      <View style={styles.readout}>
        <Text style={[styles.readoutDate, { color: t.muted }]}>
          {shown.d}
          {hover == null ? ` · dönem ${f.pct(periodChange, 1)}` : ''}
        </Text>
        <Text style={[styles.readoutPrice, { color: t.text }]}>{f.price(shown.close, unitless ? undefined : market)}</Text>
        <Text style={[styles.readoutSub, { color: t.muted }]}>
          A {f.price(shown.open)} · Y {f.price(shown.high)} · D {f.price(shown.low)} · K {f.price(shown.close)}
        </Text>
      </View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
        onResponderRelease={endGesture}
        onResponderTerminate={endGesture}
        // Grafik üzerindeyken sayfa kaydırması hareketi çalmasın
        onResponderTerminationRequest={() => false}
        style={{ height: HEIGHT }}>
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {/* hacim çubukları */}
            {bars.map((b, i) => {
              const h = (b.volume / scale.maxVol) * (VOLUME_H - 4);
              return (
                <Rect key={`v${b.d}`} x={x(i) - bodyW / 2} y={HEIGHT - h} width={bodyW} height={h}
                  fill={b.close >= b.open ? t.up : t.down} opacity={0.25} />
              );
            })}
            {/* yatay destek / direnç / stop */}
            {levels.map((l) =>
              inView(l.value) ? (
                <Line key={l.label} x1={0} x2={plotW} y1={y(l.value)} y2={y(l.value)} stroke={levelColor[l.kind]}
                  strokeWidth={1} strokeDasharray={l.kind === 'stop' ? '2,4' : '6,4'} opacity={0.9} />
              ) : null,
            )}
            {/* trend çizgileri */}
            {lines.map(({ tl, from, to, v1, v2 }) =>
              to > from ? (
                <Line key={`t${tl.kind}`} x1={x(from)} x2={x(to)} y1={y(v1)} y2={y(v2)}
                  stroke={tl.kind === 'support' ? t.up : t.down} strokeWidth={1.6} opacity={0.9} />
              ) : null,
            )}
            {/* ortalamalar */}
            <Path d={linePath(bars, 'ema_slow', x, y)} stroke={t.emaSlow} strokeWidth={1.1} fill="none" opacity={0.75} />
            <Path d={linePath(bars, 'ema_mid', x, y)} stroke={t.emaMid} strokeWidth={1.1} fill="none" opacity={0.75} />
            <Path d={linePath(bars, 'ema_fast', x, y)} stroke={t.emaFast} strokeWidth={1.1} fill="none" opacity={0.75} />
            {/* fiyat: çizgi ya da mum */}
            {type === 'line' ? (
              <Path d={linePath(bars, 'close', x, y)} stroke={lineColor} strokeWidth={2} fill="none" />
            ) : (
              bars.map((b, i) => {
                const up = b.close >= b.open;
                const color = up ? t.up : t.down;
                const top = y(Math.max(b.open, b.close));
                const bot = y(Math.min(b.open, b.close));
                return (
                  <G key={`c${b.d}`}>
                    <Line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth={1} />
                    <Rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(bot - top, 1)} fill={color} />
                  </G>
                );
              })
            )}
            {labels.map((l) => (
              <SvgText key={`l${l.text}${l.y}`} x={plotW + 4} y={l.y + 4} fontSize={10}
                fontWeight={l.bold ? 'bold' : 'normal'} fill={l.color}>
                {l.text}
              </SvgText>
            ))}
            {hover != null ? (
              <Line x1={x(hover)} x2={x(hover)} y1={PAD_TOP} y2={HEIGHT} stroke={t.muted} strokeWidth={1} />
            ) : null}
          </Svg>
        ) : null}
      </View>
      <View style={styles.zoomRow}>
        <ZoomButton icon="remove" label="Uzaklaştır" onPress={() => setView(span * ZOOM_STEP, endOff)} disabled={span >= all.length} />
        <ZoomButton icon="add" label="Yakınlaştır" onPress={() => setView(span / ZOOM_STEP, endOff)} disabled={span <= MIN_SPAN} />
        <ZoomButton icon="chevron-back" label="Geriye kaydır" onPress={() => setView(span, endOff + span / 4)}
          disabled={offset <= 0} />
        <ZoomButton icon="chevron-forward" label="İleriye kaydır" onPress={() => setView(span, endOff - span / 4)}
          disabled={endOff <= 0} />
        <ZoomButton icon="refresh" label="Sıfırla" onPress={() => setView(initialSpan, 0)}
          disabled={span === initialSpan && endOff === 0} />
        <Text style={[styles.zoomInfo, { color: t.muted }]}>
          {bars.length} mum · {bars[0].d.slice(0, 7)} → {bars[bars.length - 1].d.slice(0, 7)}
        </Text>
      </View>
      <View style={styles.legend}>
        <LegendItem color={lineColor} label={type === 'line' ? 'Kapanış' : 'Mum'} />
        <LegendItem color={t.emaFast} label={emaLabels[0]} />
        <LegendItem color={t.emaMid} label={emaLabels[1]} />
        <LegendItem color={t.emaSlow} label={emaLabels[2]} />
        {levels.some((l) => l.kind === 'support' && l.value != null) ? <LegendItem color={t.up} label="Destek" dashed /> : null}
        {levels.some((l) => l.kind === 'resistance' && l.value != null) ? <LegendItem color={t.down} label="Direnç" dashed /> : null}
        {levels.some((l) => l.kind === 'stop' && l.value != null) ? <LegendItem color={t.muted} label="Stop" dashed /> : null}
        {lines.length ? <LegendItem color={t.text} label="Trend çizgisi" /> : null}
      </View>
    </View>
  );
}

function ZoomButton({ icon, label, onPress, disabled }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={6}
      style={[styles.zoomBtn, { borderColor: t.border, opacity: disabled ? 0.35 : 1 }]}>
      <Ionicons name={icon} size={16} color={t.text} />
    </Pressable>
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
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  zoomBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  zoomInfo: { fontSize: 11, marginLeft: 4, fontVariant: ['tabular-nums'] },
});
