"""Kural tabanlı haber duygu ve risk sınıflandırıcısı (Türkçe + İngilizce).

Her haber için: duygu (-1..+1), risk kategorileri, eşleşen ifadeler (şeffaflık için).
Arayüz (classify) sabittir; ileride yerel bir model ya da LLM ile değiştirilebilir.
"""
import re
from dataclasses import dataclass, field

# Risk kategorileri (uygulamada gösterilecek Türkçe adlar)
LEGAL = "Hukuki"
REGULATORY = "Düzenleyici"
FINANCIAL = "Finansal"
GOVERNANCE = "Yönetim"
DILUTION = "Sulandırma / Pay satışı"
OPERATIONAL = "Operasyonel"
VOLATILITY = "Volatilite"
MARKET = "Fiyat / Piyasa"
UNCERTAINTY = "Belirsizlik"

# (desen, ağırlık, kategori). Kategori yalnızca olumsuz eşleşmelerde risk olarak sayılır.
# Önce "olumlu istisna" desenleri gelir (örn. "tedbirin kaldırılması"); eşleşen metin parçası
# tekrar sayılmasın diye eşleşmeden sonra metinden çıkarılır.
TR_RULES: list[tuple[str, float, str | None]] = [
    # olumsuz kelime içeren olumlu / nötr ifadeler
    (r"(tedbir|yasa[kğ])\w*( karar\w*)?.{0,15}(kaldırıl|kalk)\w*", 0.5, None),
    (r"temerrüt (alış\w*|sırası|işlemi\w*)", 0.0, None),  # Takasbank takas işlemi, şirket temerrüdü değil
    (r"(dava|soruşturma)\w* (lehe|lehimize) sonuçlan\w*|dava\w* (redd|reddedil)\w*|tale[pb]\w* redd\w*", 0.5, None),
    (r"zarardan kâr\w*|zarardan kar\w*|kâra geçti|kara geçti", 0.6, None),
    # finansal
    (r"iflas|konkordato", -1.0, FINANCIAL),
    (r"temerrüt", -0.8, FINANCIAL),
    (r"haciz", -0.7, LEGAL),
    (r"net zarar|zarar açıkla\w*|zarara geçti|zararı (art|büyü)\w*", -0.6, FINANCIAL),
    (r"not\w* (indir|düşür)\w*|görünüm\w* negatif|negatif izleme", -0.6, FINANCIAL),
    (r"borç yapılandırma|kredi yapılandırma", -0.4, FINANCIAL),
    (r"beklenti\w* altında|kâr uyarısı|kar uyarısı", -0.5, FINANCIAL),
    # hukuki / düzenleyici
    (r"aleyhine dava|dava aç\w*|soruşturma|gözaltı|tutukla\w*|yolsuzluk|dolandırıcılık|kara para|manipülasyon",
     -0.7, LEGAL),
    (r"spk\w*.{0,40}(suç duyurusu|tedbir|yasak|ceza)|işlem yasağı|tedbir karar\w*", -0.8, REGULATORY),
    (r"idari para cezası|para cezası", -0.5, REGULATORY),
    (r"brüt takas|kredili işlem.{0,20}(kapsam|yasak)|tek fiyat", -0.5, REGULATORY),
    # sulandırma / pay satışı
    (r"bedelli sermaye artırım\w*|bedelli", -0.3, DILUTION),
    (r"tahsisli sermaye artırım\w*", -0.3, DILUTION),
    (r"pay satış\w*|hisse satış\w*|blok satış|pay\w* sattı|satış işlemi", -0.3, DILUTION),
    # yönetim
    (r"istifa|görevden alın\w*|görevden ayrıl\w*", -0.4, GOVERNANCE),
    # operasyonel
    (r"grev|yangın|patlama|sel olayı|deprem (hasar|nedeniyle)\w*|üretim\w* durdur\w*|faaliyet\w* durdur\w*"
     r"|tesis\w* kapat\w*",
     -0.6, OPERATIONAL),
    (r"siber saldırı|veri ihlali", -0.6, OPERATIONAL),
    # volatilite / belirsizlik
    (r"devre kesici", -0.15, VOLATILITY),
    (r"haber ve söylenti\w*", -0.1, UNCERTAINTY),
    (r"işlem iptali|işleme kapat\w*|işlemleri durdur\w*", -0.4, UNCERTAINTY),
    # piyasa yorumları (zayıf sinyal)
    (r"sert düş\w*|çakıl\w*|değer kaybı|taban\w* (oldu|yaptı|serisi)|eridi|geriledi", -0.35, MARKET),
    (r"hedef fiyat\w* (düşür|indir)\w*|sat tavsiye\w*|endeksten çıkar\w*", -0.5, MARKET),
    # olumlu
    (r"pay geri alım\w*|geri alım\w*|payların geri alınması", 0.4, None),
    (r"temettü|kâr payı|kar payı", 0.4, None),
    (r"bedelsiz", 0.4, None),
    (r"yeni iş ilişkisi|sözleşme imzala\w*|anlaşma imzala\w*|ihale\w* kazan\w*|sipariş al\w*|iş birliği", 0.5, None),
    (r"ihaleyi kazandı|ihale sonucu.{0,30}(kazan|uhde)", 0.5, None),
    (r"net kâr\w* (art|yüksel)\w*|net kar\w* (art|yüksel)\w*|rekor (kâr|kar|satış|ciro)|kârını artırdı", 0.5, None),
    (r"not\w* (yükselt|artır)\w*|görünüm\w* pozitif|pozitif izleme", 0.5, None),
    (r"hedef fiyat\w* (yükselt|artır)\w*|al tavsiye\w*|endekse (dahil|alın)\w*", 0.4, None),
    (r"(pay|hisse) alım\w*(?!\s*satım)", 0.3, None),  # "Pay Alım Satım Bildirimi" başlığı yönsüzdür
    (r"yatırım (kararı|yapacak)|kapasite artış\w*|yeni tesis|ihracat", 0.3, None),
    (r"yüksel\w*|rekor|zirve|tavan|değer kazan\w*|prim yap\w*", 0.25, None),
]

