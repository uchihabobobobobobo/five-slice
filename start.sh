#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-4175}"
echo "FIVE / SLICE — http://localhost:${PORT}"
exec node server.js
