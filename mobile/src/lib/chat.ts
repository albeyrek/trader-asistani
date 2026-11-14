// Sohbet asistanı: sorular bulut bekçisindeki /api/chat'e gider; cevap uygulamanın verisiyle (grafik, plan, haber,
// gündem, sanal portföy...) üretilir. Konuşma geçmişi telefonda saklanır.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { WORKER_URL } from './cloud';
import type { Market } from './types';

const HISTORY_KEY = 'chatHistory';
const KEEP = 40;
const TIMEOUT_MS = 60_000;

export interface ChatSource {
  kind: 'stock' | 'agenda' | 'market' | 'assistant' | 'paper' | 'model' | 'portfolio' | 'strategy';
  label: string;
  symbol?: string;
  market?: Market;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  sources?: ChatSource[];
  error?: boolean;
}

export async function loadHistory(): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(msgs: ChatMessage[]): void {
  AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-KEEP))).catch(() => {});
}

export async function ask(
  history: ChatMessage[],
  ctx: {
    token: string | null;
    symbol?: string;
    market?: Market;
    portfolio: { symbol: string; market: Market; qty: number; cost: number }[];
  },
): Promise<{ answer: string; sources: ChatSource[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: history.filter((m) => !m.error).slice(-10).map((m) => ({ role: m.role, content: m.content })),
        token: ctx.token ?? undefined, symbol: ctx.symbol, market: ctx.market, portfolio: ctx.portfolio,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { answer?: string; sources?: ChatSource[]; detail?: string };
    if (!res.ok || !body.answer) throw new Error(body.detail ?? `Cevap alınamadı (HTTP ${res.status})`);
    return { answer: body.answer, sources: body.sources ?? [] };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('Asistan zamanında cevap veremedi; tekrar deneyin.');
    if (e instanceof TypeError) throw new Error('Asistana ulaşılamadı. İnternet bağlantını kontrol et.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
