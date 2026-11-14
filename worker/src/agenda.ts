// Gündem: ülke ve dünya gündemi (para politikası, enflasyon, kur, siyaset, jeopolitik, emtia...) ve piyasaya etkisi.
//  - Google Haberler'de konu aramaları (15 dakikada bir, konuların yarısı sırayla) -> başlıklar
//  - kural tabanlı tema ve sektör etkisi (aşağıdaki PLAYBOOK; yapay zekâya bırakılmaz, uydurma riski olmasın)
//  - politik risk göstergesi: siyasi gerilim başlıklarının yoğunluğu + dolar/TL, BIST 100 ve banka endeksinin günlük hareketi
//  - yapay zekâ (Workers AI) birkaç saatte bir başlıkları temalara ayırıp özetler; sektör etkisini izinli listeden seçer
//  - takvim: TCMB PPK, Fed FOMC, TÜİK enflasyon (resmi takvimlerden; yılda bir güncellenir)
// Yatırım tavsiyesi değildir: sektör etkileri genel eğilimlerdir, her haber fiyatlara aynı yönde yansımaz.

import { AI_MODEL, MODEL_OPTIONS } from './assistant';
import { trLower } from './classify';
import type { Quote } from './quotes';
import { rss } from './sources';

// ------------------------------------------------------------------ sektörler

export type SectorId =
  | 'banka' | 'gyo' | 'holding' | 'sanayi' | 'ihracat' | 'havacilik' | 'turizm' | 'enerji' | 'petrol' | 'metal'
  | 'gida' | 'perakende' | 'iletisim' | 'savunma' | 'insaat' | 'sigorta' | 'otomotiv' | 'altin' | 'genel';

export const SECTORS: Record<SectorId, { name: string; index?: string }> = {
  banka: { name: 'Bankacılık', index: 'XBANK.IS' },
  gyo: { name: 'Gayrimenkul (GYO)', index: 'XGMYO.IS' },
  holding: { name: 'Holdingler', index: 'XHOLD.IS' },
  sanayi: { name: 'Sanayi', index: 'XUSIN.IS' },
  ihracat: { name: 'İhracatçı şirketler' },
  havacilik: { name: 'Havacılık ve ulaştırma', index: 'XULAS.IS' },
  turizm: { name: 'Turizm', index: 'XTRZM.IS' },
  enerji: { name: 'Elektrik ve enerji', index: 'XELKT.IS' },
  petrol: { name: 'Petrol ve rafineri', index: 'XKMYA.IS' },
  metal: { name: 'Metal ve demir-çelik', index: 'XMANA.IS' },
  gida: { name: 'Gıda', index: 'XGIDA.IS' },
  perakende: { name: 'Perakende ve ticaret', index: 'XTCRT.IS' },
  iletisim: { name: 'İletişim', index: 'XILTM.IS' },
  savunma: { name: 'Savunma' },
  insaat: { name: 'İnşaat ve çimento' },
  sigorta: { name: 'Sigorta' },
  otomotiv: { name: 'Otomotiv' },
  altin: { name: 'Altın ve madencilik' },
  genel: { name: 'Borsa geneli', index: 'XU100.IS' },
};

// ------------------------------------------------------------------ konular (haber aramaları)

export const TOPICS: { id: string; name: string; q: string }[] = [
  { id: 'faiz', name: 'Para politikası', q: 'Merkez Bankası faiz' },
  { id: 'enflasyon', name: 'Enflasyon', q: 'enflasyon TÜİK' },
  { id: 'kur', name: 'Kur', q: 'dolar TL kur' },
  { id: 'borsa', name: 'Borsa', q: 'Borsa İstanbul BIST 100' },
  { id: 'siyaset', name: 'Siyaset', q: 'Türkiye siyaset' },
  { id: 'gerilim', name: 'Siyasi gerilim', q: 'gözaltı OR tutuklama OR protesto OR "erken seçim"' },
  { id: 'kredi', name: 'Kredi notu', q: 'Türkiye kredi notu' },
  { id: 'maliye', name: 'Vergi ve maliye', q: 'vergi düzenlemesi OR "asgari ücret" OR bütçe açığı' },
  { id: 'petrol', name: 'Petrol ve emtia', q: 'petrol fiyatları Brent' },
  { id: 'fed', name: 'ABD ve Fed', q: 'Fed faiz kararı' },
  { id: 'jeopolitik', name: 'Jeopolitik', q: 'savaş OR saldırı OR ateşkes Orta Doğu OR Ukrayna' },
  { id: 'dis_ticaret', name: 'Dış ticaret', q: 'ihracat rakamları OR cari açık' },
  { id: 'altin', name: 'Altın', q: 'altın fiyatları ons' },
  { id: 'turizm', name: 'Turizm', q: 'turist sayısı OR turizm geliri' },
];

