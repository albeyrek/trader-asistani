"""Bildirim alacak cihazlar: Expo push adresi, izleme listesi ve tercihler (data/devices.json)."""
import json
import os
import tempfile
import threading
from datetime import datetime, timezone

from .config import DATA_DIR

DEVICES_FILE = DATA_DIR / "devices.json"
_lock = threading.Lock()


def load_devices() -> dict[str, dict]:
    if not DEVICES_FILE.exists():
        return {}
    try:
        return json.loads(DEVICES_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save(devices: dict[str, dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Yarım yazılmış dosya kalmasın diye önce geçici dosyaya yazılır
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(devices, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DEVICES_FILE)


def upsert_device(token: str, watchlist: list[dict], notify_all_severe: bool, platform: str) -> None:
    with _lock:
        devices = load_devices()
        devices[token] = {
            "watchlist": [{"symbol": w["symbol"].upper(), "market": w["market"]} for w in watchlist],
            "notify_all_severe": notify_all_severe,
            "platform": platform,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        _save(devices)


def remove_devices(tokens: list[str]) -> None:
    """Expo 'DeviceNotRegistered' döndürdüğünde (uygulama silinmiş vb.) cihaz listeden çıkarılır."""
    if not tokens:
        return
    with _lock:
        devices = load_devices()
        for t in tokens:
            devices.pop(t, None)
        _save(devices)
