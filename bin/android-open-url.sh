#!/bin/sh
# Android native URL launcher shim for PRoot / Termux environments.
# Launches URLs in the Android host system browser via Android Activity Manager.
URL="$1"
if [ -z "$URL" ]; then
  exit 1
fi

if [ -x "/system/bin/am" ]; then
  /system/bin/am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1
elif command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
fi
