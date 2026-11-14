// Gündem kurallarının testi: npx tsx test/agenda.ts   (canlı başlık örneği için: npx tsx test/agenda.ts --live)
import {
  calendar, classifyHeadline, FALLBACK_FEEDS, fallbackItems, fetchFallback, fetchTopic, parseAiThemes, politicalRisk,
  summarize, topicName, TOPICS, type AgendaItem,
} from '../src/agenda';
import { parseRss } from '../src/sources';

let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'OK ' : 'XX '} ${name}${detail ? `: ${detail}` : ''}`);
}
const labels = (t: string) => classifyHeadline(t).map((x) => x.variant);

check('TCMB faiz indirimi', labels('Merkez Bankası politika faizini 250 baz puan indirdi').includes('Faiz indirimi'));
check('Fed haberi TCMB sayılmaz', !labels('ABD Merkez Bankası Fed faizi sabit bıraktı').includes('Faiz sabit'),
  JSON.stringify(labels('ABD Merkez Bankası Fed faizi sabit bıraktı')));
check('enflasyon beklentinin altında', labels('Ekim ayı enflasyonu beklentinin altında geldi').includes('Enflasyon geriliyor'));
check('dolar rekor', labels('Dolar/TL yeni rekor kırdı').includes('TL değer kaybediyor'));
check('"kurul" kur sayılmaz', !classifyHeadline('Rekabet Kurulu soruşturma başlattı').some((x) => x.theme === 'kur'));
check('siyasi gerilim', labels('Belediye başkanı gözaltına alındı').includes('Siyasi gerilim'));
check('cari açık arttı = zayıf', labels('Cari açık eylülde arttı').includes('Dış ticaret zayıf'));
check('ihracat rekor = güçlü', labels('İhracat ekimde rekor kırdı').includes('Dış ticaret güçlü'));
check('"altında" altın sayılmaz', !classifyHeadline('Büyüme beklentilerin altında kaldı').some((x) => x.theme === 'altin'));
check('ateşkes', labels('Gazze’de ateşkes ilan edildi').includes('Gerilim azalıyor'));
check('petrol yükseliş', labels('Brent petrol sert yükseldi').includes('Petrol yükseliyor'));
check('adli operasyon siyasi gerilim değil', !labels('7 ilde dolandırıcılık operasyonu: 12 gözaltı').includes('Siyasi gerilim'));
check('yabancı erken seçim sayılmaz', !labels('İspanya’da erken seçim: PP ankette önde').includes('Siyasi gerilim'));
check('muhalefet erken seçim çağrısı', labels('Kılıçdaroğlu’ndan erken seçim çağrısı').includes('Siyasi gerilim'));
check('Vietnam merkez bankası TCMB değil', !labels('Vietnam Merkez Bankası faiz indirimine gitti').includes('Faiz indirimi'));
check('enflasyon tahmini faiz artırımı değil', !labels('Merkez Bankası enflasyon tahminlerini yükseltti').includes('Faiz artırımı'));
check('"milyar dolar" kur değil', !classifyHeadline('Cari açık 39,2 milyar dolara geriledi').some((x) => x.theme === 'kur'));
check('cari açık geriledi = güçlü', labels('Cari açık 39,2 milyar dolara geriledi').includes('Dış ticaret güçlü'));
check('şirket notu ülke notu değil', !classifyHeadline('Anadolu Efes kredi notu görünümü negatif').some((x) => x.theme === 'kredi'));
check('Türkiye notu', labels('Moody’s Türkiye’nin kredi notunu yükseltti').includes('Kredi notu/görünüm iyileşmesi'));
check('soru başlığı belirsiz', !classifyHeadline('Altın fiyatları düşüyor mu, yükseliyor mu?').some((x) => x.theme === 'altin'));

// özet ve sektör etkisi
const now = Date.parse('2026-11-14T12:00:00Z');
const mk = (title: string, hoursAgo = 1): AgendaItem => ({
  id: title, title, source: 'x', url: 'u', published: new Date(now - hoursAgo * 3600_000).toISOString(), topic: 'faiz',
  themes: classifyHeadline(title),
});
const sum = summarize([mk('Merkez Bankası faizi indirdi'), mk('TCMB faiz indirimine gitti'), mk('Dolar/TL rekor kırdı'),
  mk('Eski haber: faiz indirildi', 30)], now);
check('tema sayımı (24 saat)', sum.themes[0].theme === 'faiz' && sum.themes[0].count === 2, JSON.stringify(sum.themes.map((t) => [t.theme, t.count])));
const bank = sum.sectors.find((s) => s.sector === 'banka');
check('banka etkisi: 2 olumlu - 1 olumsuz', bank?.score === 1, JSON.stringify(bank));

// politik risk
const calm = politicalRisk({ headlines6h: 3, baseline6h: 4, usdtry: 0.1, xu100: 0.5, xbank: 0.8 });
check('sakin gün düşük risk', calm.level === 'Düşük', `${calm.score}`);
const shock = politicalRisk({ headlines6h: 30, baseline6h: 4, usdtry: 3.5, xu100: -6, xbank: -9 });
check('şok gün yüksek risk', shock.level === 'Yüksek' && shock.notes.length >= 3, `${shock.score} ${shock.notes.join(' | ')}`);
const newsOnly = politicalRisk({ headlines6h: 14, baseline6h: 4, usdtry: null, xu100: null, xbank: null });
check('sadece haber yoğunluğu orta risk', newsOnly.level === 'Orta', `${newsOnly.score}`);

// takvim
const cal = calendar('2026-11-14', 45);
check('takvim: TCMB 10 Aralık', cal.some((e) => e.date === '2026-12-10' && e.country === 'TR'), cal.map((e) => `${e.date} ${e.title}`).join(', '));
check('takvim: TÜİK 3 Aralık (Perşembe)', cal.some((e) => e.date === '2026-12-03' && e.title.includes('TÜİK')));
check('takvim: Fed 9 Aralık', cal.some((e) => e.date === '2026-12-09'));

// yapay zekâ çıktısı doğrulama
const good = '```json\n{"temalar":[{"baslik":"Faiz indirimi","ozet":"TCMB faizi indirdi, piyasa olumlu karşıladı.","ton":"olumlu",' +
  '"sektorler":[{"sektor":"banka","yon":"+","neden":"kredi"},{"sektor":"uydurma","yon":"+","neden":"x"}]}]}\n```';
const parsed = parseAiThemes(good);
check('YZ çıktısı: geçersiz sektör atılır', parsed?.[0].sectors.length === 1 && parsed[0].sectors[0].sector === 'banka', JSON.stringify(parsed));
check('YZ çıktısı: bozuk JSON reddedilir', parseAiThemes('Bugün piyasalar karışık.') === null);

// RSS ayrıştırma (CDATA, öznitelikli <item>, HTML karakterleri) ve yedek akış başlıkları
const xml = `<rss><channel><title>Kanal</title>
<item><title><![CDATA[Merkez Bankası politika faizini 250 baz puan indirdi]]></title><link>https://x/1</link>
<pubDate>Sat, 14 Nov 2026 19:21:03 +0300</pubDate></item>
<item rdf:about="https://x/2"><title>Dolar/TL yeni rekor kırdı &amp; borsa düştü</title><link>https://x/2</link>
<pubDate>Sat, 14 Nov 2026 20:00:00 +0300</pubDate></item>
<item><title>Eski haber</title><link>https://x/3</link><pubDate>Mon, 09 Nov 2026 10:00:00 +0300</pubDate></item>
<item><title>Tarihsiz yerel haber</title><link>https://x/4</link></item>
</channel></rss>`;
const parsedRss = parseRss(xml);
check('RSS: 4 haber, CDATA ve &amp; çözülür', parsedRss.length === 4 && parsedRss[0].title.startsWith('Merkez Bankası')
  && parsedRss[1].title.includes('&'), JSON.stringify(parsedRss.map((x) => x.title)));
check('RSS: tarih ISO', parsedRss[0].published === '2026-11-14T16:21:03.000Z', String(parsedRss[0].published));
const fb = fallbackItems(FALLBACK_FEEDS[0], parsedRss, Date.parse('2026-11-14T22:00:00Z'));
check('yedek: 24 saatten eski haber atılır', fb.length === 3 && !fb.some((x) => x.title === 'Eski haber'), fb.map((x) => x.title).join(' | '));
check('yedek: konu temadan', fb[0].topic === 'faiz' && fb[1].topic === 'kur', fb.map((x) => x.topic).join(','));
check('yedek: temasız haber akışın türünde', fb[2].topic === 'ekonomi' && topicName('ekonomi') === 'Ekonomi');
check('yedek: işaretli ve kaynak adı', fb.every((x) => x.fallback && x.source === 'Bloomberg HT'));
check('yedek akışlar farklı yayıncılardan', new Set(FALLBACK_FEEDS.map((f) => f.source)).size >= 5);

if (process.argv.includes('--live')) {
  for (const feed of FALLBACK_FEEDS) {
    try {
      const items = await fetchFallback(feed);
      console.log(`\n== yedek ${feed.source} (${feed.name}): ${items.length} başlık, ${items.filter((i) => i.themes.length).length} etiketli`);
      for (const it of items.slice(0, 3)) console.log(`   [${topicName(it.topic)}] ${it.title}`);
    } catch (e) {
      console.log(`== yedek ${feed.source}: HATA ${e}`);
    }
  }
  for (const topic of TOPICS) {
    try {
      const items = await fetchTopic(topic);
      const tagged = items.filter((i) => i.themes.length);
      console.log(`\n== ${topic.name}: ${items.length} başlık, ${tagged.length} etiketli`);
      for (const it of items.slice(0, 6)) console.log(`   ${it.themes.map((t) => t.variant).join(', ') || '—'} | ${it.title}`);
    } catch (e) {
      console.log(`== ${topic.name}: HATA ${e}`);
    }
  }
}

console.log(fail ? `\n${fail} test başarısız` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
