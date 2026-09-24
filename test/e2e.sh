#!/usr/bin/env bash
# End-to-end failover test against a local mock OpenAI-compatible server.
# Verifies that a real `pi` run transparently fails over from a quota-exhausted
# account to the next account in priority order.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${MOCK_PORT:-8931}"
TMP="$(mktemp -d)"
cleanup() { kill "${SRV_PID:-0}" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

MOCK_PORT="$PORT" node test/mock-server.mjs >/dev/null &
SRV_PID=$!
sleep 0.5

PI_ARGS=(-e ./index.ts -ne -ns -np -nc -nt --no-session)

run_pi() {
  OPENAI_POOL_CONFIG="$TMP/config.json" OPENAI_POOL_STATE="$TMP/state.json" \
    pi "${PI_ARGS[@]}" --model openai-pool/mock-model -p "hi" 2>&1
}

echo "== scenario 1: failover from exhausted account to next =="
cat > "$TMP/config.json" <<EOF
{
  "accounts": [
    { "name": "dead",  "kind": "apiKey", "apiKey": "sk-dead",  "baseUrl": "http://127.0.0.1:$PORT/v1" },
    { "name": "alive", "kind": "apiKey", "apiKey": "sk-alive", "baseUrl": "http://127.0.0.1:$PORT/v1" }
  ],
  "models": { "custom": [ { "id": "mock-model", "name": "Mock", "api": "openai-completions" } ] }
}
EOF

OUT="$(run_pi)"
echo "$OUT" | grep -q "MOCK-OK:sk-alive" || { echo "FAIL: expected failover output"; echo "$OUT"; exit 1; }
grep -q '"status": "exhausted"' "$TMP/state.json" || { echo "FAIL: dead account not marked exhausted"; cat "$TMP/state.json"; exit 1; }
grep -q '"lastSelected": "alive"' "$TMP/state.json" || { echo "FAIL: lastSelected not recorded"; cat "$TMP/state.json"; exit 1; }
echo "ok: dead account skipped, alive account served the request"

echo "== scenario 2: all accounts exhausted -> clear error =="
rm -f "$TMP/state.json"
cat > "$TMP/config.json" <<EOF
{
  "accounts": [
    { "name": "dead", "kind": "apiKey", "apiKey": "sk-dead", "baseUrl": "http://127.0.0.1:$PORT/v1" }
  ],
  "models": { "custom": [ { "id": "mock-model", "name": "Mock", "api": "openai-completions" } ] }
}
EOF

OUT="$(run_pi)" || true
echo "$OUT" | grep -qi "openai-pool" || { echo "FAIL: expected openai-pool error"; echo "$OUT"; exit 1; }
echo "ok: aggregated exhaustion error surfaced"

echo "ALL E2E TESTS PASSED"
