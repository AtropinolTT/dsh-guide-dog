#!/usr/bin/env bash
# repro/repro-stream-busy-429.sh — 流合成并发门（speechStreamBusy）契约回归
# 背景（RC6，2026-08-17 验收）：client 预合成重叠 fetch 会撞 host 每会话 busy 门 →
# 第二个请求立即 429（实测 1.8ms 0 字节）→ '播放中断' + 句子丢失。
# 修复后 client 串行播放（await playStreamEntry），不再重叠；本脚本验证 host 契约仍在
# （并发请求第二个必须 429——client 串行化正是遵守该契约）。
set -u
BASE=http://127.0.0.1:3080/guide-dog/api/guide-dog
STREAM=http://127.0.0.1:3080/guide-dog/tts-stream
SID="rc6-429-repro"
T1=$(curl -s -X POST "$BASE/tts-token" -H 'content-type: application/json' -d "{\"sessionId\":\"$SID\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
T2=$(curl -s -X POST "$BASE/tts-token" -H 'content-type: application/json' -d "{\"sessionId\":\"$SID\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
LONG="这是一个足够长的测试句子，用来让语音合成时间超过一秒，从而触发会话级并发保护，确保第二个并发请求被拒绝，句子长度现在应该已经足够"
curl -s -o /tmp/r1.pcm -w '%{http_code}' -G "$STREAM" --data-urlencode "token=$T1" --data-urlencode "sid=$SID" --data-urlencode "text=$LONG" > /tmp/c1.txt &
sleep 0.3
curl -s -o /tmp/r2.pcm -w '%{http_code}' -G "$STREAM" --data-urlencode "token=$T2" --data-urlencode "sid=$SID" --data-urlencode "text=第二句" > /tmp/c2.txt
wait
C1=$(cat /tmp/c1.txt); C2=$(cat /tmp/c2.txt)
echo "req1(长句)=$C1 req2(重叠)=$C2"
if [ "$C1" = "200" ] && [ "$C2" = "429" ]; then
  echo "PASS: host busy gate holds (client serialization avoids overlap)"
else
  echo "FAIL: expected 200 + 429, got $C1 + $C2"
  exit 1
fi
