#!/usr/bin/env bash
# repro/repro-transcribe-concurrency.sh — 并发转写 worker 竞态回归测试
# 修复前（复现 2026-08-17）：4 并发 RPC 中 2 个耗时 64s（60s worker 超时 + fallback）
# 修复后（要求）：全部响应 < 15s（worker 串行化，单次 ~0.2-0.8s）
set -u
BASE=http://127.0.0.1:3080/guide-dog/api/guide-dog
TMP=$(mktemp -d)
python3 - "$TMP" << 'PYEOF'
import sys, wave, io, base64, json
d = sys.argv[1]
buf = io.BytesIO()
w = wave.open(buf, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b'\x00\x00' * 16000); w.close()
b64 = base64.b64encode(buf.getvalue()).decode()
open(d + '/req.json', 'w').write(json.dumps({'audioB64': b64, 'mime': 'audio/wav', 'language': 'zh'}))
PYEOF
FAIL=0
for i in 1 2 3 4; do
  ( curl -s -X POST "$BASE/transcribe" -H 'content-type: application/json' -d @"$TMP/req.json" -o "$TMP/resp-$i.json" -w '%{http_code} %{time_total}' > "$TMP/meta-$i.txt" ) &
done
wait
for i in 1 2 3 4; do
  META=$(cat "$TMP/meta-$i.txt")
  CODE=${META%% *}; TIME=${META##* }
  echo "req$i http=$CODE time=${TIME}s resp=$(head -c 80 "$TMP/resp-$i.json")"
  if [ "$CODE" != "200" ]; then FAIL=1; fi
  python3 - "$TIME" << 'PYEOF' || FAIL=1
import sys
t = float(sys.argv[1])
if t > 15: print(f'FAIL: response took {t:.1f}s (>15s — worker race or timeout)'); sys.exit(1)
PYEOF
done
rm -rf "$TMP"
if [ "$FAIL" = "1" ]; then echo "RESULT: FAIL"; exit 1; fi
echo "RESULT: PASS (all concurrent transcribes fast)"