// ------------------------------------------------------------------ tema ve sektör etkisi kuralları

type Effect = { sector: SectorId; dir: 1 | -1 };
interface ThemeRule {
  id: string;
  name: string;
  match: RegExp; // başlık bu temaya ait mi (küçük harfe çevrilmiş başlıkta)
  exclude?: RegExp; // eşleşse bile bu temaya sayılmaz (ör. "ABD Merkez Bankası" TCMB değildir)
  variants: { when: RegExp; tone: 1 | -1; label: string; why: string; effects: Effect[] }[];
}

const E = (s: SectorId, dir: 1 | -1 = 1): Effect => ({ sector: s, dir });

/** Başka ülkelerin haberleri (Vietnam merkez bankası, İspanya'da erken seçim...) Türkiye gündemi sayılmaz. */
const FOREIGN = /(\bfed\b|\babd\b|amerikan|avrupa|\becb\b|japonya|ingiltere|vietnam|çin|hindistan|rusya|brezilya|meksika|kanada|avustralya|isviçre|kore|ispanya|fransa|almanya|italya|yunanistan|arjantin|güney afrika|endonezya|israil|iran)/;
/** Siyasi aktör ve kurumlar: siyasi gerilim başlığında bunlardan biri geçmeli. */
const POLITICAL = '(belediye başkan|milletvekili|parti|muhalefet|\\bchp\\b|\\bakp\\b|ak parti|\\bmhp\\b|dem parti|iyi parti|imamoğlu|özgür özel|kılıçdaroğlu|erdoğan|bakan|meclis|tbmm|gazeteci|siyasetçi|cumhurbaşkan|seçim)';

