#!/bin/zsh
# Monta l'app Mac di prova senza la CLI di Tauri. Uso: make-app.sh cartella-di-uscita
set -e
cd "${0:A:h}/.."
APP="$1/Duetto.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp src-tauri/target/release/duetto-tauri "$APP/Contents/MacOS/Duetto"
cp LICENSE "$APP/Contents/Resources/LICENSE.duetto.txt"
cp THIRD-PARTY-NOTICES.md PRIVACY.md PRIVACY.it.md "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Duetto</string>
<key>CFBundleIdentifier</key><string>com.samuelluggeri.duetto2</string>
<key>CFBundleName</key><string>Duetto</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>VERSIONE</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Duetto ascolta l'ingresso audio scelto per trascrivere chi parla.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
# La versione sta solo in package.json.
plutil -replace CFBundleShortVersionString -string "$(sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)" "$APP/Contents/Info.plist"
codesign --force -s - --options runtime --entitlements build/entitlements.mac.plist "$APP"
