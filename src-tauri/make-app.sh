#!/bin/zsh
# Monta l'app Mac di prova senza la CLI di Tauri. Uso: make-app.sh cartella-di-uscita
set -e
cd "${0:A:h}/.."
APP="$1/Duetto Prototipo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp src-tauri/target/release/duetto-tauri "$APP/Contents/MacOS/"
cp LICENSE "$APP/Contents/Resources/LICENSE.duetto.txt"
cp THIRD-PARTY-NOTICES.md PRIVACY.md PRIVACY.it.md "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>duetto-tauri</string>
<key>CFBundleIdentifier</key><string>com.samuelluggeri.duetto.prototipo</string>
<key>CFBundleName</key><string>Duetto Prototipo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Duetto ascolta l'ingresso audio scelto per trascrivere chi parla.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
codesign --force -s - --options runtime --entitlements build/entitlements.mac.plist "$APP"
