#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML="$ROOT/docs/unico-poll-kullanim-kilavuzu.html"
PDF="$ROOT/docs/unico-poll-kullanim-kilavuzu.pdf"

if [[ ! -f "$HTML" ]]; then
  echo "HTML not found: $HTML" >&2
  exit 1
fi

CHROME=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME="$candidate"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "Chrome/Chromium not found. Open $HTML in a browser and Print to PDF." >&2
  exit 1
fi

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --run-all-compositor-stages-before-draw \
  --virtual-time-budget=2000 \
  --print-to-pdf="$PDF" \
  "file://$HTML" \
  >/dev/null 2>&1 || true

if [[ ! -s "$PDF" ]]; then
  echo "PDF generation failed." >&2
  exit 1
fi

echo "PDF written: $PDF"