/** Gündem -> sektör etkisi el kitabı. Genel kabul gören eğilimler; her olayda geçerli olmayabilir. */
export const PLAYBOOK: ThemeRule[] = [
  {
    id: 'faiz', name: 'Faiz', match: /(merkez bankası|tcmb|ppk|politika faizi).*faiz|faiz.*(merkez bankası|tcmb|ppk)|politika faizi/,
    exclude: FOREIGN,
    variants: [
      { when: /(indir|indirim|gevşe)/, tone: 1, label: 'Faiz indirimi', why: 'Düşen faiz kredi maliyetini ve iskonto oranını düşürür',
        effects: [E('banka'), E('gyo'), E('holding'), E('perakende'), E('insaat'), E('genel')] },
      { when: /(artır|artış|yükselt|sıkılaş)/, tone: -1, label: 'Faiz artırımı', why: 'Yüksek faiz borçlanmayı ve değerlemeyi baskılar',
        effects: [E('gyo', -1), E('insaat', -1), E('perakende', -1), E('genel', -1)] },
      { when: /(sabit|değiştirmedi|aynı seviyede)/, tone: 1, label: 'Faiz sabit', why: 'Sürpriz yoksa piyasa etkisi sınırlıdır', effects: [] },
    ],
  },
  {
    id: 'enflasyon', name: 'Enflasyon', match: /(enflasyon|tüfe|üfe)/,
    variants: [
      { when: /(beklentinin altında|geriledi|düştü|yavaşladı)/, tone: 1, label: 'Enflasyon geriliyor',
        why: 'Düşen enflasyon faiz indirimi beklentisini güçlendirir', effects: [E('banka'), E('gyo'), E('genel')] },
      { when: /(beklentinin üzerinde|beklentinin üstünde|yükseldi|arttı|hızlandı)/, tone: -1, label: 'Enflasyon yükseliyor',
        why: 'Yüksek enflasyon sıkı para politikasını uzatır', effects: [E('banka', -1), E('gyo', -1), E('genel', -1)] },
    ],
  },
  {
    // "39 milyar dolar" gibi tutarlar kur haberi değildir: kur bağlamı aranır
    id: 'kur', name: 'Kur', match: /(dolar\/tl|euro\/tl|usd\/t|dolar kuru|döviz kuru|\bkur\b|türk lirası|tl'nin değer)/,
    variants: [
      { when: /(rekor|sert yüksel|değer kaybı|zirve|fırladı)/, tone: -1, label: 'TL değer kaybediyor',
        why: 'Döviz geliri olanlar kazanır, ithalata ve borca bağımlılar zorlanır',
        effects: [E('ihracat'), E('havacilik'), E('banka', -1), E('perakende', -1), E('genel', -1)] },
      { when: /(geriledi|düştü|değer kazan)/, tone: 1, label: 'TL güçleniyor', why: 'Kur baskısının azalması iç piyasaya olumlu',
        effects: [E('perakende'), E('banka')] },
    ],
  },
  {
    // Şirket notları (ör. "Anadolu Efes'in notu") ülke notu değildir: Türkiye geçmeli
    id: 'kredi', name: 'Kredi notu', match: /türkiye.*(kredi not|görünüm)|(kredi not|görünüm).*türkiye|ülke notu/,
    exclude: FOREIGN,
    variants: [
      { when: /(yükselt|artır|pozitif|olumlu)/, tone: 1, label: 'Kredi notu/görünüm iyileşmesi',
        why: 'Yabancı yatırımcı girişi ve düşen borçlanma maliyeti', effects: [E('banka'), E('genel')] },
      { when: /(düşür|indir|negatif|olumsuz)/, tone: -1, label: 'Kredi notu/görünüm kötüleşmesi',
        why: 'Yabancı çıkışı ve artan borçlanma maliyeti', effects: [E('banka', -1), E('genel', -1)] },
    ],
  },
  {
    // Sıradan adli operasyonlar ("dolandırıcılık: 12 gözaltı") sayılmasın: siyasi aktör ya da kurum da geçmeli
    id: 'gerilim', name: 'Siyasi gerilim',
    match: new RegExp(`(gözaltı|tutukla|protesto|erken seçim|kapatma davası|olağanüstü hal|istifa|darbe|kayyum|iddianame|soruşturma)`
      + `.*${POLITICAL}|${POLITICAL}.*(gözaltı|tutukla|protesto|erken seçim|kapatma davası|olağanüstü hal|istifa|darbe|kayyum|iddianame|soruşturma)`),
    exclude: FOREIGN,
    variants: [
      { when: /./, tone: -1, label: 'Siyasi gerilim', why: 'Siyasi belirsizlik yabancı çıkışına ve kur baskısına yol açabilir',
        effects: [E('banka', -1), E('genel', -1)] },
    ],
  },
  {
    id: 'jeopolitik', name: 'Jeopolitik', match: /(savaş|saldırı|füze|çatışma|işgal|ateşkes|barış görüşme)/,
    variants: [
      { when: /(ateşkes|barış)/, tone: 1, label: 'Gerilim azalıyor', why: 'Risk iştahı artar; turizm ve havacılık rahatlar',
        effects: [E('havacilik'), E('turizm'), E('genel')] },
      { when: /./, tone: -1, label: 'Jeopolitik gerilim', why: 'Savunma talebi artar; turizm, havacılık ve risk iştahı zayıflar',
        effects: [E('savunma'), E('petrol'), E('altin'), E('havacilik', -1), E('turizm', -1), E('genel', -1)] },
    ],
  },
  {
    id: 'petrol', name: 'Petrol', match: /(petrol|brent|ham petrol|opec)/,
    variants: [
      { when: /(yüksel|arttı|rekor|fırladı)/, tone: -1, label: 'Petrol yükseliyor',
        why: 'Rafineri marjları ve enerji şirketleri kazanır; yakıt maliyeti havacılığı ve cari açığı zorlar',
        effects: [E('petrol'), E('havacilik', -1)] },
      { when: /(düştü|geriledi|sert düşüş)/, tone: 1, label: 'Petrol düşüyor', why: 'Yakıt maliyeti ve cari açık rahatlar',
        effects: [E('havacilik'), E('petrol', -1), E('genel')] },
    ],
  },
  {
    id: 'fed', name: 'Fed', match: /(\bfed\b|fomc|powell|abd merkez bankası)/,
    variants: [
      { when: /(indir|gevşe)/, tone: 1, label: 'Fed gevşiyor', why: 'Gelişen piyasalara fon akışı artar', effects: [E('genel'), E('banka')] },
      { when: /(artır|şahin|sıkılaş)/, tone: -1, label: 'Fed sıkılaşıyor', why: 'Güçlü dolar gelişen piyasaları baskılar', effects: [E('genel', -1)] },
    ],
  },
  {
    id: 'maliye', name: 'Vergi ve maliye', match: /(vergi|ötv|kdv|asgari ücret|bütçe)/,
    variants: [
      { when: /(asgari ücret)/, tone: 1, label: 'Asgari ücret artışı', why: 'Tüketim harcamaları artar, işçilik maliyeti de yükselir',
        effects: [E('perakende'), E('gida')] },
      { when: /(ötv)/, tone: -1, label: 'ÖTV düzenlemesi', why: 'Otomotiv ve dayanıklı tüketim talebini etkiler', effects: [E('otomotiv', -1)] },
      { when: /(vergi artış|yeni vergi|zam)/, tone: -1, label: 'Vergi artışı', why: 'Şirket kârlarını ve tüketimi baskılayabilir', effects: [E('genel', -1)] },
    ],
  },
  {
    id: 'dis_ticaret', name: 'Dış ticaret', match: /(ihracat|cari açık|cari işlemler|dış ticaret)/,
    variants: [
      { when: /(cari açık.*(arttı|yükseldi|genişledi)|ihracat.*(düştü|geriledi)|açık verdi)/, tone: -1, label: 'Dış ticaret zayıf',
        why: 'Cari açık kuru ve dış finansmanı zorlar', effects: [E('ihracat', -1)] },
      { when: /(rekor|arttı|yükseldi|fazla verdi|daraldı|azaldı|geriledi|indi)/, tone: 1, label: 'Dış ticaret güçlü',
        why: 'İhracatçı sanayi şirketlerine olumlu', effects: [E('ihracat'), E('sanayi')] },
    ],
  },
  {
    id: 'altin', name: 'Altın', match: /(altın fiyat|altının|ons altın|gram altın|\bons\b|altın madeni)/,
    variants: [
      { when: /(rekor|yüksel|arttı)/, tone: 1, label: 'Altın yükseliyor', why: 'Altın madencileri kazanır', effects: [E('altin')] },
      { when: /(düştü|geriledi)/, tone: -1, label: 'Altın düşüyor', why: 'Altın madencileri baskılanır', effects: [E('altin', -1)] },
    ],
  },
  {
    id: 'turizm', name: 'Turizm', match: /(turist|turizm)/,
    variants: [
      { when: /(rekor|arttı|yükseldi)/, tone: 1, label: 'Turizm güçlü', why: 'Turizm ve havacılık gelirleri artar',
        effects: [E('turizm'), E('havacilik')] },
      { when: /(düştü|geriledi|iptal)/, tone: -1, label: 'Turizm zayıf', why: 'Turizm ve havacılık gelirleri azalır',
        effects: [E('turizm', -1), E('havacilik', -1)] },
    ],
  },
  {
    id: 'afet', name: 'Doğal afet', match: /(deprem|sel felaketi|orman yangını)/,
    variants: [
      { when: /./, tone: -1, label: 'Doğal afet', why: 'Yeniden yapım talebi çimento ve inşaatı artırır; sigortacılar hasar öder',
        effects: [E('insaat'), E('sigorta', -1)] },
    ],
  },
];

export interface AgendaItem {
  id: string;
  title: string;
  source: string;
  url: string;
  published: string | null;
  topic: string;
  themes: { theme: string; variant: string; tone: 1 | -1 }[];
}

/** Bir başlığın temaları (birden fazla olabilir). Her temada ilk eşleşen varyant seçilir (sıra önceliktir).
 *  Soru başlıkları ("altın düşüyor mu, yükseliyor mu?") yön bildirmez: sadece yönsüz temalar sayılır. */
export function classifyHeadline(title: string): AgendaItem['themes'] {
  const t = trLower(title);
  const question = t.includes('?');
  const out: AgendaItem['themes'] = [];
  for (const rule of PLAYBOOK) {
    if (!rule.match.test(t) || rule.exclude?.test(t)) continue;
    const v = rule.variants.find((x) => x.when.test(t) && (!question || x.when.source === '.'));
    if (v) out.push({ theme: rule.id, variant: v.label, tone: v.tone });
  }
  return out;
}

export interface ThemeSummary {
  theme: string;
  name: string;
  count: number;
  tone: number; // -1..1
  variants: { label: string; count: number; why: string }[];
  headlines: { title: string; url: string; source: string; published: string | null }[];
}

export interface SectorImpact {
  sector: SectorId;
  name: string;
  score: number; // pozitif: gündem olumlu
  reasons: string[];
}

/** Son 24 saatin başlıklarından tema özeti ve sektör etkisi. */
export function summarize(items: AgendaItem[], now = Date.now(), hours = 24): { themes: ThemeSummary[]; sectors: SectorImpact[] } {
  const recent = items.filter((it) => !it.published || now - Date.parse(it.published) <= hours * 3600_000);
  const themes = new Map<string, ThemeSummary>();
  const sectors = new Map<SectorId, { score: number; reasons: Map<string, number> }>();
  for (const it of recent) {
    for (const th of it.themes) {
      const rule = PLAYBOOK.find((r) => r.id === th.theme)!;
      const variant = rule.variants.find((v) => v.label === th.variant)!;
      const s = themes.get(th.theme) ?? { theme: th.theme, name: rule.name, count: 0, tone: 0, variants: [], headlines: [] };
      s.count++;
      s.tone += th.tone;
      const vs = s.variants.find((x) => x.label === th.variant);
      if (vs) vs.count++;
      else s.variants.push({ label: th.variant, count: 1, why: variant.why });
      if (s.headlines.length < 5) s.headlines.push({ title: it.title, url: it.url, source: it.source, published: it.published });
      themes.set(th.theme, s);
      for (const e of variant.effects) {
        const x = sectors.get(e.sector) ?? { score: 0, reasons: new Map() };
        x.score += e.dir;
        x.reasons.set(`${variant.label} (${e.dir > 0 ? '+' : '−'})`, (x.reasons.get(`${variant.label} (${e.dir > 0 ? '+' : '−'})`) ?? 0) + 1);
        sectors.set(e.sector, x);
      }
    }
  }
  const themeList = [...themes.values()]
    .map((s) => ({ ...s, tone: Math.round((s.tone / s.count) * 100) / 100, variants: s.variants.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  const sectorList = [...sectors.entries()]
    .map(([sector, x]) => ({
      sector, name: SECTORS[sector].name, score: x.score,
      reasons: [...x.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} ×${n}`),
    }))
    .filter((s) => s.score !== 0)
    .sort((a, b) => b.score - a.score);
  return { themes: themeList, sectors: sectorList };
}

// ------------------------------------------------------------------ politik risk

export interface RiskComponents {
  headlines6h: number; // son 6 saatteki siyasi gerilim başlığı
  baseline6h: number; // son 7 günde 6 saatlik ortalama
  usdtry: number | null; // günlük değişim %
  xu100: number | null;
  xbank: number | null;
}

export interface PoliticalRisk {
  score: number; // 0-100
  level: 'Düşük' | 'Orta' | 'Yüksek';
  components: RiskComponents;
  notes: string[];
}

/** Şeffaf, basit puan: haber yoğunluğu (en fazla 50) + piyasa tepkisi (en fazla 50). */
export function politicalRisk(c: RiskComponents): PoliticalRisk {
  const notes: string[] = [];
  const ratio = c.headlines6h / Math.max(c.baseline6h, 2);
  let news = Math.min(50, Math.max(0, (ratio - 1) * 15) + Math.max(0, c.headlines6h - 10) * 2);
  if (c.headlines6h >= 25) news = 50;
  if (news >= 15) notes.push(`Son 6 saatte ${c.headlines6h} siyasi gerilim başlığı (olağan: ~${Math.round(c.baseline6h)})`);
  let market = 0;
  if (c.usdtry != null && c.usdtry > 0.6) {
    market += Math.min(20, (c.usdtry - 0.6) * 15);
    notes.push(`Dolar/TL bugün %${c.usdtry.toFixed(1).replace('.', ',')} yükseldi`);
  }
  if (c.xu100 != null && c.xu100 < -2) {
    market += Math.min(15, (-c.xu100 - 2) * 5);
    notes.push(`BIST 100 bugün %${c.xu100.toFixed(1).replace('.', ',')}`);
  }
  if (c.xbank != null && c.xbank < -3) {
    market += Math.min(15, (-c.xbank - 3) * 4);
    notes.push(`Banka endeksi bugün %${c.xbank.toFixed(1).replace('.', ',')}`);
  }
  const score = Math.round(Math.min(100, news + market));
  return { score, level: score >= 50 ? 'Yüksek' : score >= 25 ? 'Orta' : 'Düşük', components: c, notes };
}

// ------------------------------------------------------------------ takvim (resmi kaynaklardan; yılda bir güncellenir)
// TCMB PPK: https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Main+Menu/Temel+Faaliyetler/Para+Politikasi/PPK/2026 (ve /2027)
// Fed FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (karar ikinci gün açıklanır)
// TÜİK TÜFE: her ayın 3'ünde 10:00 (hafta sonuna denk gelirse ilk iş günü) — tarih kurala göre hesaplanır

const PPK = ['2026-01-22', '2026-03-12', '2026-04-22', '2026-06-11', '2026-07-23', '2026-09-10', '2026-10-22', '2026-12-10',
  '2027-01-21', '2027-03-18', '2027-04-22', '2027-06-10'];
const FOMC = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];

export interface CalendarEvent {
  date: string;
  time: string; // İstanbul saati
  title: string;
  country: 'TR' | 'US';
  note: string;
}

function tuikDate(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 3));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Bugünden itibaren `days` gün içindeki önemli olaylar. */
export function calendar(today: string, days = 45): CalendarEvent[] {
  const end = new Date(Date.parse(today) + days * 86400_000).toISOString().slice(0, 10);
  const out: CalendarEvent[] = [];
  for (const d of PPK) out.push({ date: d, time: '14:00', title: 'TCMB faiz kararı (PPK)', country: 'TR', note: 'Bankalar, GYO ve kur için en önemli gün' });
  for (const d of FOMC) out.push({ date: d, time: '21:00', title: 'Fed faiz kararı (FOMC)', country: 'US', note: 'Küresel risk iştahını ve doları etkiler' });
  const t = new Date(Date.parse(today));
  for (let i = 0; i < 3; i++) {
    const y = t.getUTCFullYear() + Math.floor((t.getUTCMonth() + i) / 12);
    const m = (t.getUTCMonth() + i) % 12;
    out.push({ date: tuikDate(y, m), time: '10:00', title: 'TÜİK enflasyon (TÜFE)', country: 'TR', note: 'Tarih kurala göre (ayın 3’ü ya da ilk iş günü)' });
  }
  return out.filter((e) => e.date >= today && e.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

// ------------------------------------------------------------------ toplama

export function itemId(title: string): string {
  const norm = trLower(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let h = 2166136261; // FNV-1a
  for (const ch of norm) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return (h >>> 0).toString(36);
}

/** Bir konunun son 1 günlük başlıkları. */
export async function fetchTopic(topic: (typeof TOPICS)[number]): Promise<AgendaItem[]> {
  const q = encodeURIComponent(`${topic.q} when:1d`);
  const items = await rss(`https://news.google.com/rss/search?q=${q}&hl=tr&gl=TR&ceid=TR:tr`);
  return items.slice(0, 40).map((it) => {
    const i = it.title.lastIndexOf(' - ');
    const title = i > 0 ? it.title.slice(0, i) : it.title;
    return {
      id: itemId(title), title, source: i > 0 ? it.title.slice(i + 3) : '?', url: it.url, published: it.published,
      topic: topic.id, themes: classifyHeadline(title),
    };
  });
}

// ------------------------------------------------------------------ yapay zekâ özeti

export interface AiTheme {
  title: string;
  summary: string;
  tone: 'olumlu' | 'olumsuz' | 'karışık';
  sectors: { sector: SectorId; dir: 1 | -1; why: string }[];
}

const AI_SYSTEM = [
  'Sen Türkiye ve dünya piyasalarını izleyen temkinli bir ekonomistsin. Sana son 24 saatin haber başlıkları verilecek.',
  'Bunları en önemli en fazla 5 temaya ayır. Her tema için kısa bir başlık, 2 cümlelik Türkçe özet, piyasa için tonu',
  '(olumlu, olumsuz ya da karışık) ve etkilenebilecek sektörleri yaz. Sektörleri SADECE şu listeden seç: ' +
    Object.keys(SECTORS).join(', ') + '.',
  'Sadece başlıklarda geçen bilgileri kullan, olay ya da rakam uydurma. Yatırım tavsiyesi verme.',
  'Yanıtı SADECE şu JSON biçiminde ver, başka hiçbir şey yazma:',
  '{"temalar":[{"baslik":"...","ozet":"...","ton":"olumlu|olumsuz|karışık","sektorler":[{"sektor":"banka","yon":"+","neden":"..."}]}]}',
].join(' ');

export function aiPrompt(items: AgendaItem[]): { role: 'system' | 'user'; content: string }[] {
  const lines = items.slice(0, 60).map((it) => `- [${TOPICS.find((t) => t.id === it.topic)?.name ?? it.topic}] ${it.title} (${it.source})`);
  return [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: lines.join('\n') }];
}

/** Model çıktısını doğrular: geçersiz sektörler atılır, metinler kısaltılır; kullanılamazsa null. */
export function parseAiThemes(raw: string): AiTheme[] | null {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/<think>[\s\S]*?<\/think>/g, ''));
  if (!m) return null;
  let obj: { temalar?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(obj.temalar)) return null;
  const out: AiTheme[] = [];
  for (const t of obj.temalar.slice(0, 5)) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    const title = typeof x.baslik === 'string' ? x.baslik.trim().slice(0, 80) : '';
    const summary = typeof x.ozet === 'string' ? x.ozet.trim().slice(0, 400) : '';
    if (!title || summary.length < 20) continue;
    const tone = x.ton === 'olumlu' || x.ton === 'olumsuz' ? x.ton : 'karışık';
    const sectors = (Array.isArray(x.sektorler) ? x.sektorler : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .filter((s) => typeof s.sektor === 'string' && s.sektor in SECTORS)
      .slice(0, 5)
      .map((s) => ({
        sector: s.sektor as SectorId, dir: (s.yon === '-' || s.yon === '−' ? -1 : 1) as 1 | -1,
        why: typeof s.neden === 'string' ? s.neden.trim().slice(0, 140) : '',
      }));
    out.push({ title, summary, tone, sectors });
  }
  return out.length ? out : null;
}

type AiResult = { response?: unknown; choices?: { message?: { content?: unknown } }[] };

export async function aiSummary(ai: Ai, items: AgendaItem[]): Promise<AiTheme[] | null> {
  const res = (await ai.run(AI_MODEL as Parameters<Ai['run']>[0], {
    messages: aiPrompt(items), max_tokens: 1500, temperature: 0.2, ...MODEL_OPTIONS[AI_MODEL],
  } as never)) as AiResult;
  const raw = typeof res.response === 'string' ? res.response
    : res.response && typeof res.response === 'object' ? JSON.stringify(res.response)
      : res.choices?.[0]?.message?.content;
  return typeof raw === 'string' ? parseAiThemes(raw) : null;
}

// ------------------------------------------------------------------ bildirim metni

export function riskMessage(r: PoliticalRisk, top: AgendaItem | undefined): { title: string; body: string } {
  return {
    title: `⚠️ Politik risk yükseldi (${r.score}/100)`,
    body: [r.notes.slice(0, 2).join(' · '), top ? `“${top.title}”` : ''].filter(Boolean).join(' — ').slice(0, 178),
  };
}

export type QuoteMap = Record<string, Quote | undefined>;