EN_RULES: list[tuple[str, float, str | None]] = [
    # Tüm desenler kelime sınırıyla: "investigational" (deneysel ilaç), "software-defined", "CrowdStrike" takılmasın
    (r"\b(lawsuit|probe|investigation)s? (dismissed|dropped|settled)\b", 0.3, None),
    # Hukuk bürolarının toplu "yatırımcı soruşturması" duyuruları: gürültülü, zayıf sinyal
    (r"\b(investors?|shareholders?)\b.{0,40}\b(investigation|class action|alert|deadline)\b|\blaw firm\b"
     r"|\b(pomerantz|rosen law|faruqi|bragar|levi & korsinsky|bronstein)\b", -0.2, LEGAL),
    (r"\b(bankrupt\w*|chapter 11|insolven\w*)\b", -1.0, FINANCIAL),
    (r"\b(defaults?|defaulted|going concern)\b", -0.8, FINANCIAL),
    (r"\bdelist\w*", -0.8, REGULATORY),
    (r"\b(misse[sd]|miss) (estimates|expectations|forecasts)\b"
     r"|\b(cuts?|lowers?|slashe[sd]|slash) (its |full-year |annual )?(guidance|outlook|forecast)\b"
     r"|\bprofit warning\b|\bwarns of (weak|lower|slow\w*|soft\w*)", -0.6, FINANCIAL),
    (r"\bdowngrade\w*|\bcut to (sell|underperform|neutral)\b|\b(lowers?|cuts?) (its )?price target\b", -0.5, MARKET),
    (r"\b(lawsuits?|sued|class action|subpoena\w*|indict\w*|investigation|probe)\b"
     r"|\b(securities|accounting|accused of) fraud\b|\bfraud (charges?|allegations?)\b", -0.6, LEGAL),
    (r"\bsec\b.{0,30}\b(charges?|fines?|settle\w*)\b|\bantitrust\b|\bpenalt(y|ies)\b|\bfined\b|\brecalls?\b",
     -0.6, REGULATORY),
    (r"\b(public|secondary|stock|share) offering\b|\bdilut\w*|\bshelf registration\b", -0.4, DILUTION),
    (r"\b(ceo|cfo|chief executive|chairman)\b.{0,20}\b(resign\w*|steps? down|depart\w*|ousted|fired)", -0.4,
     GOVERNANCE),
    (r"\b(layoffs?|job cuts|restructuring)\b", -0.3, OPERATIONAL),
    (r"\b(hacked|hack|data breach|breach|outage|cyberattack|strikes?)\b", -0.5, OPERATIONAL),
    (r"\bshort (seller|report)\b", -0.6, MARKET),
    (r"\b(plunge\w*|plummet\w*|tumble\w*|sinks?|slump\w*|crash\w*|sell-?off|tank(s|ed|ing)?)\b", -0.4, MARKET),
    (r"\b(falls?|drops?|slides?|declines?)\b", -0.25, MARKET),
    (r"\b(beats?|tops?|surpass\w*) (estimates|expectations|forecasts)\b", 0.6, None),
    (r"\b(raises?|boosts?|lifts?|hikes?) (its )?(guidance|outlook|forecast)\b", 0.6, None),
    (r"\bupgrade\w*|\b(raises?|lifts?|boosts?) (its )?price target\b", 0.5, None),
    (r"\b(buybacks?|repurchase\w*)\b", 0.4, None),
    (r"\b(raises?|hikes?|increases?) (its )?dividend\b|\bspecial dividend\b", 0.4, None),
    (r"\brecord (revenue|profit|sales|earnings|quarter)\b", 0.5, None),
    (r"\bfda (approv\w*|clear\w*)|\bwins? (contract|deal|approval)\b|\bawarded\b|\bpartnership\b", 0.4, None),
    (r"\b(soar\w*|surge\w*|jump\w*|rall(y|ies|ied)|skyrocket\w*)\b", 0.35, None),
    (r"\b(rises?|gains?|climbs?)\b", 0.2, None),
]

