from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# Fiyat indirme ayarları
HISTORY_PERIOD = "2y"     # İlk indirmede çekilecek geçmiş (haftalık analiz için yeterli)
UPDATE_PERIOD = "1mo"     # Sonraki güncellemelerde çekilecek son dönem
CHUNK_SIZE = 150          # yfinance'e tek seferde gönderilecek sembol sayısı
CHUNK_PAUSE_SEC = 1.0     # İstek limitine takılmamak için gruplar arası bekleme

# Likidite filtresi: 20 günlük ortalama işlem hacmi (yerel para birimi cinsinden)
MIN_AVG_TURNOVER = {"US": 1_000_000, "BIST": 10_000_000}  # 1M USD / 10M TL
MIN_PRICE = {"US": 1.0, "BIST": 1.0}
