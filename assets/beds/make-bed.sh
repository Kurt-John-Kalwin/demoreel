#!/usr/bin/env bash
#
# Synthesises the "calm" music bed from scratch with ffmpeg. Original tones, so there is no
# licence attached to it and no third-party track to clear before posting a film.
#
# It is a slow four-chord pad — Am, F, C, G — built from stacked sine partials, softened with a
# low-pass, given a little movement with a slow tremolo and some room with an echo pair. It is
# meant to be *felt*, not listened to: at the default -26 dB under narration it reads as air in
# the room rather than as a track.
#
#   ./make-bed.sh [out.wav]
#
set -euo pipefail
FF="$(cd "$(dirname "$0")/../.." && pwd)/node_modules/ffmpeg-static/ffmpeg"
OUT="${1:-$(dirname "$0")/calm.wav}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHORD_SECS=16
FADE=3

# Four voicings. Low notes kept sparse so the bed never muddies a voice sitting on top of it.
chords=(
  "110.00 164.81 220.00 261.63"   # Am  A2 E3 A3 C4
  "87.31  130.81 174.61 220.00"   # F   F2 C3 F3 A3
  "130.81 196.00 261.63 329.63"   # C   C3 G3 C4 E4
  "98.00  146.83 196.00 246.94"   # G   G2 D3 G3 B3
)

i=0
for freqs in "${chords[@]}"; do
  args=(); mix=""; n=0
  for f in $freqs; do
    args+=(-f lavfi -i "sine=frequency=$f:duration=$CHORD_SECS:sample_rate=48000")
    mix="$mix[$n:a]"; n=$((n + 1))
  done
  "$FF" -nostdin -loglevel error "${args[@]}" -filter_complex \
    "${mix}amix=inputs=$n:normalize=1,\
     tremolo=f=0.18:d=0.22,\
     lowpass=f=1300,\
     aecho=0.8:0.85:230|410:0.30|0.18,\
     afade=t=in:st=0:d=$FADE,afade=t=out:st=$((CHORD_SECS - FADE)):d=$FADE,\
     aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo" \
    -y "$WORK/c$i.wav"
  i=$((i + 1))
done

# Overlap the chords so one bleeds into the next instead of stopping and starting.
"$FF" -nostdin -loglevel error \
  -i "$WORK/c0.wav" -i "$WORK/c1.wav" -i "$WORK/c2.wav" -i "$WORK/c3.wav" \
  -filter_complex "\
    [0][1]acrossfade=d=$FADE:c1=tri:c2=tri[a01];\
    [a01][2]acrossfade=d=$FADE:c1=tri:c2=tri[a012];\
    [a012][3]acrossfade=d=$FADE:c1=tri:c2=tri,\
    loudnorm=I=-24:TP=-3:LRA=7,\
    aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo[out]" \
  -map "[out]" -y "$OUT"

echo "wrote $OUT"
