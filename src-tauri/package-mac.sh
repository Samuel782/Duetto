#!/bin/zsh
# Crea in dist/ l'app e il DMG per Mac. Uso: package-mac.sh [arm64|x64]  (predefinito: questo Mac)
set -eu
cd "${0:A:h}/.."
ARCH="${1:-$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)}"
TARGET=$([ "$ARCH" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)
VERSION="$(sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)"
export MACOSX_DEPLOYMENT_TARGET=14.0
cargo build --release --locked --features custom-protocol --target "$TARGET" --manifest-path src-tauri/Cargo.toml
node scripts/licenses.mjs

# Una cartella nuova a ogni esecuzione: niente da cancellare prima.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/duetto-mac.XXXXXX")"
APP="$STAGE/Duetto.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "src-tauri/target/$TARGET/release/duetto-tauri" "$APP/Contents/MacOS/Duetto"
cp src-tauri/icons/icon.icns "$APP/Contents/Resources/"
cp LICENSE "$APP/Contents/Resources/LICENSE.duetto.txt"
cp THIRD-PARTY-NOTICES.md PRIVACY.md PRIVACY.it.md dist/LICENSES.rust.txt "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Duetto</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleIdentifier</key><string>com.samuelluggeri.duetto2</string>
<key>CFBundleName</key><string>Duetto</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSApplicationCategoryType</key><string>public.app-category.video</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Duetto ascolta l'ingresso audio scelto per trascrivere chi parla.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
codesign --force -s - --options runtime --entitlements build/entitlements.mac.plist "$APP"
codesign --verify --deep --strict "$APP"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -ov -format ULFO -volname "Duetto $VERSION" -srcfolder "$STAGE" "dist/Duetto-$VERSION-mac-$ARCH.dmg"
echo "dist/Duetto-$VERSION-mac-$ARCH.dmg ($APP)"
