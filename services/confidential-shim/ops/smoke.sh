#!/usr/bin/env bash
#
# End-to-end smoke test through the PUBLIC endpoint: healthz, then a real
# base64 image submitted to /v1/inference, polled until terminal, verdict
# printed. Run this the morning of the demo before flipping the app's env.
#
# Usage:
#   SHIM_BASE_URL=https://34-10-20-30.sslip.io SHIM_API_KEY=... ./smoke.sh
#   IMAGE_PATH=~/flu-shot-card.png ./smoke.sh    (optional real document)
#
# With no IMAGE_PATH a built-in 1x1 PNG is submitted; the expected verdict is
# verified=false (the judge fails closed on an unreadable image), which still
# proves the whole pipeline: auth, queueing, Ollama inference, verdict JSON.

set -euo pipefail

BASE_URL="${SHIM_BASE_URL:?set SHIM_BASE_URL, e.g. https://34-10-20-30.sslip.io}"
API_KEY="${SHIM_API_KEY:?set SHIM_API_KEY to the shim bearer key}"
GOAL="${GOAL:-got a flu shot this season}"

echo "== healthz =="
curl -fsS "$BASE_URL/healthz"
echo

if [ -n "${IMAGE_PATH:-}" ]; then
  # base64 without line wraps, portable across GNU (base64 -w0) and BSD/macOS.
  IMAGE_B64="$(base64 < "$IMAGE_PATH" | tr -d '\n')"
  FILENAME="$(basename "$IMAGE_PATH")"
else
  # 1x1 PNG, all-black.
  IMAGE_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  FILENAME="smoke-1x1.png"
fi

BODY="$(python3 - "$FILENAME" "$IMAGE_B64" "$GOAL" <<'PYEOF'
import json, sys
filename, image_b64, goal = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "model": "gemma4",
    "system_prompt": (
        "You are a health verification analyst. You review one or more uploaded "
        "health documents and decide whether they satisfy a stated health goal. "
        "Judge strictly from the documents' contents. If a document is "
        "unreadable, off-topic, or does not clearly satisfy the goal, do not "
        "verify it."
    ),
    "prompt": (
        "Based on the attached document(s), did this person satisfy this goal: "
        f"'{goal}'? Respond ONLY with strict JSON, no prose: "
        '{"verified": boolean, "confidence": "low"|"medium"|"high", "reason": string}'
    ),
    "resources": [{
        "filename": filename,
        "content_type": "image/png",
        "content_base64": image_b64,
    }],
}))
PYEOF
)"

echo "== submit =="
SUBMIT="$(curl -fsS -X POST "$BASE_URL/v1/inference" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  --data "$BODY")"
echo "$SUBMIT"

JOB_ID="$(printf '%s' "$SUBMIT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"

echo "== poll $JOB_ID =="
for _ in $(seq 1 120); do
  RESULT="$(curl -fsS "$BASE_URL/v1/inference/$JOB_ID" \
    -H "authorization: Bearer $API_KEY")"
  STATUS="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
  echo "status: $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "== verdict =="
    printf '%s' "$RESULT" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("output") or r.get("error") or r)'
    if [ "$STATUS" = "completed" ]; then
      exit 0
    fi
    exit 1
  fi
  sleep 5
done

echo "timed out waiting for the verdict" >&2
exit 1
