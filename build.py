#!/usr/bin/env python3
"""Inline data/*.json into src/app.html -> index.html.

Data is inlined rather than fetched: one file, no request, works offline the
moment the page is cached, and no CORS/CSP surface at all.

Run: python3 build.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / "data"

payload = {
    "bikes":       json.loads((DATA / "bikes.json").read_text("utf-8")),
    "maintenance": json.loads((DATA / "maintenance.json").read_text("utf-8")),
    "frames":      json.loads((DATA / "frames.json").read_text("utf-8")),
    "checklists":  json.loads((DATA / "checklists.json").read_text("utf-8")),
    "log":         json.loads((DATA / "log.json").read_text("utf-8")),
    "choice":      json.loads((DATA / "choice2627.json").read_text("utf-8")),
}

blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
# the blob sits in a <script type="application/json"> — only "</script" can end it
blob = blob.replace("</", "<\\/")

html = (ROOT / "src" / "app.html").read_text("utf-8")
assert "__DATA__" in html, "template lost its __DATA__ placeholder"
out = html.replace("__DATA__", blob)

# GitHub Pages не позволяет ставить заголовки, поэтому политика безопасности
# едет в самой странице. Исполняемый скрипт разрешён по хешу, а не через
# unsafe-inline: подсунутый через данные <script> выполнить не удастся.
import base64, hashlib, re
m = re.search(r'<script>(.*?)</script>', out, re.S)
assert m, "не нашёл исполняемый скрипт для подсчёта хеша"
digest = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()
csp = (
    "default-src 'none'; "
    f"script-src 'sha256-{digest}'; "
    "style-src 'unsafe-inline'; "          # разметка построена на style=""
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src https://bikes-sync.severyanov.workers.dev; "
    "base-uri 'none'; form-action 'none'"
)
out = out.replace("__CSP__", f'<meta http-equiv="Content-Security-Policy" content="{csp}">')
assert "__CSP__" not in out
(ROOT / "index.html").write_text(out, "utf-8")
print(f"CSP: скрипт разрешён по хешу sha256-{digest[:16]}…")

print(f"index.html  {len(out):,} bytes")
for k, v in payload.items():
    print(f"  {k:12} {len(v)}")
