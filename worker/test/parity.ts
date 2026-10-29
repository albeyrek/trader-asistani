// JS sınıflandırıcısı ile Python'un sonuçlarını karşılaştırır. Örnekleri üretmek için:
//   backend> python -m scanner.parity_fixture
//   worker>  npm run parity
import { readFileSync } from 'node:fs';

import { Classifier, type Rules } from '../src/classify';

interface Case {
  title: string;
  market: 'BIST' | 'US';
  kap_subject: string;
  sentiment: number;
  categories: string[];
  routine: boolean;
}

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf-8')) as { rules: Rules; cases: Case[] };
const c = new Classifier(fixture.rules);

let fail = 0;
for (const k of fixture.cases) {
  const r = c.classify(k.title, k.market === 'BIST' ? 'tr' : 'en', k.kap_subject);
  const same =
    Math.abs(r.sentiment - k.sentiment) < 1e-6 &&
    r.routine === k.routine &&
    JSON.stringify(r.categories) === JSON.stringify(k.categories);
  if (!same) {
    fail++;
    if (fail <= 15) {
      console.log(`FARK [${k.market}] ${k.title.slice(0, 80)}`);
      console.log(`   python: ${k.sentiment} ${JSON.stringify(k.categories)} rutin=${k.routine}`);
      console.log(`   js:     ${r.sentiment} ${JSON.stringify(r.categories)} rutin=${r.routine} ${JSON.stringify(r.matches)}`);
    }
  }
}
console.log(`\n${fixture.cases.length - fail}/${fixture.cases.length} örnek aynı`);
process.exit(fail ? 1 : 0);
