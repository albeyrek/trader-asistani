// Yerel deneme: wrangler dev test/ai_preview.ts  ->  POST /?model=...  gövde: { c: Candidate, mk: AssistantMarket }
// (Sadece geliştirme içindir; yayınlanan Worker'da bu uç yok.)
import { generate, buildPrompt, MODEL_OPTIONS, type AssistantMarket, type Candidate } from '../src/assistant';

export default {
  async fetch(req: Request, env: { AI: Ai }): Promise<Response> {
    const url = new URL(req.url);
    const { c, mk } = (await req.json()) as { c: Candidate; mk: AssistantMarket };
    const model = url.searchParams.get('model') ?? undefined;
    const t = Date.now();
    try {
      const raw = (await env.AI.run(model as never, { messages: buildPrompt(c, mk), max_tokens: 1200, temperature: 0.4, ...MODEL_OPTIONS[model ?? ''] } as never)) as Record<string, unknown>;
      const text = await generate(env.AI, c, mk, model); // ikinci çağrı: generate() yolunu da dene
      return Response.json({ ms: Date.now() - t, text, raw: JSON.stringify(raw).slice(0, 1500), usage: (raw as { usage?: unknown }).usage });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
