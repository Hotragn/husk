#!/bin/sh
# Wrap the built HuskBar binary in an .app bundle. Run from apps/mac after building:
#   xcodebuild -scheme HuskBar -destination 'platform=macOS' -configuration Release -derivedDataPath .build/xcode build
#   sh scripts/bundle.sh
set -eu
BIN=".build/xcode/Build/Products/Release/HuskBar"
[ -x "$BIN" ] || BIN=".build/release/HuskBar"
[ -x "$BIN" ] || { echo "build HuskBar first (see README.md)" >&2; exit 1; }
APP="build/Husk Bar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/HuskBar"
cp Resources/Info.plist "$APP/Contents/Info.plist"
echo "built $APP"
