import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Card, Segmented } from '@/components/ui';
import { fetchJson, useApi } from '@/lib/api';
import * as f from '@/lib/format';
import { useSettings } from '@/lib/settings';
import { useTheme } from '@/lib/theme';
import type { Market, Meta } from '@/lib/types';

type Status = { ok: boolean; text: string };

const okText = (m: Meta) =>
  `Bağlantı başarılı. Son veri: ${f.date(m.last_date)} (BIST ${m.counts.BIST}, ABD ${m.counts.US} hisse)`;

export default function SettingsScreen() {
  const t = useTheme();
  const { apiUrl, setApiUrl, mode, setMode } = useSettings();
  // null: kullanıcı henüz düzenlemedi, kayıtlı adres gösterilir
  const [draft, setDraft] = useState<string | null>(null);
  const [manual, setManual] = useState<{ status: Status; meta: Meta | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const saved = useApi<Meta>('/api/meta'); // kayıtlı adresle otomatik kontrol

  const value = draft ?? apiUrl;
  const meta = manual?.meta ?? saved.data;
  const status: Status | null =
    manual?.status ??
    (saved.data ? { ok: true, text: okText(saved.data) } : saved.error ? { ok: false, text: saved.error } : null);

  const test = async () => {
    setTesting(true);
    try {
      const m = await fetchJson<Meta>(value.trim().replace(/\/+$/, ''), '/api/meta');
      setManual({ status: { ok: true, text: okText(m) }, meta: m });
    } catch (e) {
      setManual({ status: { ok: false, text: e instanceof Error ? e.message : String(e) }, meta: null });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    setApiUrl(value);
    setDraft(null);
    setManual(null);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card title="Veri kaynağı">
        <Segmented
          options={[{ value: 'cloud', label: 'Bulut' }, { value: 'local', label: 'Yerel bilgisayar' }]}
          value={mode}
          onChange={(m) => { setMode(m); setManual(null); }}
        />
        {mode === 'cloud' ? (
          <Text style={[styles.text, { color: t.muted, marginTop: 10 }]}>
            Veriler her iş günü BIST kapanışından (≈18:45) ve ABD kapanışından (≈01:15) sonra bulutta otomatik
            güncellenir. Bilgisayarın açık olması gerekmez; her yerden çalışır.
          </Text>
        ) : null}
        {status ? <Text style={[styles.text, { color: status.ok ? t.up : t.down, marginTop: 8 }]}>{status.text}</Text> : null}
      </Card>

      {mode === 'local' ? (
      <Card title="Yerel sunucu adresi">
        <Text style={[styles.text, { color: t.muted }]}>
          Geliştirme ve test için: veriler bilgisayarında çalışan API’den alınır. Telefon ve bilgisayar aynı Wi-Fi
          ağında olmalı. Adres genelde http://BILGISAYAR_IP:8000 biçimindedir.
        </Text>
        <TextInput
          value={value}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]}
        />
        <View style={styles.buttons}>
          <Pressable
            onPress={save}
            style={[styles.button, { backgroundColor: t.accent }]}>
            <Text style={styles.buttonText}>Kaydet</Text>
          </Pressable>
          <Pressable
            onPress={test}
            disabled={testing}
            style={[styles.button, styles.buttonOutline, { borderColor: t.border }]}>
            <Text style={[styles.buttonText, { color: t.text }]}>{testing ? 'Deneniyor…' : 'Bağlantıyı dene'}</Text>
          </Pressable>
        </View>
      </Card>
      ) : null}

      <NotificationsCard />

      {meta ? (
        <Card title="Skorlar ne kadar güvenilir?">
          {(['BIST', 'US'] as Market[]).map((m) => (
            <Text key={m} style={[styles.text, { color: t.text, marginBottom: 6 }]}>
              <Text style={{ fontWeight: '700' }}>{f.marketLabel(m)}: {meta.reliability[m].level}. </Text>
              {meta.reliability[m].note}
            </Text>
          ))}
          <Text style={[styles.text, { color: t.muted }]}>
            Değerlendirme, Ağustos 2025 – Ekim 2026 arasındaki geçmiş testine dayanır. Haber skorunun geçmiş başarısı test edilemedi.
          </Text>
        </Card>
      ) : null}

      <Card title="Nasıl okunur?">
        <Text style={[styles.text, { color: t.text }]}>
          • Teknik skor −100 (güçlü düşüş) ile +100 (güçlü yükseliş) arasıdır; kısa vade günlük, orta vade haftalık grafikten hesaplanır.{'\n'}
          • Genel risk; oynaklık, haber riski, dip bölgesi, 1 yıllık düşüş ve devre kesici sayısını birleştirir.{'\n'}
          • Haber skoru KAP bildirimleri ve haber başlıklarının olumlu/olumsuz sınıflandırmasından gelir.{'\n'}
          • Veriler günde bir kez, piyasa kapanışından sonra güncellenir (gün sonu verisi).
        </Text>
      </Card>

      <Text style={[styles.disclaimer, { color: t.muted }]}>
        {meta?.disclaimer ?? 'Bu uygulama yatırım tavsiyesi vermez.'}
      </Text>
    </ScrollView>
  );
}

