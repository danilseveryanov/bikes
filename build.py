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
}

blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
# the blob sits in a <script type="application/json"> — only "</script" can end it
blob = blob.replace("</", "<\\/")

html = (ROOT / "src" / "app.html").read_text("utf-8")
assert "__DATA__" in html, "template lost its __DATA__ placeholder"
out = html.replace("__DATA__", blob)
(ROOT / "index.html").write_text(out, "utf-8")

print(f"index.html  {len(out):,} bytes")
for k, v in payload.items():
    print(f"  {k:12} {len(v)}")
