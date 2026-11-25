#!/bin/zsh
# Monta l'app Mac di prova senza la CLI di Tauri. Uso: make-app.sh cartella-di-uscita file-node [prova]
# Il file node deve essere quello ufficiale (non di Homebrew, che dipende da altre librerie).
set -e
cd "${0:A:h}/.."
APP="$1/Duetto Prototipo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app/src-tauri" "$APP/Contents/Resources/app/node_modules"
cp src-tauri/target/release/duetto-tauri "$APP/Contents/MacOS/"
R="$APP/Contents/Resources/app"
cp -R server public package.json "$R/"
[ "$3" = prova ] && mkdir "$R/test" && cp test/mock-services.js "$R/test/"
if lipo -archs "$2" | grep -q " "; then lipo "$2" -thin "$(uname -m)" -output "$APP/Contents/MacOS/duetto-node"; else cp "$2" "$APP/Contents/MacOS/duetto-node"; fi
cp LICENSE "$APP/Contents/Resources/LICENSE.duetto.txt"
cp THIRD-PARTY-NOTICES.md PRIVACY.md PRIVACY.it.md "$APP/Contents/Resources/"
cp -R node_modules/ws "$R/node_modules/"
cp src-tauri/node-host.mjs "$R/src-tauri/"
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
codesign --force -s - --options runtime --entitlements build/entitlements.mac.plist "$APP/Contents/MacOS/duetto-node"
codesign --force -s - --options runtime --entitlements build/entitlements.mac.plist "$APP"
