#!/bin/sh
# Captures of the live site (dark theme) for the hackathon submission (read-only: public pages, headless Brave, throwaway profile).
# Run from the repo root:  sh docs/submission/shoot.sh
B="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
U="https://cobra-beige.vercel.app"
OUT="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$(mktemp -d)"
# Warm-up run (the first headless start is slow and may time out); its output is discarded.
perl -e 'alarm 45; exec @ARGV' "$B" --headless=new --no-first-run --user-data-dir="$PROFILE" --screenshot=/dev/null "$U/" >/dev/null 2>&1

shot() { # name path size lang scale
  perl -e 'alarm 45; exec @ARGV' "$B" --headless=new --no-first-run --no-default-browser-check --hide-scrollbars \
    --user-data-dir="$PROFILE" --force-dark-mode --blink-settings=preferredColorScheme=0 --lang="$4" --accept-lang="$4" --force-device-scale-factor="$5" \
    --window-size="$3" --virtual-time-budget=12000 --screenshot="$OUT/$1.png" "$U$2" >/dev/null 2>&1
  if [ -s "$OUT/$1.png" ]; then echo "ok   $1"; else echo "FAIL $1"; fi
}

shot 01-landing-desktop-es  /       1440,1000 es-AR 1
shot 02-landing-desktop-en  /       1440,1000 en-US 1
shot 03-landing-full-es     /       1440,4600 es-AR 1
shot 04-landing-mobile-es   /       500,1000  es-AR 2
shot 05-landing-mobile-pt   /       500,1000  pt-BR 2
shot 06-proof-desktop-en    /proof  1440,1100 en-US 1
shot 07-proof-full-en       /proof  1440,2400 en-US 1
shot 08-proof-mobile-es     /proof  500,1000  es-AR 2
shot 09-demo-desktop-en     /demo   1440,1000 en-US 1
shot 10-demo-mobile-es      /demo   500,1000  es-AR 2
shot 11-demo-mobile-pt      /demo   500,1000  pt-BR 2

rm -rf "$PROFILE"
ls -la "$OUT"/*.png 2>/dev/null
