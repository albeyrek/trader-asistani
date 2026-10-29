"""Ücretsiz haber kaynakları: KAP bildirimleri (tüm BIST), Google Haberler RSS (BIST), Yahoo Finance RSS (ABD).

Her kaynak aynı biçimde kayıt döndürür:
    symbol, market, source, published (UTC), title, summary, url, kap_subject
"""
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import requests

from .config import HTTP_HEADERS

KAP_URL = "https://www.kap.org.tr/tr/api/disclosure/members/byCriteria"
KAP_LINK = "https://www.kap.org.tr/tr/Bildirim/{}"
KAP_MAX_ROWS = 2000  # KAP tek sorguda en fazla bu kadar kayıt döndürüyor
GOOGLE_NEWS_URL = "https://news.google.com/rss/search?q={q}&hl=tr&gl=TR&ceid=TR:tr"
YAHOO_RSS_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={s}&region=US&lang=en-US"
IST = timezone(timedelta(hours=3))
REQUEST_PAUSE_SEC = 0.6

# Devre kesici bildirimlerinde hisse kodu özet metninde geçer: "YGGYO.E işlem sırasında ..."
CIRCUIT_BREAKER_CODE = re.compile(r"^([A-Z0-9]{3,6})\.E\b")


def _get(url: str, **kw) -> requests.Response:
    r = requests.get(url, headers=HTTP_HEADERS, timeout=30, **kw)
    r.raise_for_status()
    return r


# ------------------------------------------------------------------ KAP

def _kap_query(day_from: date, day_to: date) -> list[dict]:
    body = {"fromDate": day_from.isoformat(), "toDate": day_to.isoformat()}
    r = requests.post(KAP_URL, json=body, headers=HTTP_HEADERS, timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_kap(days: int = 30, today: date | None = None) -> list[dict]:
    """Son `days` günün tüm KAP bildirimleri. Limit nedeniyle gün gün sorgulanır."""
    today = today or date.today()
    items = []
    for i in range(days):
        day = today - timedelta(days=i)
        rows = _kap_query(day, day)
        if len(rows) >= KAP_MAX_ROWS:
            print(f"  ! KAP {day}: {KAP_MAX_ROWS} kayıt sınırına ulaşıldı, bazı bildirimler eksik olabilir")
        for x in rows:
            items.extend(_kap_to_items(x))
        time.sleep(REQUEST_PAUSE_SEC)
    return items


def _kap_to_items(x: dict) -> list[dict]:
    summary = (x.get("summary") or "").strip()
    codes = x.get("stockCodes")
    if codes:
        symbols = [c.strip() for c in codes.split(",") if c.strip()]
    else:
        m = CIRCUIT_BREAKER_CODE.match(summary)
        if not m:
            return []  # Şirkete özgü olmayan bildirim (Takasbank, Borsa duyuruları vb.)
        symbols = [m.group(1)]
    published = datetime.strptime(x["publishDate"], "%d.%m.%Y %H:%M:%S").replace(tzinfo=IST)
    subject = (x.get("subject") or "").strip()
    return [{
        "symbol": s,
        "market": "BIST",
        "source": "KAP",
        "published": published.astimezone(timezone.utc),
        "title": summary or subject,
        "summary": x.get("kapTitle") or "",
        "url": KAP_LINK.format(x["disclosureIndex"]),
        "kap_subject": subject,
    } for s in symbols]


# ------------------------------------------------------------------ RSS

def _parse_rss(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for item in root.iter("item"):
        pub = item.findtext("pubDate")
        try:
            published = parsedate_to_datetime(pub).astimezone(timezone.utc) if pub else None
        except (TypeError, ValueError):
            published = None
        out.append({
            "title": (item.findtext("title") or "").strip(),
            "summary": re.sub(r"<[^>]+>", " ", item.findtext("description") or "").strip(),
            "url": (item.findtext("link") or "").strip(),
            "published": published,
        })
    return out


def fetch_google_news_tr(symbol: str, days: int = 30) -> list[dict]:
    """BIST hissesi için Türkçe haber başlıkları. Sorgu: "KOD" hisse (son N gün)."""
    q = quote(f'"{symbol}" hisse when:{days}d')
    items = _parse_rss(_get(GOOGLE_NEWS_URL.format(q=q)).text)
    out = []
    for it in items:
        # Google başlıkları "Başlık - Kaynak" biçimindedir; kaynak adını ayır
        title, _, publisher = it["title"].rpartition(" - ")
        out.append({
            "symbol": symbol, "market": "BIST", "source": f"Google Haberler ({publisher or '?'})",
            "published": it["published"], "title": title or it["title"], "summary": "",
            "url": it["url"], "kap_subject": "",
        })
    return out


def fetch_yahoo_news(symbol: str, yf_symbol: str) -> list[dict]:
    items = _parse_rss(_get(YAHOO_RSS_URL.format(s=quote(yf_symbol))).text)
    return [{
        "symbol": symbol, "market": "US", "source": "Yahoo Finance",
        "published": it["published"], "title": it["title"], "summary": it["summary"][:500],
        "url": it["url"], "kap_subject": "",
    } for it in items]
