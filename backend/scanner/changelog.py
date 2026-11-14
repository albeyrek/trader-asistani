"""Değişiklik günlüğü: asistanın davranışını etkileyen değişiklikler (performans değişince "neden?" sorusunun cevabı).

  - el ile yazılanlar: backend/changelog.json (kod değişiklikleri)
  - otomatik olanlar: haftalık öğrenme modelin sıralamayı devralıp bırakmasını ya da çıkış kuralını değiştirdiğinde
    (dışa aktarmada önceki durumla karşılaştırılır; data/changelog_auto.json)
"""
import json

from .config import DATA_DIR, ROOT

MANUAL_FILE = ROOT / "changelog.json"
AUTO_FILE = DATA_DIR / "changelog_auto.json"
STATE_FILE = DATA_DIR / "changelog_state.json"
KIND_NAMES = {"feature": "Yeni özellik", "rule": "Kural", "model": "Öğrenen model", "data": "Veri"}


def snapshot(model_meta: dict | None, exits_rep: dict | None) -> dict:
    return {
        "model_reliable": bool(model_meta.get("reliable")) if model_meta else None,
        "model_spec": model_meta.get("spec_text") if model_meta else None,
        "exit_rules": {m: {"name": s["name"], "desc": s["desc"], "avg_r": s.get("avg_r"), "base_avg_r": s.get("base_avg_r")}
                       for m, s in (exits_rep or {}).get("selected", {}).items()},
    }


def detect(prev: dict | None, cur: dict, day: str, model_meta: dict | None = None) -> list[dict]:
    """Önceki ve şimdiki durum arasındaki asistanı etkileyen farklar."""
    if not prev:
        return []
    out = []
    if prev.get("model_reliable") is not None and cur["model_reliable"] is not None \
            and prev["model_reliable"] != cur["model_reliable"]:
        decision = (model_meta or {}).get("last_decision") or ""
        out.append({"date": day, "kind": "model", "auto": True,
                    "title": "Öğrenen model sıralamayı devraldı" if cur["model_reliable"]
                    else "Sıralama yeniden kurallara geçti",
                    "detail": (decision[:1].upper() + decision[1:] + ".") if decision else
                    "Haftalık eğitimin ileriye dönük testine göre."})
    elif prev.get("model_spec") and cur["model_spec"] and prev["model_spec"] != cur["model_spec"]:
        out.append({"date": day, "kind": "model", "auto": True, "title": "Model türü değişti",
                    "detail": f"Haftalık eğitimde testte en iyi çıkan tür seçildi: {cur['model_spec']}."})
    for market, rule in cur["exit_rules"].items():
        old = (prev.get("exit_rules") or {}).get(market)
        if old and old["name"] != rule["name"]:
            name = "BIST" if market == "BIST" else "ABD"
            gain = (f" 10 yıllık testte işlem başına {rule['avg_r']:+.2f}R (sabit hedefli plan {rule['base_avg_r']:+.2f}R)."
                    if rule.get("avg_r") is not None and rule.get("base_avg_r") is not None else "")
            out.append({"date": day, "kind": "rule", "auto": True, "title": f"{name} çıkış kuralı değişti",
                        "detail": f"Önce: {old['desc']}. Şimdi: {rule['desc']}.{gain}"})
    return out


def update(model_meta: dict | None, exits_rep: dict | None, day: str) -> list[dict]:
    """Otomatik kayıtları günceller; el ile yazılanlarla birlikte yeniden eskiye tüm günlüğü döndürür."""
    cur = snapshot(model_meta, exits_rep)
    prev = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else None
    auto = json.loads(AUTO_FILE.read_text(encoding="utf-8")) if AUTO_FILE.exists() else []
    new = detect(prev, cur, day, model_meta)
    if new:
        auto += new
        AUTO_FILE.write_text(json.dumps(auto, ensure_ascii=False), encoding="utf-8")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(cur, ensure_ascii=False), encoding="utf-8")
    return entries()


def entries() -> list[dict]:
    """El ile yazılan ve otomatik kayıtlar, yeniden eskiye (aynı gün içinde sonra yazılan önce)."""
    manual = json.loads(MANUAL_FILE.read_text(encoding="utf-8")) if MANUAL_FILE.exists() else []
    auto = json.loads(AUTO_FILE.read_text(encoding="utf-8")) if AUTO_FILE.exists() else []
    out = [{**e, "kind_name": KIND_NAMES.get(e["kind"], e["kind"]), "auto": e.get("auto", False)} for e in manual + auto]
    return sorted(reversed(out), key=lambda e: e["date"], reverse=True)
