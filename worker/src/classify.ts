// Haber duygu/risk sınıflandırıcısı: backend/scanner/sentiment.py'deki classify() ile birebir aynı algoritma.
// Kurallar Python'dan watch_meta.json içinde gelir (tek kaynak); burada sadece derlenir ve uygulanır.

export type Rule = [pattern: string, weight: number, category: string | null];

export interface Rules {
  tr: Rule[];
  en: Rule[];
  kap_subject: Rule[];
  kap_routine: string;
  multi_tr: string;
  multi_en: string;
  multi_factor: number;
}

export interface Classification {
  sentiment: number;
  categories: string[];
  matches: string[];
  routine: boolean;
}

type Compiled = [RegExp, number, string | null];

const WORD = '[\\p{L}\\p{N}_]';
// Python'un Unicode \b'sinin karşılığı (JS'nin \b'si u bayrağıyla bile sadece ASCII harfleri tanır)
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/** Python düzenli ifadesini JS'ye çevirir: \w, \W ve \b Türkçe harfleri de kapsayacak şekilde. */
export function pyRegex(pattern: string, ignoreCase = false): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === 'w') out += WORD;
      else if (next === 'W') out += '[^\\p{L}\\p{N}_]';
      else if (next === 'b') out += BOUNDARY;
      else out += ch + next;
      i++;
    } else {
      out += ch;
    }
  }
  return new RegExp(out, ignoreCase ? 'iu' : 'u');
}

export function trLower(s: string): string {
  return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
}

export class Classifier {
  private tr: Compiled[];
  private en: Compiled[];
  private kap: Compiled[];
  private routine: RegExp;
  private multiTr: RegExp;
  private multiEn: RegExp;
  private multiFactor: number;

  constructor(rules: Rules) {
    const compile = (rs: Rule[], ignoreCase: boolean): Compiled[] =>
      rs.map(([p, w, c]) => [pyRegex(p, ignoreCase), w, c]);
    this.tr = compile(rules.tr, false);
    this.en = compile(rules.en, true);
    this.kap = compile(rules.kap_subject, false);
    this.routine = pyRegex(rules.kap_routine, true);
    this.multiTr = pyRegex(rules.multi_tr);
    this.multiEn = pyRegex(rules.multi_en, true);
    this.multiFactor = rules.multi_factor;
  }

  private apply(text: string, rules: Compiled[]): [number, string[], string[]] {
    let total = 0;
    const cats: string[] = [];
    const matches: string[] = [];
    for (const [rx, w, cat] of rules) {
      const m = rx.exec(text);
      if (!m) continue;
      total += w;
      matches.push(m[0]);
      if (cat && w < 0) cats.push(cat);
      // Aynı ifade başka bir kurala tekrar takılmasın
      text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    }
    return [total, cats, matches];
  }

  classify(title: string, lang: 'tr' | 'en', kapSubject = ''): Classification {
    const subject = trLower(kapSubject);
    if (subject && this.routine.test(subject)) {
      return { sentiment: 0, categories: [], matches: [], routine: true };
    }
    let total = 0;
    let cats: string[] = [];
    let matches: string[] = [];
    if (subject) [total, cats, matches] = this.apply(subject, this.kap);

    // Python: f"{title} {summary}" (summary bekçide boş)
    const text = `${title} `;
    const [t0, c, m] = lang === 'tr' ? this.apply(trLower(text), this.tr) : this.apply(text, this.en);
    const multi = lang === 'tr' ? this.multiTr.test(trLower(title)) : this.multiEn.test(title);
    const t = multi && !subject ? t0 * this.multiFactor : t0;
    total += t * (matches.length ? 0.5 : 1.0);
    cats = [...new Set([...cats, ...c])].sort();
    matches = [...matches, ...m];
    return { sentiment: Math.max(-1, Math.min(1, total)), categories: cats, matches, routine: false };
  }
}
