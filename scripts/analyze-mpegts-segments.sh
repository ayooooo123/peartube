#!/bin/bash
# Analyze MPEGTS segments around the Chromecast stall point

echo "=== MPEGTS Segment Analysis ==="
echo ""

# Check for segments
SEGMENTS=$(ls -1 /tmp/peartube-debug-segment*.ts 2>/dev/null | sort -V)
if [ -z "$SEGMENTS" ]; then
  echo "No debug segments found in /tmp/"
  echo "Run the app, cast a video to Chromecast, wait for it to play past ~50s"
  echo "The segments 25-40 will be saved to /tmp/peartube-debug-segment*.ts"
  exit 1
fi

echo "Found segments:"
ls -la /tmp/peartube-debug-segment*.ts
echo ""

# Analyze PTS continuity across segment boundary
echo "=== PTS Analysis at Segment Boundaries ==="
for seg in 27 28 37 38; do
  file="/tmp/peartube-debug-segment${seg}.ts"
  if [ -f "$file" ]; then
    echo ""
    echo "--- Segment $seg ---"
    echo "File size: $(ls -la "$file" | awk '{print $5}') bytes"
    
    # Get first and last PTS
    echo "First 5 video packets:"
    ffprobe -v quiet -select_streams v -show_packets -show_entries packet=pts,dts,pts_time,dts_time,flags "$file" 2>/dev/null | head -30
    
    echo ""
    echo "Last 5 video packets:"
    ffprobe -v quiet -select_streams v -show_packets -show_entries packet=pts,dts,pts_time,dts_time,flags "$file" 2>/dev/null | tail -30
  fi
done

echo ""
echo "=== Continuity Counter Analysis ==="
echo "Analyzing first 20 MPEGTS packets of each segment..."
for seg in 27 28 37 38; do
  file="/tmp/peartube-debug-segment${seg}.ts"
  if [ -f "$file" ]; then
    echo ""
    echo "--- Segment $seg first packets ---"
    # Extract first 20 * 188 = 3760 bytes and analyze
    xxd -l 3760 "$file" | head -50
  fi
done

echo ""
echo "=== Quick ffprobe format info ==="
for seg in 27 28 37 38; do
  file="/tmp/peartube-debug-segment${seg}.ts"
  if [ -f "$file" ]; then
    echo ""
    echo "--- Segment $seg ---"
    ffprobe -v error -show_format "$file" 2>&1 | grep -E "duration|start_time|bit_rate"
    ffprobe -v error -show_streams "$file" 2>&1 | grep -E "codec|width|height|sample_rate|channels" | head -10
  fi
done
