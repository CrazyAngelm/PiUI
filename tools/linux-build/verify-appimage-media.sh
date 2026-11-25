#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "Expected exactly one executable AppImage." >&2
  exit 1
fi

# Read the SquashFS index without mounting, extracting, or starting the application.
offset="$("$1" --appimage-offset)"
listing="$(unsquashfs -l -offset "$offset" "$1")"

plugins=usr/lib/gstreamer-1.0
required=(
  apprun-hooks/linuxdeploy-plugin-gstreamer.sh
  usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner
  "$plugins/libgstapp.so" # appsink and appsrc
  "$plugins/libgstcoreelements.so"
  "$plugins/libgstaudioconvert.so"
  "$plugins/libgstaudioresample.so"
  "$plugins/libgstpulseaudio.so" # Ubuntu 22.04 plugins-good provides pulsesrc
  "$plugins/libgstalsa.so"
)
for path in "${required[@]}"; do
  if ! grep -Fxq "squashfs-root/$path" <<< "$listing"; then
    echo "Missing AppImage microphone component: $path" >&2
    exit 1
  fi
done
echo "AppImage contains the GStreamer microphone plugins and scanner."
