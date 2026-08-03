#!/usr/bin/env bash
# Archive, export, and upload the iOS app to App Store Connect.
#
#   scripts/upload-ios-build.sh
#
# Prerequisites (one-time):
#   1. The app record exists in App Store Connect for com.kardanov.agstatus,
#      and Push Notifications is enabled on that App ID.
#   2. An App Store Connect API key with the "App Manager" role:
#        App Store Connect -> Users and Access -> Integrations
#        -> App Store Connect API -> Team Keys -> (+)
#      Download the .p8 ONCE and put it where the tools look for it:
#        mkdir -p ~/.appstoreconnect/private_keys
#        mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
#   3. Export the key identifiers:
#        export ASC_KEY_ID=XXXXXXXXXX          # the AuthKey_<THIS>.p8 part
#        export ASC_ISSUER_ID=aaaaaaaa-bbbb-…  # shown above the key list
#
# Without the API key this still archives and exports; it just stops before
# uploading and tells you the .ipa path so you can drag it into Transporter.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/ios/AgStatus.xcodeproj"
SCHEME="AgStatus"
BUILD_DIR="${BUILD_DIR:-$ROOT/ios/build}"
ARCHIVE="$BUILD_DIR/AgStatus.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"

echo "==> Archiving (Release)"
rm -rf "$ARCHIVE" "$EXPORT_DIR"
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates archive

echo "==> Exporting for App Store Connect"
xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$ROOT/ios/ExportOptions.plist" \
  -exportPath "$EXPORT_DIR" -allowProvisioningUpdates

IPA="$(find "$EXPORT_DIR" -name '*.ipa' -maxdepth 1 | head -1)"
[ -n "$IPA" ] || { echo "No .ipa produced in $EXPORT_DIR" >&2; exit 1; }

echo "==> Exported: $IPA"
# The whole reason aps-environment is a build setting: confirm the profile
# baked into the .ipa really says "production" before it reaches Apple.
unzip -p "$IPA" 'Payload/*.app/embedded.mobileprovision' 2>/dev/null \
  | security cms -D 2>/dev/null \
  | plutil -extract Entitlements.aps-environment raw - 2>/dev/null \
  | sed 's/^/    aps-environment in profile: /' || true

if [ -z "${ASC_KEY_ID:-}" ] || [ -z "${ASC_ISSUER_ID:-}" ]; then
  cat <<EOF

Archive and export succeeded, but ASC_KEY_ID / ASC_ISSUER_ID are not set, so
nothing was uploaded. Either export them and re-run, or upload this file by
hand with Transporter (free, Mac App Store):

  $IPA
EOF
  exit 0
fi

echo "==> Validating with App Store Connect"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "==> Uploading"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo
echo "Uploaded. Processing in App Store Connect usually takes 5-15 minutes;"
echo "the build then appears under TestFlight and in the version's Build section."
