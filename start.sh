#!/usr/bin/env sh
# MarkLite 一键启动（macOS / Linux）
cd "$(dirname "$0")"
PORT="${1:-8899}"
URL="http://localhost:$PORT"
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) &
echo "MarkLite: $URL"
node server.js "$PORT"
