import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type ScrollViewInstance,
} from 'react-native';

import { ask, loadHistory, saveHistory, type ChatMessage, type ChatSource } from '@/lib/chat';
import { usePortfolio } from '@/lib/portfolio';
import { useSettings } from '@/lib/settings';
import { useTheme, type Theme } from '@/lib/theme';
import type { Market } from '@/lib/types';

const GENERAL = [
  'Bugün ne alayım? Piyasa nasıl?',
  'Gündem borsayı nasıl etkiler?',
  'Portföyümdeki en riskli hisse hangisi?',
  'Sanal portföy nasıl gidiyor?',
  'ABD için ne yapmalıyım?',
];

/** Sohbet asistanı: sorular uygulamanın kendi verisiyle cevaplanır (hisse sayfasından açılırsa o hisse bağlamında). */
export default function ChatScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ symbol?: string; market?: string }>();
  const symbol = params.symbol;
  const market: Market | undefined = params.market === 'US' ? 'US' : params.market === 'BIST' ? 'BIST' : undefined;
  const { push } = useSettings();
  const { positions } = usePortfolio();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    loadHistory().then(setMsgs);
  }, []);

  const suggestions = symbol
    ? [`${symbol} alayım mı?`, `${symbol} için en önemli risk ne?`, `${symbol} haberleri ne diyor?`]
    : GENERAL;

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    const next: ChatMessage[] = [...msgs, { role: 'user', content: question, at: new Date().toISOString() }];
    setMsgs(next);
    setText('');
    setBusy(true);
    try {
      const res = await ask(next, {
        token: push?.state === 'ok' ? push.token : null, symbol, market,
        portfolio: positions.map((p) => ({ symbol: p.symbol, market: p.market, qty: p.qty, cost: p.cost })),
      });
      const done = [...next, { role: 'assistant' as const, content: res.answer, at: new Date().toISOString(), sources: res.sources }];
      setMsgs(done);
      saveHistory(done);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', content: e instanceof Error ? e.message : String(e), at: new Date().toISOString(), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setMsgs([]);
    saveHistory([]);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{
        title: symbol ? `Asistana sor · ${symbol}` : 'Asistana sor',
        headerRight: () => (msgs.length ? (
          <Pressable onPress={clear} accessibilityRole="button" accessibilityLabel="Sohbeti temizle" style={{ paddingHorizontal: 8 }}>
            <Ionicons name="trash-outline" size={20} color={t.muted} />
          </Pressable>
        ) : null),
      }} />
      <ScrollView ref={scroll} contentContainerStyle={styles.content}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {!msgs.length ? (
          <View style={[styles.intro, { backgroundColor: t.card, borderColor: t.border }]}>
            <Ionicons name="chatbubbles-outline" size={26} color={t.accent} />
            <Text style={[styles.introText, { color: t.text }]}>
              Hisseler, piyasa, gündem, portföyün ya da asistanın sonuçları hakkında sor. Cevaplar uygulamanın kendi verisinden
              (grafik, plan, haberler, gündem, testler) üretilir; yatırım tavsiyesi değildir.
            </Text>
          </View>
        ) : null}
        {msgs.map((m, i) => <Bubble key={`${m.at}-${i}`} m={m} t={t} />)}
        {busy ? (
          <View style={[styles.bubble, styles.left, { backgroundColor: t.card, borderColor: t.border, flexDirection: 'row', gap: 8 }]}>
            <ActivityIndicator size="small" color={t.accent} />
            <Text style={{ color: t.muted }}>Asistan verilere bakıyor…</Text>
          </View>
        ) : null}
        {!busy ? (
          <View style={styles.suggestions}>
            {suggestions.map((s) => (
              <Pressable key={s} onPress={() => send(s)} style={[styles.suggestion, { borderColor: t.accent }]} accessibilityRole="button">
                <Text style={{ color: t.accent, fontSize: 12, fontWeight: '600' }}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.inputRow, { backgroundColor: t.card, borderTopColor: t.border }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={symbol ? `${symbol} hakkında sor…` : 'Bir soru yaz…'}
          placeholderTextColor={t.muted}
          style={[styles.input, { color: t.text, borderColor: t.border }]}
          multiline
          maxLength={1000}
          onSubmitEditing={() => send(text)}
        />
        <Pressable onPress={() => send(text)} disabled={busy || !text.trim()} accessibilityRole="button" accessibilityLabel="Gönder"
          style={[styles.send, { backgroundColor: busy || !text.trim() ? t.neutralBg : t.accent }]}>
          <Ionicons name="send" size={18} color={busy || !text.trim() ? t.muted : '#FFFFFF'} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ m, t }: { m: ChatMessage; t: Theme }) {
  const mine = m.role === 'user';
  return (
    <View style={[styles.bubble, mine ? styles.right : styles.left,
      mine ? { backgroundColor: t.accent } : { backgroundColor: t.card, borderColor: m.error ? t.down : t.border }]}>
      {mine ? <Text style={{ color: '#FFFFFF', fontSize: 14, lineHeight: 20 }}>{m.content}</Text> : <Rich text={m.content} t={t} error={m.error} />}
      {m.sources?.length ? (
        <View style={styles.sources}>
          <Text style={[styles.tiny, { color: t.muted }]}>Kullanılan veriler:</Text>
          {m.sources.map((s) => (
            <Pressable key={`${s.kind}-${s.label}`} onPress={() => openSource(s)}
              style={[styles.source, { borderColor: t.border }]} accessibilityRole="button">
              <Text style={{ color: t.accent, fontSize: 11, fontWeight: '600' }}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function openSource(s: ChatSource) {
  if (s.kind === 'stock' && s.symbol) router.push({ pathname: '/stock/[symbol]', params: { symbol: s.symbol, market: s.market ?? 'BIST' } });
  else if (s.kind === 'agenda') router.push('/agenda');
  else if (s.kind === 'paper') router.push({ pathname: '/paper', params: { market: s.market ?? 'BIST' } });
  else if (s.kind === 'market') router.push('/market');
  else if (s.kind === 'portfolio') router.push('/portfolio');
  else router.push({ pathname: '/', params: { market: s.market ?? 'BIST' } });
}

/** Basit biçimlendirme: **kalın**, "* " / "- " madde işaretleri, boş satırla paragraflar. */
function Rich({ text, t, error }: { text: string; t: Theme; error?: boolean }) {
  const lines = text.split('\n');
  return (
    <View style={{ gap: 4 }}>
      {lines.map((line, i) => {
        const bullet = /^\s*[*-]\s+/.test(line);
        const body = line.replace(/^\s*[*-]\s+/, '');
        if (!body.trim()) return <View key={i} style={{ height: 4 }} />;
        const parts = body.split('**');
        return (
          <View key={i} style={{ flexDirection: 'row', paddingLeft: bullet ? 4 : 0 }}>
            {bullet ? <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>•  </Text> : null}
            <Text style={{ color: error ? t.down : t.text, fontSize: 14, lineHeight: 20, flex: 1 }}>
              {parts.map((p, j) => <Text key={j} style={j % 2 ? { fontWeight: '700' } : undefined}>{p}</Text>)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 24, gap: 10 },
  intro: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  introText: { flex: 1, fontSize: 13, lineHeight: 19 },
  bubble: { maxWidth: '88%', borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end', borderWidth: 0 },
  sources: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' },
  source: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  tiny: { fontSize: 11 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  suggestion: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, maxHeight: 120 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
