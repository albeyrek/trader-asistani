// Yerel deneme: wrangler dev test/chat_preview.ts  ->  POST /?model=...  gövde: { q: "soru", symbol?, market? }
// Gerçek veriyle bağlam kurar, seçilen modelle cevaplar, süreyi ve rakam doğrulamasını döndürür (yayınlanmaz).
import { answer, buildContext, planQuery, referenceNumbers, verifyNumbers, type ChatMessage, type ChatRequest } from '../src/chat';

const DATA_URL = 'https://albeyrek.github.io/trader-asistani/data';

export default {
  async fetch(req: Request, env: { AI: Ai }): Promise<Response> {
    const model = new URL(req.url).searchParams.get('model') ?? undefined;
    const usePlan = new URL(req.url).searchParams.get('plan') !== '0';
    const { q, history, symbol, market } = (await req.json()) as { q: string; history?: ChatMessage[]; symbol?: string; market?: 'BIST' | 'US' };
    const request: ChatRequest = { messages: [...(history ?? []), { role: 'user', content: q }], symbol, market };
    const t = Date.now();
    const plan = usePlan ? await planQuery(env.AI, request).catch(() => null) : null;
    const planMs = Date.now() - t;
    const { context, sources } = await buildContext(request, DATA_URL, null, plan);
    try {
      const text = await answer(env.AI, request, context, undefined, model);
      const check = text ? verifyNumbers(text, referenceNumbers(context, q)) : null;
      return Response.json({ ms: Date.now() - t, planMs, plan, sources: sources.map((s) => s.label), text, check });
    } catch (e) {
      return Response.json({ ms: Date.now() - t, error: String(e) }, { status: 500 });
    }
  },
};
