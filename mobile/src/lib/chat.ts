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
  /** Rakam doğrulama: cevaptaki sayılar uygulamanın verisinde bulundu mu (checked: kontrol edilen sayı adedi) */
  verified?: boolean;
  checked?: number;
  unverified?: string[];
  /** Cevabın sorusu (geri bildirimde gönderilir) ve kullanıcının değerlendirmesi */
  question?: string;
  rating?: 1 | -1;
}

export interface ChatAnswer {
  answer: string;
  sources: ChatSource[];
  verified?: boolean;
  checked?: number;
  unverified?: string[];
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
): Promise<ChatAnswer> {
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
    const body = (await res.json().catch(() => ({}))) as Partial<ChatAnswer> & { detail?: string };
    if (!res.ok || !body.answer) throw new Error(body.detail ?? `Cevap alınamadı (HTTP ${res.status})`);
    return { answer: body.answer, sources: body.sources ?? [], verified: body.verified, checked: body.checked,
      unverified: body.unverified ?? [] };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('Asistan zamanında cevap veremedi; tekrar deneyin.');
    if (e instanceof TypeError) throw new Error('Asistana ulaşılamadı. İnternet bağlantını kontrol et.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Cevaba 👍/👎 (bulutta son 200 değerlendirme tutulur; asistanın zayıf olduğu soru türlerini görmek için). */
export async function sendFeedback(m: ChatMessage, rating: 1 | -1, token: string | null): Promise<void> {
  const res = await fetch(`${WORKER_URL}/api/chat/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, question: m.question ?? '', answer: m.content, unverified: m.unverified ?? [], token: token ?? undefined }),
  });
  if (!res.ok) throw new Error(`Değerlendirme gönderilemedi (HTTP ${res.status})`);
}