function NotificationsCard() {
  const t = useTheme();
  const {
    push, notifyAllSevere, setNotifyAllSevere, notifyPriceAlerts, setNotifyPriceAlerts, notifyAssistant,
    setNotifyAssistant, sync, resync, watchlist, mode,
  } = useSettings();

  let status: { text: string; color: string };
  if (!push) status = { text: 'Kontrol ediliyor…', color: t.muted };
  else if (push.state === 'ok')
    status = sync?.ok
      ? { text: `Açık · ${watchlist.length} hisse izleniyor`, color: t.up }
      : { text: `İzin verildi, sunucuya kayıt bekleniyor${sync?.error ? ` (${sync.error})` : ''}`, color: t.warn };
  else if (push.state === 'denied') status = { text: 'Bildirim izni verilmedi. Telefon ayarlarından izin verebilirsin.', color: t.down };
  else status = { text: push.reason, color: t.muted };

  return (
    <Card title="Bildirimler">
      <Text style={[styles.text, { color: status.color }]}>{status.text}</Text>
      <Text style={[styles.text, { color: t.muted, marginTop: 8 }]}>
        İzleme listendeki hisseler için yeni KAP bildirimleri ve önemli haberler gelir. Bildirime dokununca hissenin
        detayı açılır.{' '}
        {mode === 'cloud'
          ? 'Haber bekçisi bulutta 5 dakikada bir çalışır; bilgisayarın kapalı olması fark etmez.'
          : 'Yerel modda bildirimleri bilgisayardaki haber bekçisi gönderir; bilgisayar kapalıyken bildirim gelmez.'}
      </Text>
      <View style={[styles.switchRow, { borderTopColor: t.border }]}>
        <Text style={[styles.text, { color: t.text, flex: 1 }]}>
          İzleme listesi dışındaki hisselerde de ciddi risk haberlerini bildir (konkordato, SPK tedbiri, dava vb.)
        </Text>
        <Switch value={notifyAllSevere} onValueChange={setNotifyAllSevere} />
      </View>
      <View style={[styles.switchRow, { borderTopColor: t.border }]}>
        <Text style={[styles.text, { color: t.text, flex: 1 }]}>
          Gün içi fiyat alarmları: izleme listendeki hisse stop seviyesinin altına inerse, desteği/direnci kırarsa ya da
          günde %5’ten fazla hareket ederse bildir (piyasa saatlerinde 5 dakikada bir; BIST 15 dk gecikmeli)
        </Text>
        <Switch value={notifyPriceAlerts} onValueChange={setNotifyPriceAlerts} />
      </View>
      <View style={[styles.switchRow, { borderTopColor: t.border }]}>
        <Text style={[styles.text, { color: t.text, flex: 1 }]}>
          Asistan: günün alım adayları hazır olunca (BIST akşam, ABD sabah), piyasa açılınca adayların durumu ve bir
          adayın fiyatı plandaki stopun altına inerse bildir{mode === 'cloud' ? '' : ' (sadece bulut modunda)'}
        </Text>
        <Switch value={notifyAssistant} onValueChange={setNotifyAssistant} />
      </View>
      {push?.state === 'ok' && !sync?.ok ? (
        <Pressable onPress={resync} style={[styles.button, styles.buttonOutline, { borderColor: t.border, marginTop: 8 }]}>
          <Text style={[styles.buttonText, { color: t.text }]}>Tekrar kaydet</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  content: { padding: 16, paddingBottom: 40 },
  text: { fontSize: 13, lineHeight: 19 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginTop: 10 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 10 },
  button: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  buttonOutline: { backgroundColor: 'transparent', borderWidth: 1 },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  disclaimer: { fontSize: 11, textAlign: 'center', lineHeight: 16, marginTop: 4 },
});
