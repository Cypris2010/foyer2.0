#!/bin/sh
# Generates the H.264 test clips for the probe. Moving test pattern + scrolling
# bar so dropped frames are visible; 12 s each, with a 440 Hz AAC tone so the
# autoplay-with-sound test has audio.
set -eu
cd "$(dirname "$0")/../public/clips"

clip() {
  id=$1; size=$2; fps=$3; rate=$4; profile=$5
  [ -f "$id.mp4" ] && { echo "vorhanden: $id"; return; }
  echo "erzeuge: $id"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=$size:rate=$fps,drawbox=x='mod(t*600,iw)':y=0:w=40:h=ih:color=white@0.8:t=fill" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 12 -c:v libx264 -profile:v "$profile" -pix_fmt yuv420p -preset medium \
    -b:v "$rate" -maxrate "$rate" -bufsize "$rate" -g "$((fps * 2))" \
    -c:a aac -b:a 96k -movflags +faststart "$id.mp4"
}

clip 720p30-3M-high    1280x720  30 3M high
clip 1080p30-5M-high   1920x1080 30 5M high
clip 1080p30-8M-high   1920x1080 30 8M high
clip 1080p30-5M-main   1920x1080 30 5M main
clip 1080p60-6M-high   1920x1080 60 6M high
clip 1080p60-10M-high  1920x1080 60 10M high
