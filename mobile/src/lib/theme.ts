import { useColorScheme } from 'react-native';

import type { Level } from './types';

const light = {
  bg: '#F4F5F7',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  up: '#15803D',
  upBg: '#DCFCE7',
  down: '#B91C1C',
  downBg: '#FEE2E2',
  warn: '#B45309',
  warnBg: '#FEF3C7',
  neutralBg: '#F3F4F6',
  accent: '#2563EB',
  emaFast: '#2563EB',
  emaMid: '#D97706',
  emaSlow: '#7C3AED',
};

const dark: typeof light = {
  bg: '#0B0F17',
  card: '#151B26',
  text: '#F3F4F6',
  muted: '#9CA3AF',
  border: '#273142',
  up: '#4ADE80',
  upBg: '#14321F',
  down: '#F87171',
  downBg: '#3B1717',
  warn: '#FBBF24',
  warnBg: '#3A2A0B',
  neutralBg: '#1F2633',
  accent: '#60A5FA',
  emaFast: '#60A5FA',
  emaMid: '#FBBF24',
  emaSlow: '#A78BFA',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Skor yönüne göre renk: yükseliş yeşil, düşüş kırmızı, nötr gri. */
export function scoreColors(t: Theme, score: number | null | undefined): { fg: string; bg: string } {
  if (score == null) return { fg: t.muted, bg: t.neutralBg };
  if (score >= 15) return { fg: t.up, bg: t.upBg };
  if (score <= -15) return { fg: t.down, bg: t.downBg };
  return { fg: t.muted, bg: t.neutralBg };
}

/** Piyasa rejimi rengi: puan -5 (ayı) .. +5 (boğa) */
export function regimeColors(t: Theme, score: number): { fg: string; bg: string } {
  if (score >= 1) return { fg: t.up, bg: t.upBg };
  if (score <= -3) return { fg: t.down, bg: t.downBg };
  if (score <= -1) return { fg: t.warn, bg: t.warnBg };
  return { fg: t.muted, bg: t.neutralBg };
}

export function levelColors(t: Theme, level: Level | null | undefined): { fg: string; bg: string } {
  if (level === 'Yüksek') return { fg: t.down, bg: t.downBg };
  if (level === 'Orta') return { fg: t.warn, bg: t.warnBg };
  return { fg: t.up, bg: t.upBg };
}
