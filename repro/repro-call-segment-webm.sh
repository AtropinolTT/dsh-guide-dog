#!/usr/bin/env bash
# RC4 回归（2026-08-17 验收 bug）：call-mode 段 blob 必须含 EBML 头。
#
# 根因：旧实现整通通话一个 MediaRecorder（rec.start(250) 于 startCall），ondataavailable
# 门控 callSegmentActive 把 chunk0（EBML 头 + Segment + Info + Tracks）永远丢弃——chunk0
# 总在首个说话段开始前 ~250ms 到达。段 blob = 无头簇续写 → faster-whisper 内嵌 ffmpeg 报
#   [Errno 1094995529] Invalid data found when processing input: '/tmp/tmpXXXX.webm'
# 修复：每段独立 MediaRecorder（每段 chunk0 自带 EBML 头）→ 段 blob 为完整 webm。
#
# 本脚本用 ffmpeg 模拟 MediaRecorder 250ms timeslice 切块：
#   1) 丢 chunk0 的"无头"形态必须失败（用户实测错误锚点）
#   2) 含头的完整形态必须可解码（修复不变式）
set -u
cd "$(dirname "$0")/.." || exit 1
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

ffmpeg -v error -f lavfi -i "sine=frequency=440:duration=3" -c:a libopus -b:a 32k \
  -f webm -cluster_time_limit 250 -cluster_size_limit 16000 "$W/full.webm" \
  || { echo "FAIL: cannot generate test webm"; exit 1; }

python3 - "$W/full.webm" "$W/header.bin" "$W/rest.bin" <<'EOF'
import sys
data = open(sys.argv[1], 'rb').read()
if data[:4] != bytes.fromhex('1a45dfa3'):
    print('FAIL: generated webm has no EBML magic'); sys.exit(1)
i = data.find(bytes.fromhex('1f43b675'))  # 第一个 Cluster ID = 头 chunk 的终点
if i <= 0:
    print('FAIL: no cluster boundary found'); sys.exit(1)
open(sys.argv[2], 'wb').write(data[:i])   # chunk0：EBML 头 + Segment + Info + Tracks
open(sys.argv[3], 'wb').write(data[i:])   # chunks[1:]：无头簇
EOF
[ -s "$W/header.bin" ] && [ -s "$W/rest.bin" ] || { echo "FAIL: split produced empty parts"; exit 1; }
cat "$W/header.bin" "$W/rest.bin" > "$W/rebuilt.webm"

# 1) 无头形态（旧实现产物）必须报用户实测错误
if ffprobe -v error "$W/rest.bin" 2>&1 | grep -q 'Invalid data found'; then
  echo "PASS: headerless webm fails exactly like the user-reported error"
else
  echo "FAIL: headerless webm did not fail with 'Invalid data found'"
  ffprobe -v error "$W/rest.bin" 2>&1 | head -3
  exit 1
fi

# 2) 完整形态（每段独立 recorder 产物）必须可解码
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1 "$W/rebuilt.webm" 2>&1)
case "$DUR" in
  duration=2.*|duration=3.*) echo "PASS: complete webm decodes (${DUR})" ;;
  *) echo "FAIL: complete webm did not decode (${DUR})"; exit 1 ;;
esac

echo "ALL PASS"