# Birden çok şirketi konu alan haberler ("4 hissede temerrüt", "3 cash-burning stocks"): tek hisseye özgü değil
MULTI_STOCK_TR = re.compile(r"\b\d+\s*(hisse|şirket|pay\b)|\bhisselerde\b|\bşirketler\b")
MULTI_STOCK_EN = re.compile(r"^\s*(\d+|two|three|four|five|six|seven|eight|nine|ten)\b.{0,40}\bstocks?\b"
                            r"|\bstocks to (buy|sell|watch|avoid)\b", re.IGNORECASE)
MULTI_STOCK_FACTOR = 0.4

# KAP konu başlıkları: içerikten bağımsız olarak sinyal taşıyanlar ve tamamen rutin olanlar
KAP_SUBJECT_RULES: list[tuple[str, float, str | None]] = [
    (r"devre kesici", -0.15, VOLATILITY),
    (r"aleyhine dava", -0.6, LEGAL),
    (r"tedbir kararı", -0.8, REGULATORY),
    (r"payların geri alınması", 0.4, None),
    (r"yeni iş ilişkisi", 0.5, None),
    (r"kar payı dağıtım", 0.3, None),
    (r"haber ve söylentiler", -0.1, UNCERTAINTY),
    (r"işlem iptali", -0.3, UNCERTAINTY),
]
KAP_ROUTINE = re.compile(
    r"sorumluluk beyanı|faaliyet raporu|genel bilgi formu|kurumsal yönetim|pay dışında sermaye piyasası|"
    r"piyasa yapıcılığı|likidite sağlayıcılık|takasbank|varant|sertifika|ihraç belgesi|ihraç tavanı|"
    r"finansal takvim|bağımsız denetim|yönetim kurulu komiteleri|sürdürülebilirlik|izahname|"
    r"borçlanma araçları|tertip ihraç|test bildirimi|portföy sınırlamaları|esas sözleşme",
    re.IGNORECASE,
)

_TR_COMPILED = [(re.compile(p), w, c) for p, w, c in TR_RULES]
_EN_COMPILED = [(re.compile(p, re.IGNORECASE), w, c) for p, w, c in EN_RULES]
_KAP_COMPILED = [(re.compile(p), w, c) for p, w, c in KAP_SUBJECT_RULES]


@dataclass
class Classification:
    sentiment: float                              # -1 (çok olumsuz) .. +1 (çok olumlu)
    categories: list[str] = field(default_factory=list)
    matches: list[str] = field(default_factory=list)
    routine: bool = False                         # rutin bildirim: skora katılmaz


def tr_lower(s: str) -> str:
    return s.replace("İ", "i").replace("I", "ı").lower()


def _apply(text: str, rules) -> tuple[float, list[str], list[str]]:
    total, cats, matches = 0.0, [], []
    for rx, w, cat in rules:
        m = rx.search(text)
        if not m:
            continue
        total += w
        matches.append(m.group(0))
        if cat and w < 0:
            cats.append(cat)
        # Aynı ifade başka bir kurala tekrar takılmasın
        text = text[:m.start()] + " " + text[m.end():]
    return total, cats, matches


def classify(title: str, summary: str = "", lang: str = "tr", kap_subject: str = "") -> Classification:
    subject = tr_lower(kap_subject)
    if subject and KAP_ROUTINE.search(subject):
        return Classification(0.0, routine=True)
    total, cats, matches = 0.0, [], []
    if subject:
        s_total, s_cats, s_matches = _apply(subject, _KAP_COMPILED)
        total, cats, matches = s_total, s_cats, s_matches
    if lang == "tr":
        t, c, m = _apply(tr_lower(f"{title} {summary}"), _TR_COMPILED)
        multi = bool(MULTI_STOCK_TR.search(tr_lower(title)))
    else:
        t, c, m = _apply(f"{title} {summary}", _EN_COMPILED)
        multi = bool(MULTI_STOCK_EN.search(title))
    if multi and not subject:
        t *= MULTI_STOCK_FACTOR
    # KAP konusu zaten sinyal verdiyse metindeki aynı anlamlı eşleşmeyi iki kez saymamak için metin yarı ağırlıkta
    total += t * (0.5 if matches else 1.0)
    cats += c
    matches += m
    return Classification(max(-1.0, min(1.0, total)), sorted(set(cats)), matches)
